import { beforeEach, describe, expect, it, vi } from 'vitest';
import contract from '../src-tauri/src/file_contract.json';

const invoke = vi.hoisted(() => vi.fn());
const open = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open, save: vi.fn() }));
import {
  documentRevision,
  readDocument,
  writeDocument,
  pickImageFiles,
  type DocumentSnapshot,
  type WriteReceipt,
} from '../src/lib/fileOps';
import { errorMessage } from '../src/lib/errors';

beforeEach(() => vi.resetAllMocks());

describe('native document IPC contract', () => {
  it.each([null, 'C:/images/中文.png', ['C:/images/2.jpg', 'C:/images/1.png']])(
    'accepts image selection or cancellation: %j',
    async (selected) => {
      open.mockResolvedValue(selected);
      expect(await pickImageFiles()).toEqual(
        selected === null ? [] : Array.isArray(selected) ? selected : [selected],
      );
      expect(open).toHaveBeenCalledWith({
        multiple: true,
        directory: false,
        title: '插入本地图片',
        filters: [{ name: 'PNG / JPEG 图片', extensions: ['png', 'jpg', 'jpeg'] }],
      });
      expect(invoke).not.toHaveBeenCalled();
    },
  );
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
  it('shows readable retained-copy paths while preserving the canonical IPC failure', async () => {
    const path = '\\\\?\\E:\\桌面\\降智题.md';
    const recoveryPath = '\\\\?\\E:\\桌面\\降智题.local.md';
    const backupPath = '\\\\?\\UNC\\Server\\笔记\\降智题.backup.md';
    const failure = {
      message: `副本：${recoveryPath}；备份：${backupPath}`,
      recoveryPath,
      backupPath,
      writeState: 'unknown',
    };
    invoke.mockRejectedValue(failure);
    await expect(writeDocument(path, 'local edit', 'old')).rejects.toBe(failure);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('write_document', {
      path,
      content: 'local edit',
      expectedRevision: 'old',
    });
    const message = errorMessage(failure);
    expect(message).toContain('副本：E:\\桌面\\降智题.local.md');
    expect(message).toContain('备份：\\\\Server\\笔记\\降智题.backup.md');
    expect(message).toContain('本地编辑副本：E:\\桌面\\降智题.local.md');
    expect(message).toContain('原磁盘版本：\\\\Server\\笔记\\降智题.backup.md');
    expect(message).not.toContain('\\\\?\\');
    expect(errorMessage(new Error(failure.message))).toBe(message.split('\n')[0]);
    expect(errorMessage(failure.message)).toBe(message.split('\n')[0]);
    expect(failure.recoveryPath).toBe(recoveryPath);
    expect(failure.backupPath).toBe(backupPath);
  });
});
