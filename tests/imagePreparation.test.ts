import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleImagePreparation } from '../src/lib/imagePreparation';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('deferred image preparation', () => {
  it('runs once after the idle delay and shares its result', async () => {
    const prepare = vi.fn(async () => true);
    const task = scheduleImagePreparation(prepare);
    await vi.advanceTimersByTimeAsync(149);
    expect(prepare).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await task.promise).toBe(true);
    expect(await task.flush()).toBe(true);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('flushes before the timer without running twice', async () => {
    const prepare = vi.fn(async () => true);
    const task = scheduleImagePreparation(prepare);
    expect(await task.flush()).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('settles cancelled queued work without parsing', async () => {
    const prepare = vi.fn(async () => true);
    const task = scheduleImagePreparation(prepare);
    task.cancel();
    expect(await task.promise).toBe(false);
    expect(await task.flush()).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('does not publish readiness from a cancelled in-flight read', async () => {
    let finish!: (result: boolean) => void;
    const task = scheduleImagePreparation(
      () =>
        new Promise<boolean>((done) => {
          finish = done;
        }),
    );
    const result = task.flush();
    await Promise.resolve();
    task.cancel();
    // Cancellation cannot retain old recovery/Markdown waiters until IO finishes.
    expect(await result).toBe(false);
    finish(true);
    expect(await task.promise).toBe(false);
  });

  it('lets a cancelled running caller dispose a late preparation without committing it', async () => {
    let finish!: () => void;
    let current = true;
    const prepared = { commit: vi.fn(() => true), dispose: vi.fn(async () => {}) };
    const task = scheduleImagePreparation(async () => {
      await new Promise<void>((done) => {
        finish = done;
      });
      try {
        return current && prepared.commit();
      } finally {
        await prepared.dispose();
      }
    });
    void task.flush();
    await Promise.resolve();
    current = false;
    task.cancel();
    expect(await task.promise).toBe(false);
    expect(prepared.dispose).not.toHaveBeenCalled();
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(prepared.commit).not.toHaveBeenCalled();
    expect(prepared.dispose).toHaveBeenCalledOnce();
    expect(await task.flush()).toBe(false);
  });

  it('handles a late rejection after cancellation without changing the resolved barrier', async () => {
    let fail!: (error: Error) => void;
    const task = scheduleImagePreparation(
      () =>
        new Promise<boolean>((_done, reject) => {
          fail = reject;
        }),
    );
    void task.flush();
    await Promise.resolve();
    task.cancel();
    expect(await task.promise).toBe(false);
    fail(new Error('late native failure'));
    await Promise.resolve();
    expect(await task.promise).toBe(false);
  });

  it('drops a flushed job cancelled before its first microtask', async () => {
    const prepare = vi.fn(async () => true);
    const task = scheduleImagePreparation(prepare);
    const result = task.flush();
    task.cancel();
    expect(await result).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('propagates a failed preparation to the save/recovery barrier', async () => {
    const failure = new Error('image read failed');
    const task = scheduleImagePreparation(async () => {
      throw failure;
    });
    await expect(task.flush()).rejects.toBe(failure);
  });
});
