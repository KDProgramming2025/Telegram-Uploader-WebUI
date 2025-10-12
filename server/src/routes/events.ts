import express from 'express';
import { sseClients } from '../sse';

function sseHandler(req: express.Request, res: express.Response) {
  const { jobId } = req.params as any;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Disable proxy buffering (e.g., nginx) for SSE
  res.setHeader('X-Accel-Buffering', 'no');
  (res as any).flushHeaders?.();
  sseClients.set(jobId, res as express.Response);
  res.write(`event: connected\ndata: ${JSON.stringify({ jobId })}\n\n`);
  // Heartbeat to keep connection alive and encourage flushing
  const hb = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch {}
  }, 15000);
  req.on('close', () => {
    sseClients.delete(jobId);
    clearInterval(hb);
  });
}

export function registerEventRoutes(app: express.Express) {
  app.get('/events/:jobId', sseHandler);
  app.get('/uploader/events/:jobId', sseHandler);
}
