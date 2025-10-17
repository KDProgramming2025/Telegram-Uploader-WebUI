import path from 'path';
import fs from 'fs';
import { sendSse, throttledProgress } from './sse';
import { jobs, Job, saveJobsToDisk, hasJob } from './jobs';
import { client, Api, isClientReady, setClientReady, hasSavedSession } from './telegram';
import { isCancelled } from './queue';
import { TARGET_CHATID } from './config';

export async function performTelegramUpload(job: Job, absPath: string) {
  const jobId = job.id;
  const size = fs.existsSync(absPath) ? fs.statSync(absPath).size : 0;
  // Ensure client
  if (!isClientReady()) {
    try {
      if (hasSavedSession()) {
        await client.connect();
        setClientReady(true);
      }
    } catch (e) {
      console.warn('client connect failed for upload');
    }
  }
  if (!isClientReady()) {
    job.status = 'error'; job.message = 'User client not connected'; jobs.set(jobId, job);
    sendSse(jobId, 'error', { message: job.message });
    return;
  }
  // Real-time progress using client's progress callback; with a gentle fallback
  let fallbackTimer: NodeJS.Timeout | null = null;
  let lastEventTs = 0;
  let lastPct = 0;
  const startProgress = () => {
    sendSse(jobId, 'uploadStart', { method: 'user' });
    lastEventTs = Date.now();
    // Fallback nudge if no callbacks received (keeps UI alive but capped to 95%)
    fallbackTimer = setInterval(() => {
      const now = Date.now();
      if (now - lastEventTs > 2000 && lastPct < 95) {
        lastPct = Math.min(95, lastPct + 1);
        throttledProgress(jobId, 'upload', { percent: lastPct });
      }
    }, 1200);
  };
  const stopProgress = () => { if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; } };
  const handleProgress = (...args: any[]) => {
    lastEventTs = Date.now();
    let uploaded = 0;
    let total = size || 0;
    if (args.length >= 2) {
      uploaded = Number(args[0]) || 0;
      total = Number(args[1]) || total;
    } else if (args.length === 1) {
      const a = args[0];
      if (typeof a === 'number') {
        if (a <= 1) uploaded = Math.round(a * (total || size || 1)); else uploaded = Math.round(a);
      } else if (a && typeof a === 'object') {
        uploaded = Number((a.loaded ?? a.current) || 0);
        total = Number((a.total ?? total) || total);
      }
    }
    if (total > 0) {
      const pct = Math.min(99, Math.max(0, Math.round((uploaded / total) * 100)));
      lastPct = pct;
      throttledProgress(jobId, 'upload', { percent: pct, received: uploaded, total });
    } else {
      throttledProgress(jobId, 'upload', { received: uploaded, total: null });
    }
  };

  try {
  if (!hasJob(jobId) || isCancelled(jobId)) return;
  job.status = 'uploading'; if (hasJob(jobId)) { jobs.set(jobId, job); sendSse(jobId, 'status', { status: job.status }); }
  startProgress();
    let attributes: any[] | undefined = undefined;
    try {
      const { execSync } = require('child_process');
      const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration -of json "${absPath}"`;
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
    } catch {}

  // Build a caption from requestedName or filename without extension
  const ext = path.extname(absPath);
  const extLower = ext.toLowerCase();
  const baseNoExt = path.basename(absPath, ext);
  const captionText = (job.requestedName && String(job.requestedName).trim()) || baseNoExt || undefined;

  // If the container is MKV, force upload as document (not as video)
  if (extLower === '.mkv') {
    attributes = undefined;
  }

  const sendOpts: any = attributes ? { file: absPath, attributes } : { file: absPath };
  if (extLower === '.mkv') {
    (sendOpts as any).forceDocument = true;
  }
  if (captionText) sendOpts.caption = captionText;
    // GramJS supports progressCallback; handle various callback signatures in handleProgress
    (sendOpts as any).progressCallback = (...args: any[]) => handleProgress(...args);
  if (!hasJob(jobId) || isCancelled(jobId)) { stopProgress(); return; }
  await (client as any).sendFile(TARGET_CHATID!, sendOpts);
  if (!hasJob(jobId) || isCancelled(jobId)) { stopProgress(); return; }
    stopProgress();
    job.percent = 100; job.status = 'done'; if (hasJob(jobId)) { jobs.set(jobId, job); throttledProgress(jobId, 'upload', { percent: 100 }); sendSse(jobId, 'uploadComplete', { method: 'user' }); saveJobsToDisk(); sendSse(jobId, 'done', { success: true }); }
  } catch (e) {
    stopProgress();
    if (!hasJob(jobId)) return;
    if (String(e).includes('Cancelled')) { job.status = 'cancelled'; } else { job.status = 'error'; }
    job.message = String(e); if (hasJob(jobId)) { jobs.set(jobId, job); saveJobsToDisk(); sendSse(jobId, 'error', { message: String(e) }); }
  }
}
