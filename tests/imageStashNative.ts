import { createHash } from 'node:crypto';
import path from 'node:path';

/** The structured rejection of the native stash once its quota is exhausted. */
export const STASH_FULL = {
  code: 'STASH_FULL',
  message: '图片暂存空间已满，已有图片未受影响。请关闭其他含图片的文稿后重试',
};
export const notePath = 'C:\\notes\\note.md';
export const otherPath = 'D:\\other\\note.md';
export const fileA = 'C:\\notes\\img\\a.png';
export const fileB = 'C:\\notes\\img\\b.png';
export const A = [65, 66, 67];
export const B = [88, 89, 90];
export const C = [48, 49, 50];
export const one = '![a](./img/a.png)';
export const both = `${one}\n\n![b](./img/b.png)`;
export const previewA = 'http://mdplus-image-stash.localhost/stash-1';
export const base64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');
export const sha256 = (bytes: number[]) =>
  createHash('sha256').update(Buffer.from(bytes)).digest('hex');

interface Snapshot {
  id: string;
  markdown: string;
  images: { placeholder: string; filename: string; key: string }[];
}

/** A native double that owns bytes the way the real stash, asset and recovery stores do. */
export function createNative() {
  const files = new Map<string, number[]>([
    [fileA, A],
    [fileB, B],
  ]);
  const documents = new Map<string, { content: string; revision: string; mtime: number }>();
  const stash = new Map<string, string>();
  const assets = new Map<string, { path: string; dataBase64: string }>();
  const recovery = new Map<string, string>();
  const snapshots: Snapshot[] = [];
  const state = { full: false, stashFailure: null as unknown };
  const cleanup = { removedKeys: [], cleanupError: null };
  const resolve = (docPath: string, relativePath: string) =>
    path.win32.join(path.win32.dirname(docPath), relativePath);
  let stashed = 0;
  let allocated = 0;
  const invoke = async (command: string, args: any): Promise<unknown> => {
    switch (command) {
      case 'document_revision': {
        const saved = documents.get(args.path);
        return { path: args.path, revision: saved?.revision ?? null, mtime: saved?.mtime ?? null };
      }
      case 'write_document': {
        const saved = documents.get(args.path);
        if ((saved?.revision ?? null) !== args.expectedRevision) throw 'document changed on disk';
        const mtime = (saved?.mtime ?? 0) + 1;
        const revision = `rev-${mtime}`;
        documents.set(args.path, { content: args.content, revision, mtime });
        return { path: args.path, revision, mtime, backupPath: null };
      }
      case 'read_image_file': {
        const file = resolve(args.docPath, args.relativePath);
        const bytes = files.get(file);
        if (!bytes) throw 'path is not a regular file';
        return { path: file, mime: 'image/png', dataBase64: base64(bytes) };
      }
      case 'stash_image': {
        if (state.stashFailure) throw state.stashFailure;
        if (state.full) throw STASH_FULL;
        const key = `stash-${++stashed}`;
        stash.set(key, args.dataBase64);
        return {
          key,
          mime: 'image/png',
          previewUrl: `http://mdplus-image-stash.localhost/${key}`,
        };
      }
      case 'read_stashed_image': {
        const dataBase64 = stash.get(args.key);
        if (dataBase64 === undefined) throw 'unknown session image key';
        return { mime: 'image/png', dataBase64 };
      }
      case 'discard_stashed_images':
        for (const key of args.keys) stash.delete(key);
        return;
      case 'save_image_asset': {
        const allocationId = `allocation-${++allocated}`;
        const filename = `${allocated}-${args.filename}`;
        const file = resolve(args.docPath, `assets\\${filename}`);
        assets.set(allocationId, { path: file, dataBase64: args.dataBase64 });
        files.set(file, [...Buffer.from(args.dataBase64, 'base64')]);
        return { filename, relativePath: `./assets/${filename}`, path: file, allocationId };
      }
      case 'commit_image_assets':
        return;
      case 'discard_image_assets':
        for (const id of args.allocationIds) {
          files.delete(assets.get(id)?.path ?? '');
          assets.delete(id);
        }
        return;
      case 'cache_recovery_image': {
        const dataBase64 = stash.get(args.stashKey);
        if (dataBase64 === undefined) throw 'unknown session image key';
        recovery.set(`${args.id}/${args.key}`, dataBase64);
        return cleanup;
      }
      case 'cache_recovery_document_image': {
        const bytes = files.get(resolve(args.docPath, args.relativePath));
        if (!bytes) throw 'path is not a regular file';
        if (sha256(bytes) !== args.digest) throw 'image changed after it was prepared';
        recovery.set(`${args.id}/${args.key}`, base64(bytes));
        return cleanup;
      }
      case 'write_recovery_snapshot':
        snapshots.push(args.snapshot);
        return cleanup;
      case 'read_recovery_snapshot': {
        const snapshot = snapshots.filter((candidate) => candidate.id === args.id).at(-1);
        if (!snapshot) throw 'recovery snapshot not found';
        return {
          snapshot,
          images: snapshot.images.map((image) => ({
            ...image,
            mime: 'image/png',
            dataBase64: recovery.get(`${args.id}/${image.key}`),
          })),
        };
      }
      case 'list_recovery_snapshots':
        return [];
      case 'delete_recovery_snapshot':
        return;
      default:
        throw new Error(`Unexpected IPC: ${command}`);
    }
  };
  return { files, documents, stash, assets, recovery, snapshots, state, invoke };
}
