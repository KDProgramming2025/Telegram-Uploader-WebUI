type Task = () => Promise<void>;

type QueueItem = { id?: string; run: Task };

const q: QueueItem[] = [];
let running = false;
let activeId: string | undefined;
const cancelled: Map<string, boolean> = new Map();

async function runLoop() {
  if (running) return;
  running = true;
  while (q.length) {
    const item = q.shift()!;
    activeId = item.id;
    try {
      await item.run();
    } catch (e) {
      console.error('Queue task error', e);
    } finally {
      activeId = undefined;
    }
  }
  running = false;
}

export function enqueue(task: Task, id?: string) {
  q.push({ id, run: task });
  runLoop();
}

export function cancelQueued(id: string): boolean {
  const idx = q.findIndex((x) => x.id === id);
  if (idx >= 0) {
    q.splice(idx, 1);
    return true;
  }
  return false;
}

export function getActiveJobId() {
  return activeId;
}

export function pendingCount() {
  return q.length + (running ? 1 : 0);
}

export function setCancelled(id: string) {
  cancelled.set(id, true);
}

export function isCancelled(id: string) {
  return cancelled.get(id) === true;
}

export function cancelAll() {
  q.splice(0, q.length);
  if (activeId) cancelled.set(activeId, true);
}
