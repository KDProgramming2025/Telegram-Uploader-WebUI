import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { pipeline } from 'stream/promises';
import dotenv from 'dotenv';
// removed Telegraf fallback; only user MTProto client is used now
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import fs from 'fs';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const PORT = process.env.PORT || 11000;
const API_ID = process.env.API_ID;
const API_HASH = process.env.API_HASH;
const TARGET_CHATID = process.env.TARGET_CHATID;
const UI_USERNAME = process.env.UI_USERNAME;
const UI_PASSWORD = process.env.UI_PASSWORD;

// no bot fallback: uploads use the authenticated user session only

// User (MTProto) client setup
const stringSessionPath = path.join(__dirname, '../../session.txt');
let stringSession = '';
if (fs.existsSync(stringSessionPath)) {
  stringSession = fs.readFileSync(stringSessionPath, 'utf8').trim();
}
const client = new TelegramClient(new StringSession(stringSession), Number(API_ID), API_HASH || '', { connectionRetries: 3 });
let clientReady = false;
async function ensureClient() {
  if (!clientReady) {
    await client.connect();
    // nothing to do here; session is managed after sign-in
    clientReady = true;
  }
}


const app = express();
app.use(cors());

app.use(express.static(path.join(__dirname, '../../')));
app.use(express.json({ limit: '50mb' }));

// cookies.txt uploader for MeTube
import multer from 'multer';
const upload = multer({ storage: multer.memoryStorage() });
app.post('/uploader/metube/cookies', upload.single('cookies'), async (req, res) => {
  try {
    // optional auth via multipart fields if UI credentials are configured
    if (UI_USERNAME && UI_PASSWORD) {
      const { username, password } = (req.body || {}) as any;
      if (username !== UI_USERNAME || password !== UI_PASSWORD) {
        return res.status(401).send('Unauthorized');
      }
    }
    if (!req.file) return res.status(400).send('No file uploaded');
    const dest = '/opt/metube/cookies.txt';
    require('fs').writeFileSync(dest, req.file.buffer);
    // restart metube service asynchronously so request returns immediately
    try {
      const { exec } = require('child_process');
      exec('systemctl restart metube', (err: any) => {
        if (err) console.error('metube restart error (async)', err);
      });
    } catch (e) { console.error('failed to spawn restart', e); }
    res.send('ok');
  } catch (e) {
    console.error('cookies.txt upload error', e);
    res.status(500).send('Failed: ' + e);
  }
});

// alias without /uploader prefix for environments where proxy strips the prefix
app.post('/metube/cookies', upload.single('cookies'), async (req, res) => {
  try {
    if (UI_USERNAME && UI_PASSWORD) {
      const { username, password } = (req.body || {}) as any;
      if (username !== UI_USERNAME || password !== UI_PASSWORD) {
        return res.status(401).send('Unauthorized');
      }
    }
    if (!req.file) return res.status(400).send('No file uploaded');
    const dest = '/opt/metube/cookies.txt';
    require('fs').writeFileSync(dest, req.file.buffer);
    try {
      const { exec } = require('child_process');
      exec('systemctl restart metube', (err: any) => {
        if (err) console.error('metube restart error (async alias)', err);
      });
    } catch (restartErr) {
      console.error('metube restart spawn failed', restartErr);
      // file saved, but restart spawn failed
      return res.status(500).send('File saved but restart spawn failed');
    }
    res.send('ok');
  } catch (e) {
    console.error('cookies.txt upload error alias', e);
    res.status(500).send('Failed: ' + e);
  }
});

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

// SSE clients map: jobId -> response
const sseClients: Map<string, express.Response> = new Map();

// Job registry
type Job = {
  id: string;
  fileUrl: string;
  status: 'queued'|'downloading'|'downloaded'|'uploading'|'done'|'error'|'cancelled';
  percent?: number;
  message?: string;
  tmpPath?: string;
  createdAt: number;
};
const jobs: Map<string, Job> = new Map();

