// Bounded-concurrency run queue. The vision model is the bottleneck (~15-40s/step),
// so batch regressions (Run all P0 / whole suite) must not launch N browsers at once.
// Tasks are admitted up to RUN_CONCURRENCY at a time; the rest wait in FIFO order.
//
// Default is 1: a single self-hosted VL model returns 502 ("terminated") under
// concurrent load. Raise RUN_CONCURRENCY when the model backend is a farm/replica
// set that can serve parallel requests — the queue then fans out to that width.
const CONCURRENCY = Math.max(1, Number(process.env.RUN_CONCURRENCY) || 1);

interface Task<T> {
  run: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  label: string;
}

let active = 0;
let totalQueued = 0;
let totalDone = 0;
const waiting: Task<unknown>[] = [];
const activeLabels = new Set<string>();

function pump(): void {
  while (active < CONCURRENCY && waiting.length) {
    const task = waiting.shift()!;
    active++;
    activeLabels.add(task.label);
    void task
      .run()
      .then(task.resolve, task.reject)
      .finally(() => {
        active--;
        totalDone++;
        activeLabels.delete(task.label);
        pump();
      });
  }
}

// Enqueue a unit of work; resolves with its result when a worker slot frees up.
export function enqueue<T>(run: () => Promise<T>, label = "task"): Promise<T> {
  totalQueued++;
  return new Promise<T>((resolve, reject) => {
    waiting.push({ run, resolve, reject, label } as Task<unknown>);
    pump();
  });
}

export interface QueueStatus {
  concurrency: number;
  active: number;
  waiting: number;
  totalQueued: number;
  totalDone: number;
  activeLabels: string[];
}
export const queueStatus = (): QueueStatus => ({
  concurrency: CONCURRENCY,
  active,
  waiting: waiting.length,
  totalQueued,
  totalDone,
  activeLabels: [...activeLabels],
});
