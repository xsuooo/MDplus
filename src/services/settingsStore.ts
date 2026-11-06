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

function copyValues(values: Record<string, unknown>): Record<string, unknown> {
  const encoded = JSON.stringify(values);
  if (new TextEncoder().encode(encoded).byteLength > LIMITS.settingsFileBytes) {
    throw new Error('Settings exceed the configured size limit');
  }
  return JSON.parse(encoded) as Record<string, unknown>;
}

/** Native code alone chooses the fixed path and commits complete settings atomically. */
export async function loadSettingsStore(): Promise<SettingsStore> {
  const snapshot = await invoke<SettingsSnapshot>('load_settings');
  let values = copyValues(snapshot.values);
  let revision = snapshot.revision;
  let saveQueue = Promise.resolve();
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
    },
    save() {
      const pending = copyValues(values);
      const operation = saveQueue.then(async () => {
        const receipt = await invoke<{ revision: string }>('save_settings', {
          values: pending,
          expectedRevision: revision,
        });
        // Failed saves do not advance the CAS baseline or discard pending values.
        revision = receipt.revision;
      });
      saveQueue = operation.catch(() => {});
      return operation;
    },
  };
}
