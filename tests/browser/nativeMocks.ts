import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { LIMITS } from '../../src/config/constants';
import contract from '../../src-tauri/src/file_contract.json';

const applicationCommands = new Set(Object.keys(contract['x-commands']));
const fixturePluginCommands = new Set([
  'plugin:path|dirname',
  'plugin:path|join',
  'plugin:window|inner_size',
  'plugin:window|outer_position',
  'plugin:window|is_minimized',
  'plugin:window|is_maximized',
  'plugin:window|is_visible',
  'plugin:window|available_monitors',
  'plugin:window|set_size',
  'plugin:window|set_position',
  'plugin:window|show',
  'plugin:window|set_focus',
  'plugin:window|unminimize',
  'plugin:window|minimize',
  'plugin:window|maximize',
  'plugin:window|unmaximize',
  'plugin:window|toggle_maximize',
  'plugin:window|destroy',
  'plugin:dialog|open',
  'plugin:dialog|save',
  'plugin:dialog|message',
]);

/** Pure-browser native boundary. No command here touches the real filesystem/settings. */
export type NativeFixtureHandler = (command: string, args: Record<string, unknown>) => unknown;
export interface FixtureSettingsSnapshot {
  values: Record<string, unknown>;
  revision: string | null;
}
export interface NativeMockOptions {
  settings?: Map<string, unknown>;
  binaries?: Map<string, number[]>;
  /** Existing scenario handler: its delayed operations and injected errors are awaited unchanged. */
  fallback?: NativeFixtureHandler;
  /** Explicit compatibility boundary for old fixture bytes, never a production IPC fallback. */
  legacyImagePayloads?: boolean;
  settingsMode?: 'native' | 'delegate';
  beforeLoadSettings?: (snapshot: FixtureSettingsSnapshot) => void | Promise<void>;
  beforeSaveSettings?: (
    values: Record<string, unknown>,
    previous: FixtureSettingsSnapshot,
  ) => void | Promise<void>;
  beforeCommand?: (command: string, args: Record<string, unknown>) => void | Promise<void>;
  stashByteLimit?: number;
  stashEntryLimit?: number;
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Native fixture: ${message}`);
}
function record(value: unknown): Record<string, unknown> {
  check(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'expected object payload',
  );
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  check(typeof value === 'string' && value.length > 0, `${label} must be a nonempty string`);
  return value;
}
function keys(value: unknown): string[] {
  check(Array.isArray(value) && value.length <= LIMITS.imageStashEntries, 'invalid token batch');
  return value.map((key) => string(key, 'token'));
}

export function encodeFixtureBytes(input: Uint8Array | readonly number[]): string {
  if (!(input instanceof Uint8Array))
    check(
      input.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255),
      'invalid byte array',
    );
  const bytes = input instanceof Uint8Array ? input : Uint8Array.from(input);
  check(bytes.byteLength <= LIMITS.imageFileBytes, 'image exceeds byte limit');
  const encoded: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x6000)
    encoded.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 0x6000))));
  return encoded.join('');
}

export function decodeFixtureBase64(value: unknown): Uint8Array {
  const encoded = string(value, 'dataBase64');
  check(encoded.length <= Math.ceil(LIMITS.imageFileBytes / 3) * 4, 'image exceeds encoded limit');
  check(encoded.length % 4 === 0, 'base64 length is not padded');
  const length =
    (encoded.length / 4) * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
  check(length > 0 && length <= LIMITS.imageFileBytes, 'image exceeds decoded limit');
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (let start = 0; start < encoded.length; start += 0x8000) {
    const chunk = encoded.slice(start, start + 0x8000);
    check(
      start + chunk.length === encoded.length || !chunk.includes('='),
      'interior base64 padding',
    );
    const binary = atob(chunk);
    check(btoa(binary) === chunk, 'base64 must be canonical STANDARD encoding');
    for (let i = 0; i < binary.length; i++) bytes[offset++] = binary.charCodeAt(i);
  }
  check(offset === length, 'decoded image size mismatch');
  return bytes;
}

const imageTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};
function filenameMime(filename: string): string {
  const hasControl = [...filename].some(
    (char) => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159),
  );
  check(
    !/[\\/:]/.test(filename) && !hasControl && filename !== '.' && filename !== '..',
    'invalid image basename',
  );
  const extension = filename.split('.').pop()!.toLowerCase();
  const mime = imageTypes[extension];
  check(mime, 'unsupported image extension');
  // Native magic/XML validation is tested in Rust. A legacy fixture may deliberately
  // use synthetic bytes; this adapter never substitutes a different image for them.
  return mime;
}
function token(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
function normalized(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '.') continue;
    if (part === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}
function directory(path: string): string {
  return normalized(path).replace(/\/[^/]+$/, '');
}
function jsonValues(value: unknown): Record<string, unknown> {
  const values = record(value);
  const encoded = JSON.stringify(values);
  check(
    new TextEncoder().encode(encoded).length <= LIMITS.settingsFileBytes,
    'settings exceed byte limit',
  );
  return JSON.parse(encoded) as Record<string, unknown>;
}
function compactImage(value: unknown): Record<string, unknown> {
  const original = record(value);
  if ('dataBase64' in original) {
    decodeFixtureBase64(original.dataBase64);
    check(!('data' in original), 'image contains both legacy and compact data');
    return { ...original };
  }
  const { data, ...metadata } = original;
  check(Array.isArray(data) || data instanceof Uint8Array, 'legacy image fixture is missing bytes');
  return { ...metadata, dataBase64: encodeFixtureBytes(data as number[] | Uint8Array) };
}

export function createNativeMocks(options: NativeMockOptions = {}) {
  const settings = options.settings ?? new Map<string, unknown>();
  const binaries = options.binaries ?? new Map<string, number[]>();
  const stashes = new Map<string, { dataBase64: string; mime: string; length: number }>();
  const allocations = new Map<string, { path: string; identity: number[]; encoded: string }>();
  const delegatedAllocations = new Set<string>();
  const recoveryImages = new Map<string, { dataBase64: string; mime: string }>();
  const recoverySnapshots = new Map<string, Record<string, unknown>>();
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  let stashBytes = 0;
  let settingsExists = settings.size > 0;
  const geometry = {
    width: 1200,
    height: 800,
    x: 0,
    y: 0,
    minimized: false,
    maximized: false,
    visible: false,
    destroyed: false,
  };
  const settingsSnapshot = (): FixtureSettingsSnapshot => {
    const values = jsonValues(Object.fromEntries(settings));
    const canonical = JSON.stringify(
      Object.keys(values)
        .sort()
        .map((key) => [key, values[key]]),
    );
    return {
      values,
      revision: settingsExists || settings.size ? `mock-settings:${canonical}` : null,
    };
  };
  const delegate = async (command: string, args: Record<string, unknown>) => {
    check(options.fallback, `unmocked IPC: ${command}`);
    return await options.fallback(command, args);
  };

  const retainedRecoveryKeys = (value: unknown) => {
    const retained = keys(value);
    check(
      retained.every((key) => /^[A-Za-z0-9-]{1,100}\.(png|jpg|jpeg|gif|webp|svg)$/.test(key)),
      'invalid recovery image key',
    );
    return retained;
  };
  const pruneRecoveryImages = (id: string, retained: string[]) => {
    const current = recoverySnapshots.get(id);
    const keep = new Set([
      ...retained,
      ...((current?.images ?? []) as Record<string, unknown>[]).map((image) => String(image.key)),
    ]);
    const removedKeys: string[] = [];
    for (const key of recoveryImages.keys()) {
      if (key.startsWith(`${id}/`) && !keep.has(key.slice(id.length + 1))) {
        recoveryImages.delete(key);
        removedKeys.push(key.slice(id.length + 1));
      }
    }
    return { removedKeys, cleanupError: null };
  };

  const invoke = async (command: string, payload?: unknown): Promise<unknown> => {
    const args = record(payload ?? {});
    check(
      applicationCommands.has(command) || fixturePluginCommands.has(command),
      `unmocked IPC: ${command}`,
    );
    calls.push({ command, args: { ...args } });
    await options.beforeCommand?.(command, args);
    if (command === 'import_dropped_image') {
      const path = string(args.path, 'path');
      check(/^(?:[a-z]:[\\/]|\\\\)/i.test(path), 'drop requires an absolute Windows path');
      check(
        ![...path].some((character) => character.charCodeAt(0) < 32),
        'invalid dropped image path',
      );
      const filename = path.replace(/\\/g, '/').split('/').pop()!;
      const mime = filenameMime(filename);
      check(mime === 'image/png' || mime === 'image/jpeg', 'drop supports PNG/JPEG only');
      const input = binaries.get(path) ?? binaries.get(normalized(path));
      check(input, `missing dropped image: ${path}`);
      const bytes = Uint8Array.from(input);
      check(bytes.length > 0, 'dropped image is empty');
      const dataBase64 = encodeFixtureBytes(bytes);
      check(
        stashBytes + bytes.length <= (options.stashByteLimit ?? LIMITS.imageStashBytes),
        'session stash full',
      );
      check(
        stashes.size < (options.stashEntryLimit ?? LIMITS.imageStashEntries),
        'too many session images',
      );
      const key = token();
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      stashes.set(key, { dataBase64, mime, length: bytes.length });
      stashBytes += bytes.length;
      return {
        key,
        mime,
        filename,
        byteLength: bytes.length,
        digest: [...hash].map((value) => value.toString(16).padStart(2, '0')).join(''),
        previewUrl: `data:${mime};base64,${dataBase64}`,
      };
    }
    if (command === 'stash_image') {
      check(!('data' in args), 'stash accepts dataBase64 only');
      const bytes = decodeFixtureBase64(args.dataBase64);
      const mime = filenameMime(string(args.filename, 'filename'));
      check(
        stashBytes + bytes.length <= (options.stashByteLimit ?? LIMITS.imageStashBytes),
        'session stash full',
      );
      check(
        stashes.size < (options.stashEntryLimit ?? LIMITS.imageStashEntries),
        'too many session images',
      );
      const key = token();
      const dataBase64 = args.dataBase64 as string;
      stashes.set(key, { dataBase64, mime, length: bytes.length });
      stashBytes += bytes.length;
      return { key, mime, previewUrl: `data:${mime};base64,${dataBase64}` };
    }
    if (command === 'read_stashed_image') {
      const image = stashes.get(string(args.key, 'key'));
      check(image, 'unknown session image key');
      return { dataBase64: image.dataBase64, mime: image.mime };
    }
    if (command === 'discard_stashed_images') {
      for (const key of keys(args.keys)) {
        const image = stashes.get(key);
        if (image) {
          stashBytes -= image.length;
          stashes.delete(key);
        }
      }
      return;
    }
    if (command === 'commit_image_assets' || command === 'discard_image_assets') {
      const failures: string[] = [];
      const delegated: string[] = [];
      for (const id of keys(args.allocationIds)) {
        if (delegatedAllocations.has(id)) {
          delegated.push(id);
          continue;
        }
        const allocation = allocations.get(id);
        if (!allocation) continue;
        allocations.delete(id); // even a cleanup failure revokes this token
        if (command === 'discard_image_assets') {
          const current = binaries.get(allocation.path);
          if (
            current !== allocation.identity ||
            encodeFixtureBytes(current ?? []) !== allocation.encoded
          )
            failures.push(allocation.path);
          else binaries.delete(allocation.path);
        }
      }
      if (delegated.length) {
        // A modern scenario returning its own token owns that cleanup behavior.
        // Do not swallow its delayed/failed commit or discard as a generic success.
        await delegate(command, { allocationIds: delegated });
        for (const id of delegated) delegatedAllocations.delete(id);
      }
      check(failures.length === 0, `asset identity changed; retained: ${failures.join(', ')}`);
      return;
    }
    if (options.settingsMode !== 'delegate' && command === 'load_settings') {
      const snapshot = settingsSnapshot();
      await options.beforeLoadSettings?.(structuredClone(snapshot));
      return snapshot;
    }
    if (options.settingsMode !== 'delegate' && command === 'save_settings') {
      const next = jsonValues(args.values);
      const previous = settingsSnapshot();
      check(args.expectedRevision === previous.revision, 'settings revision conflict');
      await options.beforeSaveSettings?.(structuredClone(next), structuredClone(previous));
      check(args.expectedRevision === settingsSnapshot().revision, 'settings changed during save');
      settings.clear();
      for (const [key, value] of Object.entries(next)) settings.set(key, value);
      settingsExists = true;
      return { revision: settingsSnapshot().revision };
    }
    if (command === 'save_image_asset') {
      check(!('data' in args), 'image asset accepts dataBase64 only');
      const bytes = decodeFixtureBase64(args.dataBase64);
      const filename = string(args.filename, 'filename');
      filenameMime(filename);
      let receipt: Record<string, unknown>;
      if (options.fallback) {
        const forwarded = options.legacyImagePayloads ? { ...args, data: [...bytes] } : args;
        const before = new Set(binaries.keys());
        receipt = record(await delegate(command, forwarded));
        if ('allocationId' in receipt) {
          if (receipt.allocationId !== null)
            delegatedAllocations.add(string(receipt.allocationId, 'allocationId'));
          return receipt;
        }
        check(options.legacyImagePayloads, 'asset receipt omitted allocationId');
        const path = string(receipt.path, 'asset path');
        check(!before.has(path), 'legacy asset fixture overwrote an existing path');
        if (!binaries.has(path)) binaries.set(path, [...bytes]);
      } else {
        const parent = `${directory(string(args.docPath, 'docPath'))}/assets`;
        const dot = filename.lastIndexOf('.');
        let selected = filename;
        let path = `${parent}/${selected}`;
        for (let attempt = 0; binaries.has(path); attempt++) {
          check(attempt < 999, 'too many asset collisions');
          const owned = [...allocations.values()].some((allocation) => allocation.path === path);
          if (!owned && encodeFixtureBytes(binaries.get(path)!) === args.dataBase64)
            return {
              filename: selected,
              relativePath: `./assets/${selected}`,
              path,
              allocationId: null,
            };
          selected = `${filename.slice(0, dot)}-${attempt + 1}${filename.slice(dot)}`;
          path = `${parent}/${selected}`;
        }
        binaries.set(path, [...bytes]);
        receipt = { filename: selected, relativePath: `./assets/${selected}`, path };
      }
      const path = string(receipt.path, 'asset path');
      const id = token();
      allocations.set(id, {
        path,
        identity: binaries.get(path)!,
        encoded: args.dataBase64 as string,
      });
      return { ...receipt, allocationId: id };
    }
    // Visibility belongs to the shared window fixture, including older scenarios
    // whose application fallback predates the initial reveal handshake.
    if (command === 'plugin:window|is_visible') return geometry.visible;
    if (command === 'cache_recovery_image') {
      check(!('data' in args) && !('dataBase64' in args), 'recovery image accepts stashKey only');
      const stashed = stashes.get(string(args.stashKey, 'stashKey'));
      check(stashed, 'unknown session image key');
      const bytes = decodeFixtureBase64(stashed.dataBase64);
      const id = string(args.id, 'id');
      const imageKey = retainedRecoveryKeys([args.key])[0];
      const retained = retainedRecoveryKeys(args.retainedKeys);
      if (options.fallback)
        await delegate(command, options.legacyImagePayloads ? { ...args, data: [...bytes] } : args);
      const cleanup = pruneRecoveryImages(id, [...retained, imageKey]);
      const key = `${id}/${imageKey}`;
      const image = { dataBase64: stashed.dataBase64, mime: filenameMime(imageKey) };
      check(image.mime === stashed.mime, 'recovery image type does not match the stash');
      const previous = recoveryImages.get(key);
      check(
        !previous || previous.dataBase64 === image.dataBase64,
        'immutable recovery image changed',
      );
      const total = [...recoveryImages].reduce(
        (size, [cachedKey, cached]) =>
          size +
          (cachedKey.startsWith(`${id}/`) && cachedKey !== key
            ? decodeFixtureBase64(cached.dataBase64).length
            : 0),
        bytes.length,
      );
      check(
        total <= 2 * LIMITS.snapshotImageBytes + LIMITS.textFileBytes + 1024 * 1024,
        'recovery cache full',
      );
      recoveryImages.set(key, image);
      return cleanup;
    }
    if (command === 'write_recovery_snapshot') {
      const snapshot = structuredClone(record(args.snapshot));
      const id = string(snapshot.id, 'id');
      const retained = retainedRecoveryKeys(args.retainedKeys);
      check(
        typeof snapshot.markdown === 'string' &&
          new TextEncoder().encode(snapshot.markdown).length <= LIMITS.textFileBytes,
        'invalid recovery text',
      );
      check(
        Array.isArray(snapshot.images) && snapshot.images.length <= LIMITS.recoveryImages,
        'invalid recovery images',
      );
      let total = 0;
      for (const entry of snapshot.images) {
        const image = recoveryImages.get(`${id}/${string(record(entry).key, 'image key')}`);
        check(image, 'snapshot references uncached image');
        total += decodeFixtureBase64(image.dataBase64).length;
      }
      check(total <= LIMITS.snapshotImageBytes, 'recovery attachment limit');
      if (options.fallback) await delegate(command, args);
      recoverySnapshots.set(id, snapshot);
      return pruneRecoveryImages(id, retained);
    }
    if (options.fallback) {
      const result = await delegate(command, args);
      if (options.legacyImagePayloads && command === 'read_image_file') return compactImage(result);
      if (command === 'read_recovery_snapshot') {
        const restored = record(result);
        check(Array.isArray(restored.images), 'recovery response omitted images');
        const images = restored.images.map((image) =>
          options.legacyImagePayloads ? compactImage(image) : record(image),
        );
        const snapshot = record(restored.snapshot);
        recoverySnapshots.set(String(snapshot.id), structuredClone(snapshot));
        for (const image of images)
          recoveryImages.set(`${snapshot.id}/${image.key}`, {
            dataBase64: String(image.dataBase64),
            mime: String(image.mime),
          });
        return { ...restored, images };
      }
      if (command === 'delete_recovery_snapshot') {
        recoverySnapshots.delete(String(args.id));
        for (const key of recoveryImages.keys())
          if (key.startsWith(`${args.id}/`)) recoveryImages.delete(key);
      }
      if (command === 'plugin:window|show') geometry.visible = true;
      return result;
    }
    // Explicit defaults for ordinary UI fixtures. Unrecognized IPC is always an error.
    switch (command) {
      case 'take_startup_files':
      case 'take_pending_open_files':
        return [];
      case 'list_recovery_snapshots': {
        check(Array.isArray(args.activeIds), 'active recovery ids missing');
        return [...recoverySnapshots.values()]
          .filter((entry) => !(args.activeIds as unknown[]).includes(entry.id))
          .map((entry) => ({
            id: entry.id,
            title: entry.title,
            originalPath: entry.originalPath,
            updatedAt: 1,
            damaged: false,
          }));
      }
      case 'read_recovery_snapshot': {
        const snapshot = recoverySnapshots.get(string(args.id, 'id'));
        check(snapshot, 'unknown recovery snapshot');
        return {
          snapshot: structuredClone(snapshot),
          images: (snapshot.images as unknown[]).map((entry) => {
            const image = record(entry);
            const bytes = recoveryImages.get(`${args.id}/${image.key}`);
            check(bytes, 'missing recovery image');
            return { ...image, ...bytes };
          }),
        };
      }
      case 'delete_recovery_snapshot': {
        const id = string(args.id, 'id');
        recoverySnapshots.delete(id);
        for (const key of recoveryImages.keys())
          if (key.startsWith(`${id}/`)) recoveryImages.delete(key);
        return;
      }
      case 'read_image_file': {
        const path = normalized(
          `${directory(string(args.docPath, 'docPath'))}/${string(args.relativePath, 'relativePath')}`,
        );
        const bytes = binaries.get(path);
        check(bytes, `missing image: ${path}`);
        return {
          path,
          mime: filenameMime(path.split('/').pop()!),
          dataBase64: encodeFixtureBytes(bytes),
        };
      }
      case 'plugin:path|dirname':
        return directory(string(args.path, 'path'));
      case 'plugin:path|join': {
        check(
          Array.isArray(args.paths) && args.paths.every((part) => typeof part === 'string'),
          'invalid joined paths',
        );
        return normalized(args.paths.join('/'));
      }
      case 'plugin:window|inner_size':
        return { width: geometry.width, height: geometry.height };
      case 'plugin:window|outer_position':
        return { x: geometry.x, y: geometry.y };
      case 'plugin:window|is_minimized':
        return geometry.minimized;
      case 'plugin:window|is_maximized':
        return geometry.maximized;
      case 'plugin:window|available_monitors':
        return [];
      case 'plugin:window|set_size':
      case 'plugin:window|set_position': {
        const value = record(JSON.parse(JSON.stringify(args.value)));
        Object.assign(geometry, record(value.Physical ?? value.Logical ?? value));
        return;
      }
      case 'plugin:window|show':
        geometry.visible = true;
        return;
      case 'plugin:window|set_focus':
        return;
      case 'plugin:window|unminimize':
        geometry.minimized = false;
        return;
      case 'plugin:window|minimize':
        geometry.minimized = true;
        return;
      case 'plugin:window|maximize':
        geometry.maximized = true;
        return;
      case 'plugin:window|unmaximize':
        geometry.maximized = false;
        return;
      case 'plugin:window|toggle_maximize':
        geometry.maximized = !geometry.maximized;
        return;
      case 'plugin:window|destroy':
        geometry.destroyed = true;
        return;
      case 'plugin:dialog|open':
      case 'plugin:dialog|save':
        return null;
      case 'plugin:dialog|message':
        return args.buttons === 'YesNo' ? 'No' : 'Ok';
      default:
        throw new Error(`Native fixture: unmocked IPC: ${command}`);
    }
  };
  return {
    invoke,
    settings,
    binaries,
    stashes,
    allocations,
    recoveryImages,
    recoverySnapshots,
    calls,
    geometry,
    get stashBytes() {
      return stashBytes;
    },
    install() {
      mockWindows('main');
      Object.assign(globalThis, { isTauri: true });
      mockIPC(invoke, { shouldMockEvents: true });
    },
  };
}