// persistence file for jobs
const JOBS_PATH = path.join(__dirname, '../../jobs.json');

function saveJobsToDisk() {
  try {
    const arr = Array.from(jobs.values());
    const tmp = JOBS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, JOBS_PATH);
  } catch (e) {
    console.error('saveJobsToDisk error', e);
  }
}

function loadJobsFromDisk() {
  try {
    if (!fs.existsSync(JOBS_PATH)) return;
    const raw = fs.readFileSync(JOBS_PATH, 'utf8');
    const arr = JSON.parse(raw) as any[];
    arr.forEach(j => {
      // ensure createdAt exists
      if (!j.createdAt) j.createdAt = Date.now();
      jobs.set(j.id, j as Job);
    });
  } catch (e) {
    console.error('loadJobsFromDisk error', e);
  }
}

// load persisted jobs on startup
loadJobsFromDisk();

app.get('/jobs', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const list = Array.from(jobs.values()).sort((a,b) => b.createdAt - a.createdAt);
  res.json(list);
});

app.delete('/jobs/:id', (req, res) => {
  const { id } = req.params;
  const job = jobs.get(id);
  if (!job) return res.status(404).send('no such job');
  // allow deletion if not running
  if (job.status === 'downloading' || job.status === 'uploading') {
    return res.status(400).send('job running');
  }
  // Do not remove files saved in /var/www/dl; only remove temp files.
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
  } catch (e) {
    // ignore errors
  }
  jobs.delete(id);
  saveJobsToDisk();
  sseClients.delete(id);
  res.send('deleted');
});

