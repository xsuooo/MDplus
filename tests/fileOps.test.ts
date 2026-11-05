import { beforeEach, describe, expect, it, vi } from 'vitest';
import contract from '../src-tauri/src/file_contract.json';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import {
  documentRevision,
  readDocument,
  writeDocument,
  type DocumentSnapshot,
  type WriteReceipt,
} from '../src/lib/fileOps';
import { errorMessage } from '../src/lib/errors';

beforeEach(() => vi.resetAllMocks());

describe('native document IPC contract', () => {
  it('reads the content and revision together with the canonical response keys', async () => {
    const snapshot: DocumentSnapshot = {
      path: 'C:/notes/note.md',
      content: '# Original\n',
      revision: 'opaque-byte-revision',
      mtime: 123,
    };
    expect(Object.keys(snapshot).sort()).toEqual(
      [...contract.$defs.DocumentSnapshot.required].sort(),
    );
    invoke.mockResolvedValue(snapshot);
    expect(await readDocument('C:/notes/note.md')).toBe(snapshot);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('read_document', { path: 'C:/notes/note.md' });
  });

  it('preserves the explicit missing-target response without inventing a timestamp', async () => {
    invoke.mockResolvedValue({ path: 'C:/notes/new.md', revision: null, mtime: null });
    expect(await documentRevision('C:/notes/new.md')).toEqual({
      path: 'C:/notes/new.md',
      revision: null,
      mtime: null,
    });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('document_revision', {
      path: 'C:/notes/new.md',
    });
  });

  it.each([null, 'opaque-byte-revision'])(
    'sends the expected revision unchanged: %s',
    async (expectedRevision) => {
      const receipt: WriteReceipt = {
        path: 'C:/notes/note.md',
        revision: 'written-byte-revision',
        mtime: 456,
        backupPath: null,
      };
      expect(Object.keys(receipt).sort()).toEqual([...contract.$defs.WriteReceipt.required].sort());
      invoke.mockResolvedValue(receipt);
      expect(await writeDocument('C:/notes/note.md', 'local edit', expectedRevision)).toBe(receipt);
      expect(invoke).toHaveBeenCalledExactlyOnceWith('write_document', {
        path: 'C:/notes/note.md',
        content: 'local edit',
        expectedRevision,
      });
    },
  );

  it.each(contract.$defs.FileError.properties.code.enum)(
    'does not retry or discard a structured %s error',
    async (code) => {
      const failure = {
        code,
        message: 'Review the retained copies',
        path: 'C:/notes/note.md',
        recoveryPath: 'C:/notes/local-draft.md',
        backupPath: 'C:/notes/external-version.md',
        actualRevision: 'external',
        writeState: 'unknown',
      };
      expect(Object.keys(failure).sort()).toEqual([...contract.$defs.FileError.required].sort());
      invoke.mockRejectedValue(failure);
      await expect(writeDocument('C:/notes/note.md', 'local edit', 'old')).rejects.toBe(failure);
      expect(invoke).toHaveBeenCalledTimes(1);
      const message = errorMessage(failure);
      expect(message).toContain('local-draft.md');
      expect(message).toContain('external-version.md');
      expect(message).toContain('请勿直接再次覆盖');
    },
  );
});
