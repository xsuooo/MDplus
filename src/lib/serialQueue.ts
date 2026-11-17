/** Runs tasks one at a time in call order; a failed task does not block the next. */
export function serialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const next = tail.then(task);
    tail = next.catch(() => {});
    return next;
  };
}
