import express from 'express';
import fs from 'fs';
import path from 'path';
import { UI_USERNAME, UI_PASSWORD } from '../config';
import { jobs, Job, saveJobsToDisk } from '../jobs';
import { enqueue, isCancelled } from '../queue';
import { hasJob } from '../jobs';
import { performTelegramUpload } from '../upload_telegram';

function dlListHandler(req: express.Request, res: express.Response) {
  try {
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
    }).filter(Boolean).filter(x => (x as any).isFile) as any[];
    let filtered = all;
    if (q) filtered = all.filter(it => it.name.toLowerCase().includes(q));
    const total = filtered.length;
    const start = (page - 1) * perPage;
    const items = filtered.slice(start, start + perPage).map(it => {
      // Return a relative URL; the client should prepend window.location.origin
      const publicUrl = `/dl/${encodeURIComponent(it.name)}`;
      return { name: it.name, size: it.size, mtime: it.mtime, publicUrl };
    });
    res.json({ items, total });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

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
    const limiter = { count: 0, max: 5000 };
    const tree = buildDlTree(DL_DIR, '', limiter);
    res.json({ root: tree, truncated: limiter.count >= limiter.max });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

function dlDeleteHandler(req: express.Request, res: express.Response) {
  try {
    const { username, password } = (req.body || {}) as any;
    if (username !== UI_USERNAME || password !== UI_PASSWORD) {
      return res.status(401).send('Unauthorized');
    }
    const name = req.params.name;
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

export function registerDlRoutes(app: express.Express) {
  app.get('/dl/list', dlListHandler);
  app.get('/uploader/dl/list', dlListHandler);
  app.get('/uploader/dl/tree', dlTreeHandler);
  app.get('/dl/tree', dlTreeHandler);

  app.delete('/dl/:name', dlDeleteHandler);
  app.delete('/uploader/dl/:name', dlDeleteHandler);

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

  // Enqueue upload(s) to Telegram for a file or folder under /var/www/dl
  const uploadHandler = (req: express.Request, res: express.Response) => {
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

      // collect files
      const files: string[] = [];
      const walk = (p: string) => {
        const st = fs.statSync(p);
        if (st.isDirectory()) {
          const list = fs.readdirSync(p).sort((a,b) => a.localeCompare(b));
          for (const name of list) walk(path.join(p, name));
        } else if (st.isFile()) {
          files.push(p);
        }
      };
      const st = fs.statSync(target);
      if (st.isDirectory()) walk(target); else files.push(target);

      // Alphabetical order for files, by path
      files.sort((a,b) => a.localeCompare(b));

      const created: any[] = [];
      for (const abs of files) {
        const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
        const job: Job = {
          id: jobId,
          fileUrl: 'local:' + path.relative(DL_DIR, abs).replace(/\\/g,'/'),
          status: 'queued',
          createdAt: Date.now(),
          tmpPath: abs
        } as any;
        (job as any).type = 'upload';
        jobs.set(jobId, job);
        saveJobsToDisk();
        enqueue(async () => {
          if (isCancelled(jobId) || !hasJob(jobId)) return; // skip if cancelled or removed before start
          await performTelegramUpload(job, abs);
        }, jobId);
        created.push({ jobId, path: path.relative(DL_DIR, abs).replace(/\\/g,'/'), type: 'upload' });
      }
      res.json({ total: created.length, jobs: created });
    } catch (e) {
      console.error('dl upload enqueue error', e);
      res.status(500).json({ error: String(e) });
    }
  };
  app.post('/uploader/dl/upload', uploadHandler);
  app.post('/dl/upload', uploadHandler);
}
