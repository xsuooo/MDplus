import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import contract from '../src-tauri/src/file_contract.json';
import capability from '../src-tauri/capabilities/default.json';
import config from '../config/application.json';
import tauri from '../src-tauri/tauri.conf.json';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const commands = Object.keys(contract['x-commands']).sort();

describe('IPC allowlist and contract synchronization', () => {
  it('registers exactly the documented and main-window-allowed commands', () => {
    const catalog = [...read('../src-tauri/src/ipc_commands.rs').matchAll(/"([a-z_]+)"/g)]
      .map((match) => match[1])
      .sort();
    const handler = read('../src-tauri/src/lib.rs')
      .match(/generate_handler!\[([\s\S]*?)\]/)![1]
      .split(',')
      .map((entry) => entry.trim().split('::').pop()!)
      .filter(Boolean)
      .sort();
    const allowed = capability.permissions
      .filter((name) => name.startsWith('allow-'))
      .map((name) => name.slice('allow-'.length).replaceAll('-', '_'))
      .sort();
    expect(catalog).toEqual(commands);
    expect(handler).toEqual(commands);
    expect(allowed).toEqual(commands);
    expect(capability.windows).toEqual(['main']);
    expect(capability).not.toHaveProperty('remote');
    expect(read('../src-tauri/build.rs')).toContain('.commands(ipc_commands::COMMANDS)');
  });

  it('keeps each native request parameter aligned with the JSON contract', () => {
    const source = [
      'lib.rs',
      'safe_files.rs',
      'recovery.rs',
      'settings.rs',
      'image_stash.rs',
      'image_import.rs',
    ]
      .map((file) => read(`../src-tauri/src/${file}`))
      .join('\n');
    const native = [
      ...source.matchAll(
        /#\[tauri::command(?:\(async\))?\]\s+(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(([\s\S]*?)\)\s*->/g,
      ),
    ];
    expect(native).toHaveLength(commands.length);
    for (const [, name, args] of native) {
      const fields = [...args.matchAll(/(?:^|,)\s*(\w+)\s*:/g)]
        .map((match) => match[1])
        .filter((field) => !['app', 'state'].includes(field))
        .map((field) => field.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()))
        .sort();
      const command = contract['x-commands'][name as keyof (typeof contract)['x-commands']];
      const schema =
        contract.$defs[command.request.split('/').pop() as keyof typeof contract.$defs];
      expect(schema).toHaveProperty('additionalProperties', false);
      expect(fields).toEqual(Object.keys((schema as { properties: object }).properties).sort());
    }
  });

  it('does not expose legacy arbitrary filesystem or Store-loading commands', () => {
    for (const name of [
      'read_file',
      'write_file',
      'file_mtime',
      'create_directory',
      'save_binary_file',
    ]) {
      expect(commands).not.toContain(name);
    }
    for (const name of [
      'store:default',
      'store:allow-load',
      'store:allow-get-store',
      'opener:default',
    ]) {
      expect(capability.permissions).not.toContain(name);
    }
  });

  it('keeps generated port and IPC capacities aligned with shared configuration', () => {
    expect(tauri.build.devUrl).toBe(`http://${config.development.host}:${config.development.port}`);
    for (const name of [
      'ImageRequest',
      'ImageFile',
      'RestoredImage',
      'StashImageRequest',
      'StashedImage',
    ] as const) {
      const schema = contract.$defs[name];
      expect(schema.properties).not.toHaveProperty('data');
      expect(schema.properties.dataBase64.type).toBe('string');
      expect(schema.properties.dataBase64.maxLength).toBe(
        Math.ceil(config.limits.imageFileBytes / 3) * 4,
      );
    }
    expect(config.limits.textFileBytes).toBe(32 * 1024 * 1024);
    expect(contract.$defs.RecoveryImageRequest.required).toEqual([
      'id',
      'key',
      'stashKey',
      'retainedKeys',
    ]);
    expect(contract.$defs.RecoveryImageRequest.properties).not.toHaveProperty('dataBase64');
    expect(contract.$defs.RecoveryImageRequest.properties.stashKey.pattern).toBe('^[0-9a-f]{32}$');
    expect(config.limits.htmlExportBytes).toBeGreaterThan(35_891_148);
    expect(contract.$defs.RecoverySnapshot.properties.images.maxItems).toBe(
      config.limits.recoveryImages,
    );
    expect(contract.$defs.RecoveryRetainedKeys.maxItems).toBe(config.limits.imageStashEntries);
    expect(contract.$defs.RecoverySnapshot.properties).not.toHaveProperty('retainedKeys');
  });
});
