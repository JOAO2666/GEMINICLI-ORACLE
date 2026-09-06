import { AppError } from '../errors.js';

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: NodeJS.Timeout;
}

export class Semaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly limit: number,
    private readonly maxQueueDepth = 50,
    private readonly queueTimeoutMs = 60_000
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Semaphore limit must be positive');
  }

  get stats() {
    return {
      active: this.active,
      queued: this.waiters.length,
      limit: this.limit,
      maxQueueDepth: this.maxQueueDepth
    };
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new AppError(499, 'REQUEST_CANCELLED', 'Requisição cancelada.');
    if (this.active < this.limit) {
      this.active += 1;
      return this.makeRelease();
    }
    if (this.waiters.length >= this.maxQueueDepth) {
      throw new AppError(429, 'QUEUE_FULL', 'Fila de requisições cheia. Tente novamente mais tarde.');
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      const cleanup = () => {
        if (waiter.timer) clearTimeout(waiter.timer);
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener('abort', waiter.onAbort);
        }
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
      };

      waiter.onAbort = () => {
        cleanup();
        reject(new AppError(499, 'REQUEST_CANCELLED', 'Requisição cancelada enquanto aguardava na fila.'));
      };

      if (this.queueTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          cleanup();
          reject(new AppError(504, 'QUEUE_TIMEOUT', 'Tempo limite de espera na fila excedido.'));
        }, this.queueTimeoutMs);
      }

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
        if (next.timer) clearTimeout(next.timer);
        if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
        next.resolve(this.makeRelease());
      } else {
        this.active -= 1;
      }
    };
  }
}

export class MaintenanceLock {
  private activeReaders = 0;
  private writerActive = false;
  private readonly readWaiters: Array<() => void> = [];
  private readonly writeWaiters: Array<() => void> = [];

  get isUpdating(): boolean {
    return this.writerActive || this.writeWaiters.length > 0;
  }

  async acquireShared(): Promise<() => void> {
    if (!this.writerActive && this.writeWaiters.length === 0) {
      this.activeReaders += 1;
      return this.makeSharedRelease();
    }
    return new Promise<() => void>((resolve) => {
      this.readWaiters.push(() => {
        this.activeReaders += 1;
        resolve(this.makeSharedRelease());
      });
    });
  }

  async acquireExclusive(): Promise<() => void> {
    if (!this.writerActive && this.activeReaders === 0) {
      this.writerActive = true;
      return this.makeExclusiveRelease();
    }
    return new Promise<() => void>((resolve) => {
      this.writeWaiters.push(() => {
        this.writerActive = true;
        resolve(this.makeExclusiveRelease());
      });
    });
  }

  private makeSharedRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeReaders -= 1;
      if (this.activeReaders === 0 && this.writeWaiters.length > 0) {
        const nextWriter = this.writeWaiters.shift();
        nextWriter?.();
      }
    };
  }

  private makeExclusiveRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.writerActive = false;
      if (this.writeWaiters.length > 0) {
        const nextWriter = this.writeWaiters.shift();
        nextWriter?.();
      } else {
        while (this.readWaiters.length > 0) {
          const reader = this.readWaiters.shift();
          reader?.();
        }
      }
    };
  }
}
