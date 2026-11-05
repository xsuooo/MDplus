import { IMAGE_PREPARATION_MS } from '../config/constants';
export interface ImagePreparation {
  promise: Promise<boolean>;
  /** Save/export flush pending work and await the same generation's result. */
  flush: () => Promise<boolean>;
  /** Queued work is dropped; running work still needs the caller's generation check. */
  cancel: () => void;
}

/** Wait for idle input before parsing; explicitly flush at document boundaries. */
export function scheduleImagePreparation(
  prepare: () => Promise<boolean>,
  delay = IMAGE_PREPARATION_MS,
): ImagePreparation {
  let resolve!: (value: boolean) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<boolean>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  let started = false;
  let cancelled = false;
  const flush = () => {
    if (!started && !cancelled) {
      started = true;
      clearTimeout(timer);
      void Promise.resolve()
        .then(() => (cancelled ? false : prepare()))
        .then((result) => resolve(!cancelled && result), reject);
    }
    return promise;
  };
  const timer = setTimeout(flush, delay);
  return {
    promise,
    flush,
    cancel: () => {
      cancelled = true;
      clearTimeout(timer);
      if (!started) resolve(false);
    },
  };
}
