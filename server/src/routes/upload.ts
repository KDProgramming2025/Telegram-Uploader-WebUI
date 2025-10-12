import express from 'express';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { sendSse, throttledProgress } from '../sse';
import { jobs, Job, saveJobsToDisk } from '../jobs';
import { TARGET_CHATID, UI_USERNAME, UI_PASSWORD } from '../config';
import { client, Api, isClientReady, setClientReady, hasSavedSession } from '../telegram';
import { pipeline } from 'stream/promises';
import { spawn } from 'child_process';

export function registerUploadRoutes(app: express.Express) {
  const handler = async (req: express.Request, res: express.Response) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const { username, password, fileUrl } = (req.body || {}) as any;
    let requestedName: string | undefined = (req.body && (req.body as any).fileName) ? String((req.body as any).fileName) : undefined;
    if (username !== UI_USERNAME || password !== UI_PASSWORD) {
      return res.status(401).send('Unauthorized');
    }
    if (!fileUrl) return res.status(400).send('No fileUrl provided');
    const saveToDl = !!(req as any).body.saveToDl;
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    // sanitize requestedName to safe filesystem base name (strip extension and illegal characters)
    const sanitizeBase = (name: string) => {
      const noPath = name.replace(/\\|\//g, ' ').trim();
      const base = noPath.replace(/\.[^.]+$/,'');
      const cleaned = base.replace(/[^A-Za-z0-9._ -]+/g, '').trim();
      return cleaned || undefined;
    };
    requestedName = requestedName ? sanitizeBase(requestedName) : undefined;
    const job: Job = { id: jobId, fileUrl, status: 'queued', createdAt: Date.now(), tmpPath: undefined, requestedName } as any;
    (job as any).type = saveToDl ? 'download' : 'upload';
    jobs.set(jobId, job);
    saveJobsToDisk();
    res.json({ jobId, type: (job as any).type });

    (async () => {
      const tmpDir = saveToDl ? '/var/www/dl' : path.join(__dirname, '../../tmp');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      // Identify if the URL points to an HLS playlist; if so, we'll fetch the actual video via ffmpeg
      const urlPathName = decodeURIComponent(new URL(fileUrl).pathname || '');
      const urlExt = path.extname(urlPathName).toLowerCase();
      const isHls = urlExt === '.m3u8';
      // If HLS, probe the stream to determine codecs and a suitable container
      let hlsChosenExt: string | null = null;
      let hlsDurationSec: number | null = null;
      if (isHls) {
        try {
          const { execSync } = require('child_process');
          const probeCmd = `ffprobe -v error -print_format json -show_format -show_streams "${fileUrl}"`;
          const probeOut = execSync(probeCmd, { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
          const p = JSON.parse(probeOut);
          const streams = Array.isArray(p.streams) ? p.streams : [];
          const v = streams.find((s: any) => s.codec_type === 'video');
          const a = streams.find((s: any) => s.codec_type === 'audio');
          const vCodec = (v && (v.codec_name || v.codec_tag_string)) ? String(v.codec_name || v.codec_tag_string).toLowerCase() : '';
          const aCodec = (a && (a.codec_name || a.codec_tag_string)) ? String(a.codec_name || a.codec_tag_string).toLowerCase() : '';
          const dur = Number((p.format && p.format.duration) || 0);
          if (dur && isFinite(dur) && dur > 0) hlsDurationSec = Math.round(dur);
          // Choose container: prefer mp4 for h264/hevc + aac; webm for vp8/vp9 + vorbis/opus; otherwise ts
          if ((vCodec === 'h264' || vCodec === 'hevc' || vCodec === 'h265') && (!aCodec || aCodec.includes('aac') || aCodec === 'mp4a')) {
            hlsChosenExt = '.mp4';
          } else if ((vCodec === 'vp8' || vCodec === 'vp9') && (aCodec === 'vorbis' || aCodec === 'opus')) {
            hlsChosenExt = '.webm';
          } else {
            hlsChosenExt = '.ts';
          }
        } catch (e) {
          // If probing fails, default to TS which is broadly compatible for HLS
          hlsChosenExt = '.ts';
        }
      }
      let fileName: string;
      if (saveToDl) {
        const urlPath = urlPathName;
        const baseNameRaw = path.basename(urlPath) || `download_${Date.now()}`;
        const origExt = path.extname(baseNameRaw);
        const nameOnly = origExt ? path.basename(baseNameRaw, origExt) : baseNameRaw;
        const destExt = isHls ? (hlsChosenExt || '.ts') : (origExt || '');
        const baseFromReq = requestedName || undefined;
        let base = (baseFromReq && baseFromReq.length > 0 ? baseFromReq : nameOnly);
        let candidate = `${base}${destExt}`;
        let i = 1;
        while (fs.existsSync(path.join(tmpDir, candidate))) {
          candidate = `${base}(${i})${destExt}`;
          i++;
        }
        fileName = candidate;
      } else {
        const destExt = isHls ? (hlsChosenExt || '.ts') : urlExt;
        const baseFromReq = requestedName || undefined;
        let base = (baseFromReq && baseFromReq.length > 0 ? baseFromReq : `upload_${Date.now()}`);
        let candidate = `${base}${destExt}`;
        let i = 1;
        while (fs.existsSync(path.join(tmpDir, candidate))) {
          candidate = `${base}(${i})${destExt}`;
          i++;
        }
        fileName = candidate;
      }
      const tmpPath = path.join(tmpDir, fileName);
      try {
        const startTs = Date.now();
        job.status = 'downloading'; jobs.set(jobId, job); sendSse(jobId, 'status', { status: job.status });

        if (isHls) {
          sendSse(jobId, 'downloadStart', { method: 'hls' });
          // Use ffmpeg to download and remux HLS into a single file without re-encoding
          const args: string[] = [
            '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-y',
            '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
            '-i', fileUrl,
            '-c', 'copy'
          ];
          if ((hlsChosenExt || '.ts') === '.mp4') {
            args.push('-bsf:a','aac_adtstoasc','-movflags','+faststart');
          }
          // Emit progress key-value pairs on stdout
          args.push('-progress','pipe:1');
          args.push(tmpPath);

          let lastSize = 0;
          let lastSizeTs = Date.now();
          const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
          // Kick progress so UI shows movement immediately
          throttledProgress(jobId, 'download', { percent: 1 });
          const sizeTimer = setInterval(() => {
            try {
              if (fs.existsSync(tmpPath)) {
                const st = fs.statSync(tmpPath);
                if (st.size > lastSize) {
                  lastSize = st.size;
                  lastSizeTs = Date.now();
                  // When duration is unknown, provide byte-based progress updates
                  if (!hlsDurationSec) {
                    throttledProgress(jobId, 'download', { received: lastSize, total: null });
                  }
                }
                // If no growth for 60s, consider stalled
                if (Date.now() - lastSizeTs > 60000) {
                  try { ff.kill('SIGKILL'); } catch {}
                }
              }
            } catch {}
          }, 1200);

          const progressHandler = (buf: Buffer) => {
            const text = buf.toString('utf8');
            const lines = text.split(/\r?\n/);
            let outMs: number | null = null;
            let totalSize: number | null = null;
            for (const ln of lines) {
              const [k, v] = ln.split('=');
              if (k === 'out_time_ms') {
                const ms = Number(v);
                if (!isNaN(ms)) outMs = ms;
              } else if (k === 'total_size') {
                const sz = Number(v);
                if (!isNaN(sz)) totalSize = sz;
              }
            }
            if (hlsDurationSec && outMs !== null) {
              const pct = Math.min(99, Math.max(0, Math.round((outMs / (hlsDurationSec * 1000000)) * 100)));
              throttledProgress(jobId, 'download', { percent: pct });
            } else if (totalSize !== null) {
              throttledProgress(jobId, 'download', { received: totalSize, total: null });
            }
          };
          ff.stdout.on('data', progressHandler);
          // Capture errors to help debugging
          ff.stderr.on('data', (d: Buffer) => {
            // Optionally, could forward some error lines
          });

          await new Promise<void>((resolve, reject) => {
            ff.on('error', (err) => {
              clearInterval(sizeTimer);
              reject(err);
            });
            ff.on('close', (code) => {
              clearInterval(sizeTimer);
              if (code === 0) resolve(); else reject(new Error(`ffmpeg exited with code ${code}`));
            });
          });
        } else {
          sendSse(jobId, 'downloadStart', { method: 'http' });
          const response = await axios.get(fileUrl, { responseType: 'stream', maxRedirects: 5, timeout: 0 });
          const total = Number(response.headers['content-length'] || 0);
          let received = 0;
          const writeStream = fs.createWriteStream(tmpPath);
          response.data.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (total) {
              throttledProgress(jobId, 'download', { received, total, percent: Math.round((received/total)*100) });
            } else {
              throttledProgress(jobId, 'download', { received, total: null });
            }
          });
          await pipeline(response.data, writeStream);
        }
  const endTs = Date.now();
        const size = fs.statSync(tmpPath).size;
        const downloadMs = Math.max(1, endTs - startTs);
        const downloadBps = Math.round(size / (downloadMs / 1000));
  // Ensure UI sees completion of download phase
  throttledProgress(jobId, 'download', { percent: 100 });
        job.status = 'downloaded'; job.tmpPath = tmpPath; job.percent = 100; jobs.set(jobId, job);
  sendSse(jobId, 'status', { status: job.status });
        sendSse(jobId, 'downloadComplete', { path: tmpPath, size, downloadMs, downloadBps });
        saveJobsToDisk();

  const videoExts = ['.mp4', '.mkv', '.mov', '.webm', '.avi', '.flv', '.wmv', '.m4v', '.ts'];
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
  };
  app.post('/upload', handler);
  app.post('/uploader/upload', handler);
}
