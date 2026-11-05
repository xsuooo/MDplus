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
    finish(true);
    expect(await result).toBe(false);
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
