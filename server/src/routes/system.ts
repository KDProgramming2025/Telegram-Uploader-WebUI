import express from 'express';

function freeSpaceHandler(req: express.Request, res: express.Response) {
  try {
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

export function registerSystemRoutes(app: express.Express) {
  app.get('/system/free-space', freeSpaceHandler);
  app.get('/uploader/system/free-space', freeSpaceHandler);
}