// free space
function freeSpaceHandler(req: express.Request, res: express.Response) {
  try {
    // force no-cache for this dynamic system info
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    const { execSync } = require('child_process');
    const out = execSync('df -h --output=avail / | tail -1').toString().trim();
    res.json({ free: out });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

app.get('/system/free-space', freeSpaceHandler);
app.get('/uploader/system/free-space', freeSpaceHandler);

// list files in /var/www/dl
function dlListHandler(req: express.Request, res: express.Response) {
  try {
    // ensure clients don't cache dynamic lists
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    const DL_DIR = path.resolve('/var/www/dl');
    if (!fs.existsSync(DL_DIR)) return res.json({ items: [], total: 0 });
    const q = (req.query.q || '').toString().toLowerCase();
    const page = Math.max(1, Number(req.query.page || 1));
    const perPage = Math.max(5, Math.min(200, Number(req.query.perPage || 50)));
    const all = fs.readdirSync(DL_DIR).map(f => {
      try {
        const st = fs.statSync(path.join(DL_DIR, f));
        return { name: f, size: st.size, mtime: st.mtimeMs, isFile: st.isFile() };
      } catch (e) { return null; }
    }).filter(Boolean).filter(x => x!.isFile) as any[];
    let filtered = all;
    if (q) filtered = all.filter(it => it.name.toLowerCase().includes(q));
    const total = filtered.length;
    const start = (page - 1) * perPage;
    const items = filtered.slice(start, start + perPage).map(it => {
      const publicBase = process.env.PUBLIC_BASE_URL || '';
      const publicUrl = publicBase ? publicBase.replace(/\/$/, '') + '/dl/' + encodeURIComponent(it.name) : `/dl/${encodeURIComponent(it.name)}`;
      return { name: it.name, size: it.size, mtime: it.mtime, publicUrl };
    });
    res.json({ items, total });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

app.get('/dl/list', dlListHandler);
app.get('/uploader/dl/list', dlListHandler);

// recursive tree list for /var/www/dl
function buildDlTree(rootAbs: string, rel: string, limiter: { count: number; max: number }): any[] {
  const abs = path.join(rootAbs, rel);
  let entries: string[] = [];
  try { entries = fs.readdirSync(abs); } catch { return []; }
  const nodes: any[] = [];
  for (const name of entries) {
    if (limiter.count >= limiter.max) break;
    const full = path.join(abs, name);
    let st: fs.Stats;
    try { st = fs.statSync(full); } catch { continue; }
    const node: any = {
      name,
      path: path.posix.join(rel.split(path.sep).filter(Boolean).join('/'), name).replace(/\\/g,'/'),
      mtime: st.mtimeMs,
      isDir: st.isDirectory(),
      size: st.isFile() ? st.size : undefined
    };
    nodes.push(node);
    limiter.count++;
    if (node.isDir) {
      node.children = buildDlTree(rootAbs, path.join(rel, name), limiter);
    }
  }
  // sort: dirs first then files alphabetically
  nodes.sort((a,b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

function dlTreeHandler(req: express.Request, res: express.Response) {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const DL_DIR = path.resolve('/var/www/dl');
    if (!fs.existsSync(DL_DIR)) return res.json({ root: [] });
    const limiter = { count: 0, max: 5000 }; // safety cap
    const tree = buildDlTree(DL_DIR, '', limiter);
    res.json({ root: tree, truncated: limiter.count >= limiter.max });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

app.get('/uploader/dl/tree', dlTreeHandler);
app.get('/dl/tree', dlTreeHandler);

// delete a file in /var/www/dl
function dlDeleteHandler(req: express.Request, res: express.Response) {
  try {
    // require UI credentials passed in request body to authorize deletion
    const { username, password } = (req.body || {}) as any;
    if (username !== UI_USERNAME || password !== UI_PASSWORD) {
      return res.status(401).send('Unauthorized');
    }
    const name = req.params.name;
    // name will be URL-decoded by express; prevent path traversal
    const DL_DIR = path.resolve('/var/www/dl');
    const resolved = path.resolve(DL_DIR, name);
    if (!(resolved === DL_DIR || resolved.startsWith(DL_DIR + path.sep))) {
      return res.status(400).send('invalid path');
    }
    if (!fs.existsSync(resolved)) return res.status(404).send('not found');
    const st = fs.statSync(resolved);
    if (!st.isFile()) return res.status(400).send('not a file');
    fs.unlinkSync(resolved);
    console.log(`DL DELETE: removed ${resolved}`);
    res.send('deleted');
  } catch (e) {
    console.error('dl delete error', e);
    res.status(500).json({ error: String(e) });
  }
}

app.delete('/dl/:name', dlDeleteHandler);
app.delete('/uploader/dl/:name', dlDeleteHandler);

// recursive delete (file or directory) using JSON body { username, password, path }
app.delete('/uploader/dl/any', (req, res) => {
  try {
    const { username, password, path: relPath } = (req.body || {}) as any;
    if (username !== UI_USERNAME || password !== UI_PASSWORD) {
      return res.status(401).send('Unauthorized');
    }
    if (!relPath || typeof relPath !== 'string') return res.status(400).send('path required');
    const DL_DIR = path.resolve('/var/www/dl');
    const target = path.resolve(DL_DIR, relPath);
    if (!(target === DL_DIR || target.startsWith(DL_DIR + path.sep))) {
      return res.status(400).send('invalid path');
    }
    if (!fs.existsSync(target)) return res.status(404).send('not found');
    const st = fs.statSync(target);
    if (st.isDirectory()) {
      fs.rmSync(target, { recursive: true, force: true });
      return res.send('deleted');
    } else {
      fs.unlinkSync(target);
      return res.send('deleted');
    }
  } catch (e) {
    console.error('recursive delete error', e);
    res.status(500).json({ error: String(e) });
  }
});

// alias without /uploader prefix for environments where proxy strips prefix
app.delete('/dl/any', (req, res) => {
  try {
    const { username, password, path: relPath } = (req.body || {}) as any;
    if (username !== UI_USERNAME || password !== UI_PASSWORD) {
      return res.status(401).send('Unauthorized');
    }
    if (!relPath || typeof relPath !== 'string') return res.status(400).send('path required');
    const DL_DIR = path.resolve('/var/www/dl');
    const target = path.resolve(DL_DIR, relPath);
    if (!(target === DL_DIR || target.startsWith(DL_DIR + path.sep))) {
      return res.status(400).send('invalid path');
    }
    if (!fs.existsSync(target)) return res.status(404).send('not found');
    const st = fs.statSync(target);
    if (st.isDirectory()) {
      fs.rmSync(target, { recursive: true, force: true });
      return res.send('deleted');
    } else {
      fs.unlinkSync(target);
      return res.send('deleted');
    }
  } catch (e) {
    console.error('recursive delete error alias', e);
    res.status(500).json({ error: String(e) });
  }
});

// POST fallbacks for proxies that block DELETE (same semantics)
app.post('/uploader/dl/any-delete', (req, res) => {
  try {
    const { username, password, path: relPath } = (req.body || {}) as any;
    if (username !== UI_USERNAME || password !== UI_PASSWORD) {
      return res.status(401).send('Unauthorized');
    }
    if (!relPath || typeof relPath !== 'string') return res.status(400).send('path required');
    const DL_DIR = path.resolve('/var/www/dl');
    const target = path.resolve(DL_DIR, relPath);
    if (!(target === DL_DIR || target.startsWith(DL_DIR + path.sep))) {
      return res.status(400).send('invalid path');
    }
    if (!fs.existsSync(target)) return res.status(404).send('not found');
    const st = fs.statSync(target);
    if (st.isDirectory()) {
      fs.rmSync(target, { recursive: true, force: true });
      return res.send('deleted');
    } else {
      fs.unlinkSync(target);
      return res.send('deleted');
    }
  } catch (e) {
    console.error('recursive delete error post', e);
    res.status(500).json({ error: String(e) });
  }
});
app.post('/dl/any-delete', (req, res) => {
  try {
    const { username, password, path: relPath } = (req.body || {}) as any;
    if (username !== UI_USERNAME || password !== UI_PASSWORD) {
      return res.status(401).send('Unauthorized');
    }
    if (!relPath || typeof relPath !== 'string') return res.status(400).send('path required');
    const DL_DIR = path.resolve('/var/www/dl');
    const target = path.resolve(DL_DIR, relPath);
    if (!(target === DL_DIR || target.startsWith(DL_DIR + path.sep))) {
      return res.status(400).send('invalid path');
    }
    if (!fs.existsSync(target)) return res.status(404).send('not found');
    const st = fs.statSync(target);
    if (st.isDirectory()) {
      fs.rmSync(target, { recursive: true, force: true });
      return res.send('deleted');
    } else {
      fs.unlinkSync(target);
      return res.send('deleted');
    }
  } catch (e) {
    console.error('recursive delete error post alias', e);
    res.status(500).json({ error: String(e) });
  }
});

// recursive rename (file or directory) using JSON body { username, password, oldPath, newPath }
app.post('/uploader/dl/rename', (req, res) => {
  try {
    const { username, password, oldPath, newPath } = (req.body || {}) as any;
    if (username !== UI_USERNAME || password !== UI_PASSWORD) {
      return res.status(401).send('Unauthorized');
    }
    if (!oldPath || typeof oldPath !== 'string' || !newPath || typeof newPath !== 'string') {
      return res.status(400).send('oldPath and newPath required');
    }
    const DL_DIR = path.resolve('/var/www/dl');
    const oldTarget = path.resolve(DL_DIR, oldPath);
    const newTarget = path.resolve(DL_DIR, newPath);
    if (!(oldTarget === DL_DIR || oldTarget.startsWith(DL_DIR + path.sep))) {
      return res.status(400).send('invalid oldPath');
    }
    if (!(newTarget === DL_DIR || newTarget.startsWith(DL_DIR + path.sep))) {
      return res.status(400).send('invalid newPath');
    }
    if (!fs.existsSync(oldTarget)) {
      return res.status(404).send('oldPath not found');
    }
    if (fs.existsSync(newTarget)) {
      return res.status(409).send('newPath already exists');
    }
    fs.renameSync(oldTarget, newTarget);
    res.send('renamed');
  } catch (e) {
    console.error('rename error', e);
    res.status(500).json({ error: String(e) });
  }
});

// alias without /uploader prefix
app.post('/dl/rename', (req, res) => {
  try {
    const { username, password, oldPath, newPath } = (req.body || {}) as any;
    if (username !== UI_USERNAME || password !== UI_PASSWORD) {
      return res.status(401).send('Unauthorized');
    }
    if (!oldPath || typeof oldPath !== 'string' || !newPath || typeof newPath !== 'string') {
      return res.status(400).send('oldPath and newPath required');
    }
    const DL_DIR = path.resolve('/var/www/dl');
    const oldTarget = path.resolve(DL_DIR, oldPath);
    const newTarget = path.resolve(DL_DIR, newPath);
    if (!(oldTarget === DL_DIR || oldTarget.startsWith(DL_DIR + path.sep))) {
      return res.status(400).send('invalid oldPath');
    }
    if (!(newTarget === DL_DIR || newTarget.startsWith(DL_DIR + path.sep))) {
      return res.status(400).send('invalid newPath');
    }
    if (!fs.existsSync(oldTarget)) {
      return res.status(404).send('oldPath not found');
    }
    if (fs.existsSync(newTarget)) {
      return res.status(409).send('newPath already exists');
    }
    fs.renameSync(oldTarget, newTarget);
    res.send('renamed');
  } catch (e) {
    console.error('rename error alias', e);
    res.status(500).json({ error: String(e) });
  }
});

function sendSse(jobId: string, event: string, payload: any) {
  const res = sseClients.get(jobId);
  if (!res) return;
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch (e) {
    // ignore write errors
  }
}

// Simple throttle helper for high-frequency progress events
const lastProgressSent: Record<string, { t: number; percent?: number; recv?: number }> = {};
function throttledProgress(jobId: string, kind: 'download'|'upload', data: any) {
  const now = Date.now();
  const rec = lastProgressSent[jobId] || { t: 0 };
  const minInterval = 750; // ms between emits
  let changed = false;
  if (kind === 'download') {
    if (data.percent != null && data.percent !== rec.percent) changed = true;
    if (rec.t === 0) changed = true;
  } else if (kind === 'upload') {
    if (data.percent != null && data.percent !== rec.percent) changed = true;
    if (rec.t === 0) changed = true;
  }
  if (!changed && now - rec.t < minInterval) return; // skip
  lastProgressSent[jobId] = { t: now, percent: data.percent, recv: data.received };
  sendSse(jobId, kind + 'Progress', data);
}

app.get('/events/:jobId', (req, res) => {
  const { jobId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  sseClients.set(jobId, res as express.Response);
  // send an initial hello
  res.write(`event: connected\ndata: ${JSON.stringify({ jobId })}\n\n`);
  req.on('close', () => {
    sseClients.delete(jobId);
  });
});

// Auth endpoints for interactive login via UI
app.post('/auth/start', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).send('phone required');
  try {
  await client.connect();
  const result: any = await client.invoke(new Api.auth.SendCode({ phoneNumber: phone, apiId: Number(API_ID), apiHash: API_HASH, settings: new Api.CodeSettings({}) }));
  (global as any)._phone = phone;
  (global as any)._phone_code_hash = result.phone_code_hash || result.phoneCodeHash || result.phoneCodeHash;
  res.send('code_sent');
  } catch (err) {
    console.error('auth start error', err);
    res.status(500).send('failed');
  }
});

app.post('/auth/verify', async (req, res) => {
  const { code } = req.body;
  const phone = (global as any)._phone;
  const phone_code_hash = (global as any)._phone_code_hash;
  if (!phone || !phone_code_hash) return res.status(400).send('start not called');
  try {
    const result: any = await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash: phone_code_hash, phoneCode: code }));
    const saved = (client.session as any).save();
    if (saved) {
      stringSession = saved as string;
      fs.writeFileSync(stringSessionPath, stringSession, { mode: 0o600 });
    }
    clientReady = true;
    res.send('ok');
  } catch (err: any) {
    console.error('verify error', err);
    // handle 2FA password required
    if (err.code === 401 && err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
      // expect password in request body
      const { password } = req.body;
      if (!password) return res.status(400).send('password required');
      try {
        const pw = await client.invoke(new Api.account.GetPassword());
        // use helper to compute InputCheckPasswordSRP
        const compute = require('telegram/Password').computeCheck;
        const inputCheck = await compute(pw, password);
        const sign = await client.invoke(new Api.auth.CheckPassword({ password: inputCheck }));
        const saved2 = (client.session as any).save();
        if (saved2) {
          stringSession = saved2 as string;
          fs.writeFileSync(stringSessionPath, stringSession, { mode: 0o600 });
        }
        clientReady = true;
        return res.send('ok');
      } catch (pwerr) {
        console.error('password verify error', pwerr);
        return res.status(500).send('password failed');
      }
    }
    res.status(500).send('failed');
  }
});

app.post('/upload', async (req: express.Request, res: express.Response) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const { username, password, fileUrl } = req.body;
  if (username !== UI_USERNAME || password !== UI_PASSWORD) {
    return res.status(401).send('Unauthorized');
  }
  if (!fileUrl) return res.status(400).send('No fileUrl provided');
  // create a job id and respond immediately. progress will be sent over SSE at /events/:jobId
  const saveToDl = !!(req as any).body.saveToDl;
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const job: Job = { id: jobId, fileUrl, status: 'queued', createdAt: Date.now(), tmpPath: undefined } as any;
  // record job type so UI can render it immediately
  (job as any).type = saveToDl ? 'download' : 'upload';
  jobs.set(jobId, job);
  saveJobsToDisk();
  res.json({ jobId, type: (job as any).type });

  // run the download/upload in background
  (async () => {
    const tmpDir = saveToDl ? '/var/www/dl' : path.join(__dirname, '../../tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    let fileName: string;
    if (saveToDl) {
      // use original basename from URL and ensure uniqueness
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

      // decide upload method
      const videoExts = ['.mp4', '.mkv', '.mov', '.webm', '.avi', '.flv', '.wmv', '.m4v'];
      const ext = path.extname(tmpPath).toLowerCase();
      const isVideo = videoExts.includes(ext);

      // If the user requested to save to /var/www/dl, skip uploading entirely.
      if (saveToDl) {
        job.status = 'done'; job.percent = 100; jobs.set(jobId, job);
        // notify client that download was saved and no upload will follow
  // provide a public URL for the saved file
  const publicBase = process.env.PUBLIC_BASE_URL || 'https://aparat.feezor.net';
  const publicUrl = publicBase.replace(/\/$/, '') + '/dl/' + encodeURIComponent(path.basename(tmpPath));
  sendSse(jobId, 'downloadSaved', { path: tmpPath, size, publicUrl });
    saveJobsToDisk();
    sendSse(jobId, 'done', { success: true });
        return;
      }

      if (!clientReady) {
        try {
          if (stringSession) {
            await client.connect();
            clientReady = true;
          }
        } catch (e) {
          console.warn('client connect failed, will use bot token if available');
        }
      }

      // Estimate upload duration using download bytes/sec as a simple heuristic.
      const estUploadBps = Math.max(downloadBps, 50 * 1024); // at least 50KB/s
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

      const stopProgressEmitter = () => {
        if (uploadTimer) {
          clearInterval(uploadTimer);
          uploadTimer = null;
        }
      };

      if (clientReady) {
        job.status = 'uploading'; jobs.set(jobId, job); sendSse(jobId, 'status', { status: job.status });
        startProgressEmitter('user');
        // try to probe video metadata so Telegram will treat it as a proper, streamable video
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
          // ffprobe not available or failed; proceed without attributes
          console.warn('ffprobe failed or not installed, sending without video attributes', probeErr && probeErr.message ? probeErr.message : String(probeErr));
        }

        // send file with attributes when available so Telegram can generate preview and enable streaming
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
        // No bot fallback: require user client to be connected
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
