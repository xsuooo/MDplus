import { invoke } from '@tauri-apps/api/core';
import { LIMITS } from '../config/constants';

export interface SettingsStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
}

interface SettingsSnapshot {
  values: Record<string, unknown>;
  revision: string | null;
}

interface Edit {
  value: unknown;
  seq: number;
}

function copyValues(values: Record<string, unknown>): Record<string, unknown> {
  const encoded = JSON.stringify(values);
  if (new TextEncoder().encode(encoded).byteLength > LIMITS.settingsFileBytes) {
    throw new Error('Settings exceed the configured size limit');
  }
  return JSON.parse(encoded) as Record<string, unknown>;
}

/** Native failures arrive as plain objects; callers expect an Error with the same fields. */
function toError(error: unknown): unknown {
  if (error instanceof Error || typeof error !== 'object' || error === null) return error;
  const details = error as { message?: unknown };
  if (typeof details.message !== 'string') return error;
  return Object.assign(new Error(details.message), error);
}

/** Only a rejection that provably wrote nothing may be retried automatically. */
function isStaleRevision(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const details = error as { code?: unknown; writeState?: unknown };
  return details.code === 'CONFLICT' && details.writeState === 'unchanged';
}

/** Native code alone chooses the fixed path and commits complete settings atomically. */
export async function loadSettingsStore(): Promise<SettingsStore> {
  const snapshot = await invoke<SettingsSnapshot>('load_settings');
  let values = copyValues(snapshot.values);
  // What the settings file is known to hold. Saves write this plus the local
  // edits the file lacks, so a queued save cannot undo an adopted external change.
  let base = copyValues(snapshot.values);
  let revision = snapshot.revision;
  let saveQueue = Promise.resolve();
  const edits = new Map<string, Edit>();
  let editSeq = 0;
  let savedSeq = 0;
  const overlay = (own: ReadonlyMap<string, Edit>) => {
    const merged = { ...base };
    for (const [key, edit] of own) if (edit.seq > savedSeq) merged[key] = edit.value;
    return copyValues(merged);
  };
  const write = async (own: ReadonlyMap<string, Edit>, seq: number) => {
    const pending = overlay(own);
    const receipt = await invoke<{ revision: string }>('save_settings', {
      values: pending,
      expectedRevision: revision,
    });
    // Failed saves do not advance the CAS baseline or discard pending values.
    revision = receipt.revision;
    base = pending;
    savedSeq = Math.max(savedSeq, seq);
  };
  /** Adopt an externally changed file: unsaved local edits win, other keys follow it. */
  const adopt = async () => {
    const disk = await invoke<SettingsSnapshot>('load_settings');
    if (disk.revision === revision) return false;
    const previous = base;
    base = copyValues(disk.values);
    try {
      values = overlay(edits);
    } catch (error) {
      base = previous;
      throw error;
    }
    revision = disk.revision;
    return true;
  };
  return {
    async get<T>(key: string) {
      // No mutable references escape; every change must pass through validated set.
      if (!Object.prototype.hasOwnProperty.call(values, key)) return undefined;
      return structuredClone(values[key]) as T;
    },
    async set(key, value) {
      if (JSON.stringify(value) === undefined) {
        throw new Error('Settings must contain JSON-serializable values');
      }
      // Serialization, size checks and cloning all happen before publishing the
      // candidate. A failed set leaves the previous in-memory state untouched.
      values = copyValues({ ...values, [key]: value });
      edits.set(key, { value: values[key], seq: ++editSeq });
    },
    save() {
      // Each save commits the edits made up to this call, not later ones.
      const own = new Map(edits);
      const seq = editSeq;
      const operation = saveQueue.then(async () => {
        try {
          await write(own, seq);
        } catch (error) {
          if (!isStaleRevision(error)) throw toError(error);
          let adopted = false;
          try {
            adopted = await adopt();
          } catch {
            // The changed file cannot be read; report the conflict itself.
          }
          if (!adopted) throw toError(error);
          try {
            await write(own, seq);
          } catch (retryError) {
            throw toError(retryError);
          }
        }
      });
      saveQueue = operation.catch(() => {});
      return operation;
    },
  };
}
