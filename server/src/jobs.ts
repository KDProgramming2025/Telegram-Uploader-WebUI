import fs from 'fs';
import path from 'path';

export type Job = {
  id: string;
  fileUrl: string;
  status: 'queued'|'downloading'|'downloaded'|'uploading'|'done'|'error'|'cancelled';
  percent?: number;
  message?: string;
  tmpPath?: string;
  createdAt: number;
  // optional user-requested base name (without extension)
  requestedName?: string;
  // allow extra fields like type
  [k: string]: any;
};

export const jobs: Map<string, Job> = new Map();

const JOBS_PATH = path.join(__dirname, '../../jobs.json');

export function saveJobsToDisk() {
  try {
    const arr = Array.from(jobs.values());
    const tmp = JOBS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, JOBS_PATH);
  } catch (e) {
    console.error('saveJobsToDisk error', e);
  }
}

export function loadJobsFromDisk() {
  try {
    if (!fs.existsSync(JOBS_PATH)) return;
    const raw = fs.readFileSync(JOBS_PATH, 'utf8');
    const arr = JSON.parse(raw) as any[];
    arr.forEach(j => {
      if (!j.createdAt) j.createdAt = Date.now();
      jobs.set(j.id, j as Job);
    });
  } catch (e) {
    console.error('loadJobsFromDisk error', e);
  }
}
