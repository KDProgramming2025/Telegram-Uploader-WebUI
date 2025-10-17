import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { PORT, UI_USERNAME, UI_PASSWORD } from './config';
import { registerMetubeRoutes } from './routes/metube';
import { registerSystemRoutes } from './routes/system';
import { registerDlRoutes } from './routes/dl';
import { registerEventRoutes } from './routes/events';
import { registerAuthRoutes } from './routes/auth';
import { registerUploadRoutes } from './routes/upload';
import { jobs, saveJobsToDisk, loadJobsFromDisk } from './jobs';
import { cancelQueued, getActiveJobId, setCancelled, cancelAll } from './queue';
import { sseClients } from './sse';

const app = express();
app.use(cors());

app.use(express.static(path.join(__dirname, '../../')));
app.use(express.json({ limit: '50mb' }));

// Register metube routes BEFORE no-cache middleware to mirror original order
registerMetubeRoutes(app);

// Global no-cache for API (non-static) endpoints
app.use((req, res, next) => {
  const p = req.path;
  if (
    p.startsWith('/uploader/') ||
    p.startsWith('/dl/') ||
    p.startsWith('/jobs') ||
    p.startsWith('/events') ||
    p.startsWith('/auth') ||
    p === '/upload' ||
    p.startsWith('/system/')
  ) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  next();
});

// load persisted jobs on startup
loadJobsFromDisk();
// sanitize jobs: if a job is in uploading/downloading but no process is active, revert to queued or error as appropriate
(function sanitizeJobs() {
  try {
    const active = getActiveJobId();
    const arr = Array.from(jobs.values());
    for (const j of arr) {
      if (j.status === 'uploading' || j.status === 'downloading') {
        if (active !== j.id) {
          // if it was a remote download job but tmpPath missing, mark error; for upload, set queued so queue can pick later if re-enqueued
          if (j.status === 'downloading') {
            j.status = 'error';
            j.message = 'Server restarted during download';
          } else if (j.status === 'uploading') {
            j.status = 'queued';
          }
          jobs.set(j.id, j);
        }
      }
    }
    saveJobsToDisk();
  } catch {}
})();

// Jobs endpoints
function jobsListHandler(req: express.Request, res: express.Response) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const list = Array.from(jobs.values()).sort((a,b) => b.createdAt - a.createdAt);
  res.json(list);
}
app.get('/jobs', jobsListHandler);
app.get('/uploader/jobs', jobsListHandler);

function jobsDeleteHandler(req: express.Request, res: express.Response) {
  const { id } = req.params;
  const job = jobs.get(id);
  if (!job) return res.status(404).send('no such job');
  if (job.status === 'downloading' || job.status === 'uploading') {
    // Cancel any queued work and signal active worker to stop, then proceed to remove
    cancelQueued(id);
    try { setCancelled(id); } catch {}
  }
  try {
    const DL_DIR = path.resolve('/var/www/dl');
    if (job.tmpPath && fs.existsSync(job.tmpPath)) {
      const resolved = path.resolve(job.tmpPath);
      const inside = resolved === DL_DIR || resolved.startsWith(DL_DIR + path.sep);
      console.log(`DELETE job ${id}: tmpPath=${resolved}, insideDL=${inside}`);
      if (!inside) {
        console.log(`DELETE job ${id}: unlinking ${resolved}`);
        fs.unlinkSync(resolved);
      } else {
        console.log(`DELETE job ${id}: skipping unlink for ${resolved} (inside /var/www/dl)`);
      }
    }
  } catch (e) {}
  jobs.delete(id);
  saveJobsToDisk();
  sseClients.delete(id);
  res.send('deleted');
}
app.delete('/jobs/:id', jobsDeleteHandler);
app.delete('/uploader/jobs/:id', jobsDeleteHandler);

// Cancel a job (queued or active)
app.post('/uploader/jobs/:id/cancel', (req, res) => {
  const { id } = req.params as any;
  const job = jobs.get(id);
  if (!job) return res.status(404).send('no such job');
  const cancelled = cancelQueued(id);
  setCancelled(id);
  job.status = 'cancelled';
  jobs.set(id, job);
  saveJobsToDisk();
  res.json({ cancelledQueued: cancelled, status: 'cancelled' });
});

// Cancel all jobs immediately
app.post('/uploader/jobs/cancel-all', (req, res) => {
  cancelAll();
  for (const j of jobs.values()) {
    j.status = 'cancelled';
  }
  saveJobsToDisk();
  res.json({ ok: true });
});

// Register remaining route modules
registerSystemRoutes(app);
registerDlRoutes(app);
registerEventRoutes(app);
registerAuthRoutes(app);
registerUploadRoutes(app);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
