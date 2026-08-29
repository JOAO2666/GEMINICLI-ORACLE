import { describe, expect, it } from 'vitest';
import { Semaphore } from '../src/services/queue.js';

describe('Semaphore', () => {
  it('queues above the concurrency limit', async () => {
    const queue = new Semaphore(1);
    const releaseFirst = await queue.acquire();
    let entered = false;
    const second = queue.acquire().then((release) => { entered = true; release(); });
    await Promise.resolve();
    expect(entered).toBe(false);
    expect(queue.stats).toEqual({ active: 1, queued: 1, limit: 1 });
    releaseFirst();
    await second;
    expect(entered).toBe(true);
    expect(queue.stats.active).toBe(0);
  });

  it('removes an aborted waiter', async () => {
    const queue = new Semaphore(1);
    const release = await queue.acquire();
    const controller = new AbortController();
    const waiting = queue.acquire(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    release();
    expect(queue.stats.queued).toBe(0);
  });
});
