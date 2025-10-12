import express from 'express';
import { sseClients } from '../sse';

export function registerEventRoutes(app: express.Express) {
  app.get('/events/:jobId', (req, res) => {
    const { jobId } = req.params;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    (res as any).flushHeaders?.();
    sseClients.set(jobId, res as express.Response);
    res.write(`event: connected\ndata: ${JSON.stringify({ jobId })}\n\n`);
    req.on('close', () => {
      sseClients.delete(jobId);
    });
  });
}
