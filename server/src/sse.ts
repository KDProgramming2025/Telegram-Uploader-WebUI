import type express from 'express';

export const sseClients: Map<string, express.Response> = new Map();

export function sendSse(jobId: string, event: string, payload: any) {
  const res = sseClients.get(jobId);
  if (!res) return;
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch (e) {
    // ignore write errors
  }
}

const lastProgressSent: Record<string, { t: number; percent?: number; recv?: number }> = {};
export function throttledProgress(jobId: string, kind: 'download'|'upload', data: any) {
  const now = Date.now();
  const rec = lastProgressSent[jobId] || { t: 0 };
  const minInterval = 750;
  let changed = false;
  if (kind === 'download') {
    if (data.percent != null && data.percent !== rec.percent) changed = true;
    if (rec.t === 0) changed = true;
  } else if (kind === 'upload') {
    if (data.percent != null && data.percent !== rec.percent) changed = true;
    if (rec.t === 0) changed = true;
  }
  if (!changed && now - rec.t < minInterval) return;
  lastProgressSent[jobId] = { t: now, percent: data.percent, recv: data.received };
  sendSse(jobId, kind + 'Progress', data);
}
