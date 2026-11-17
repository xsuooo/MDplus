import { expect, it } from 'vitest';
import { serialQueue } from '../src/lib/serialQueue';

it('runs tasks in order and continues after a failure', async () => {
  const run = serialQueue();
  const log: string[] = [];
  let release!: () => void;
  const first = run(() =>
    new Promise<void>((resolve) => (release = resolve)).then(() => void log.push('a')),
  );
  const second = run(async () => {
    log.push('b');
    throw new Error('boom');
  });
  const third = run(async () => log.push('c'));
  await Promise.resolve();
  expect(log).toEqual([]);
  release();
  await first;
  await expect(second).rejects.toThrow('boom');
  await third;
  expect(log).toEqual(['a', 'b', 'c']);
});
