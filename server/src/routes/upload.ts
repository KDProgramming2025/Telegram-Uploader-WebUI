import express from 'express';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { sendSse, throttledProgress } from '../sse';
import { jobs, Job, saveJobsToDisk } from '../jobs';
import { TARGET_CHATID, UI_USERNAME, UI_PASSWORD } from '../config';
import { client, Api, isClientReady, setClientReady, hasSavedSession } from '../telegram';
import { pipeline } from 'stream/promises';

export function registerUploadRoutes(app: express.Express) {
  app.post('/upload', async (req: express.Request, res: express.Response) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const { username, password, fileUrl } = (req.body || {}) as any;
    if (username !== UI_USERNAME || password !== UI_PASSWORD) {
      return res.status(401).send('Unauthorized');
    }
    if (!fileUrl) return res.status(400).send('No fileUrl provided');
    const saveToDl = !!(req as any).body.saveToDl;
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    const job: Job = { id: jobId, fileUrl, status: 'queued', createdAt: Date.now(), tmpPath: undefined } as any;
    (job as any).type = saveToDl ? 'download' : 'upload';
    jobs.set(jobId, job);
    saveJobsToDisk();
    res.json({ jobId, type: (job as any).type });

    (async () => {
      const tmpDir = saveToDl ? '/var/www/dl' : path.join(__dirname, '../../tmp');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      let fileName: string;
      if (saveToDl) {
        const urlPath = decodeURIComponent(new URL(fileUrl).pathname || '');
        let baseName = path.basename(urlPath) || `download_${Date.now()}`;
        const ext = path.extname(baseName);
        const nameOnly = path.basename(baseName, ext);
        let candidate = baseName;
        let i = 1;
        while (fs.existsSync(path.join(tmpDir, candidate))) {
          candidate = `${nameOnly}(${i})${ext}`;
          i++;
        }
        fileName = candidate;
      } else {
        fileName = `upload_${Date.now()}` + path.extname(new URL(fileUrl).pathname);
      }
      const tmpPath = path.join(tmpDir, fileName);
      try {
        const startTs = Date.now();
        const response = await axios.get(fileUrl, { responseType: 'stream', maxRedirects: 5, timeout: 0 });
        const total = Number(response.headers['content-length'] || 0);
        let received = 0;
        const writeStream = fs.createWriteStream(tmpPath);
        job.status = 'downloading'; jobs.set(jobId, job); sendSse(jobId, 'status', { status: job.status });
        response.data.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (total) {
            throttledProgress(jobId, 'download', { received, total, percent: Math.round((received/total)*100) });
          } else {
            throttledProgress(jobId, 'download', { received, total: null });
          }
        });
        await pipeline(response.data, writeStream);
        const endTs = Date.now();
        const size = fs.statSync(tmpPath).size;
        const downloadMs = Math.max(1, endTs - startTs);
        const downloadBps = Math.round(size / (downloadMs / 1000));
        job.status = 'downloaded'; job.tmpPath = tmpPath; job.percent = 100; jobs.set(jobId, job);
        sendSse(jobId, 'downloadComplete', { path: tmpPath, size, downloadMs, downloadBps });
        saveJobsToDisk();

        const videoExts = ['.mp4', '.mkv', '.mov', '.webm', '.avi', '.flv', '.wmv', '.m4v'];
        const ext = path.extname(tmpPath).toLowerCase();
        const isVideo = videoExts.includes(ext);

        if (saveToDl) {
          job.status = 'done'; job.percent = 100; jobs.set(jobId, job);
          // Use a domain-independent relative URL so the client resolves against window.location.origin
          const publicUrl = '/dl/' + encodeURIComponent(path.basename(tmpPath));
          sendSse(jobId, 'downloadSaved', { path: tmpPath, size, publicUrl });
          saveJobsToDisk();
          sendSse(jobId, 'done', { success: true });
          return;
        }

        if (!isClientReady()) {
          try {
            if (hasSavedSession()) {
              await client.connect();
              setClientReady(true);
            }
          } catch (e) {
            console.warn('client connect failed, will use bot token if available');
          }
        }

        const estUploadBps = Math.max(downloadBps, 50 * 1024);
        const estUploadMs = Math.max(1000, Math.round((size / estUploadBps) * 1000));
        let uploadTimer: NodeJS.Timeout | null = null;
        let uploadStartTs = Date.now();
        const startProgressEmitter = (method: string) => {
          sendSse(jobId, 'uploadStart', { method });
          uploadStartTs = Date.now();
          let elapsed = 0;
          uploadTimer = setInterval(() => {
            elapsed = Date.now() - uploadStartTs;
            const pct = Math.min(99, Math.round((elapsed / estUploadMs) * 100));
            throttledProgress(jobId, 'upload', { percent: pct, elapsed });
          }, 1200);
        };
        const stopProgressEmitter = () => { if (uploadTimer) { clearInterval(uploadTimer); uploadTimer = null; } };

        if (isClientReady()) {
          job.status = 'uploading'; jobs.set(jobId, job); sendSse(jobId, 'status', { status: job.status });
          startProgressEmitter('user');
          let attributes: any[] | undefined = undefined;
          try {
            const { execSync } = require('child_process');
            const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration -of json "${tmpPath}"`;
            const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
            const parsed = JSON.parse(out);
            const stream = (parsed.streams && parsed.streams[0]) || null;
            if (stream) {
              const duration = Math.round(Number(stream.duration || 0));
              const w = Number(stream.width || 0);
              const h = Number(stream.height || 0);
              if (duration && w && h) {
                attributes = [ new Api.DocumentAttributeVideo({ duration, w, h, supportsStreaming: true }) ];
              }
            }
          } catch (probeErr: any) {
            console.warn('ffprobe failed or not installed, sending without video attributes', probeErr && probeErr.message ? probeErr.message : String(probeErr));
          }

          if (attributes) {
            await client.sendFile(TARGET_CHATID!, { file: tmpPath, attributes });
          } else {
            await client.sendFile(TARGET_CHATID!, { file: tmpPath });
          }
          stopProgressEmitter();
          job.percent = 100; job.status = 'done'; jobs.set(jobId, job);
          throttledProgress(jobId, 'upload', { percent: 100 });
          sendSse(jobId, 'uploadComplete', { method: 'user' });
          saveJobsToDisk();
        } else {
          job.status = 'error'; job.message = 'User client not connected and bot fallback disabled'; jobs.set(jobId, job);
          sendSse(jobId, 'error', { message: job.message });
          return;
        }

        try {
          if (!saveToDl) {
            try {
              const DL_DIR = path.resolve('/var/www/dl');
              const resolved = path.resolve(tmpPath);
              const inside = resolved === DL_DIR || resolved.startsWith(DL_DIR + path.sep);
              console.log(`CLEANUP job ${jobId}: tmpPath=${resolved}, insideDL=${inside}`);
              if (!inside && fs.existsSync(resolved)) {
                console.log(`CLEANUP job ${jobId}: unlinking ${resolved}`);
                fs.unlinkSync(resolved);
              } else {
                console.log(`CLEANUP job ${jobId}: skipping unlink for ${resolved}`);
              }
            } catch (e) {}
          }
        } catch (e) {}
        job.status = 'done'; job.percent = 100; jobs.set(jobId, job);
        saveJobsToDisk();
        sendSse(jobId, 'done', { success: true });
      } catch (err) {
        try {
          if (!saveToDl) {
            try {
              const DL_DIR = path.resolve('/var/www/dl');
              const resolved = path.resolve(tmpPath);
              const inside = resolved === DL_DIR || resolved.startsWith(DL_DIR + path.sep);
              console.log(`ERROR-CLEANUP job ${jobId}: tmpPath=${resolved}, insideDL=${inside}`);
              if (!inside && fs.existsSync(resolved)) {
                console.log(`ERROR-CLEANUP job ${jobId}: unlinking ${resolved}`);
                fs.unlinkSync(resolved);
              } else {
                console.log(`ERROR-CLEANUP job ${jobId}: skipping unlink for ${resolved}`);
              }
            } catch (e) {}
          }
        } catch (e) {}
        console.error('Background upload error', err);
        job.status = 'error'; job.message = String(err); jobs.set(jobId, job);
        saveJobsToDisk();
        sendSse(jobId, 'error', { message: String(err) });
      }
    })();
  });
}
