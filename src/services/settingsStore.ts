import { invoke } from '@tauri-apps/api/core';

export interface SettingsStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
}

/** Native code chooses and validates the sole settings path; JS cannot load arbitrary stores. */
export async function loadSettingsStore(): Promise<SettingsStore> {
  const rid = await invoke<number>('load_settings');
  // The plugin only receives the resource allocated by our path-free native command.
  // Generic load/get_store/reload/reset commands are absent from the capability.
  return {
    async get<T>(key: string) {
      const [value, exists] = await invoke<[T, boolean]>('plugin:store|get', { rid, key });
      return exists ? value : undefined;
    },
    set: (key, value) => invoke<void>('plugin:store|set', { rid, key, value }),
    save: () => invoke<void>('plugin:store|save', { rid }),
  };
}
