import { AppError } from '../errors.js';

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class Semaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Semaphore limit must be positive');
  }

  get stats() { return { active: this.active, queued: this.waiters.length, limit: this.limit }; }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new AppError(499, 'REQUEST_CANCELLED', 'Requisição cancelada.');
    if (this.active < this.limit) {
      this.active += 1;
      return this.makeRelease();
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new AppError(499, 'REQUEST_CANCELLED', 'Requisição cancelada enquanto aguardava na fila.'));
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next.signal?.removeEventListener('abort', next.onAbort!);
        next.resolve(this.makeRelease());
      } else {
        this.active -= 1;
      }
    };
  }
}
