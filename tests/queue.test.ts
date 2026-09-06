import { describe, expect, it } from 'vitest';
import { Semaphore, MaintenanceLock } from '../src/services/queue.js';

describe('Semaphore', () => {
  it('queues above the concurrency limit', async () => {
    const queue = new Semaphore(1);
    const releaseFirst = await queue.acquire();
    let entered = false;
    const second = queue.acquire().then((release) => { entered = true; release(); });
    await Promise.resolve();
    expect(entered).toBe(false);
    expect(queue.stats).toMatchObject({ active: 1, queued: 1, limit: 1 });
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

  it('rejects with 429 QUEUE_FULL when maxQueueDepth is exceeded', async () => {
    const queue = new Semaphore(1, 2);
    const release = await queue.acquire();
    const wait1 = queue.acquire();
    const wait2 = queue.acquire();
    expect(queue.stats.queued).toBe(2);

    await expect(queue.acquire()).rejects.toMatchObject({
      statusCode: 429,
      code: 'QUEUE_FULL'
    });

    release();
    const r1 = await wait1;
    r1();
    const r2 = await wait2;
    r2();
  });
});

describe('MaintenanceLock', () => {
  it('allows multiple shared readers simultaneously', async () => {
    const lock = new MaintenanceLock();
    const r1 = await lock.acquireShared();
    const r2 = await lock.acquireShared();
    expect(lock.isUpdating).toBe(false);
    r1();
    r2();
  });

  it('blocks readers while exclusive writer holds lock and waits for active readers', async () => {
    const lock = new MaintenanceLock();
    const releaseReader = await lock.acquireShared();

    let writerAcquired = false;
    const writerPromise = lock.acquireExclusive().then((release) => {
      writerAcquired = true;
      return release;
    });

    await Promise.resolve();
    expect(writerAcquired).toBe(false);
    expect(lock.isUpdating).toBe(true);

    let secondReaderAcquired = false;
    const secondReaderPromise = lock.acquireShared().then((release) => {
      secondReaderAcquired = true;
      return release;
    });

    await Promise.resolve();
    expect(secondReaderAcquired).toBe(false);

    releaseReader();
    const releaseWriter = await writerPromise;
    expect(writerAcquired).toBe(true);
    expect(secondReaderAcquired).toBe(false);

    releaseWriter();
    const releaseSecondReader = await secondReaderPromise;
    expect(secondReaderAcquired).toBe(true);
    releaseSecondReader();
  });
});
