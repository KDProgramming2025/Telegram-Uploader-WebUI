import express from 'express';
import multer from 'multer';
import { UI_USERNAME, UI_PASSWORD } from '../config';

const upload = multer({ storage: multer.memoryStorage() });

export function registerMetubeRoutes(app: express.Express) {
  app.post('/uploader/metube/cookies', upload.single('cookies'), async (req, res) => {
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
          if (err) console.error('metube restart error (async)', err);
        });
      } catch (e) { console.error('failed to spawn restart', e); }
      res.send('ok');
    } catch (e) {
      console.error('cookies.txt upload error', e);
      res.status(500).send('Failed: ' + e);
    }
  });

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
        return res.status(500).send('File saved but restart spawn failed');
      }
      res.send('ok');
    } catch (e) {
      console.error('cookies.txt upload error alias', e);
      res.status(500).send('Failed: ' + e);
    }
  });
}
