import { renderToStaticMarkup } from 'react-dom/server';
import type { Editor } from '@milkdown/kit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tab, EditorUpdate } from '../src/lib/types';
import { computeStats } from '../src/lib/stats';

const mocks = vi.hoisted(() => ({
  initialTab: null as Tab | null,
  toolbar: {} as Record<string, () => Promise<void> | void>,
  close: null as ((id: string) => void) | null,
  edit: null as (() => void) | null,
  notify: null as ((update: EditorUpdate, isInitial?: boolean) => void) | null,
  confirmClose: null as ((action: 'save' | 'discard' | 'cancel') => void) | null,
  refs: [] as { current: unknown }[],
  pickSaveFile: vi.fn(),
  fileMtime: vi.fn(),
  documentRevision: vi.fn(),
  readDocument: vi.fn(),
  writeDocument: vi.fn(),
  writeFile: vi.fn(),
  legacyWriteFile: vi.fn(),
  diskFiles: new Set<string>(),
  prepareImageReferences: vi.fn(),
  migratePendingImages: vi.fn(),
  commitImageMigration: vi.fn(),
  finalizeImageMigration: vi.fn(),
  setMarkdown: vi.fn(),
  confirmDialog: vi.fn(),
  showMessage: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  // Exercise App's actual handlers without mounting a WebView or running startup effects.
  return {
    ...react,
    useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, vi.fn()],
    useRef: (initial: unknown) => {
      const ref = { current: initial };
      mocks.refs.push(ref);
      return ref;
    },
    useEffect: () => {},
    useLayoutEffect: () => {},
  };
});
// Seed the public session hook instead of relying on App's useState declaration order.
vi.mock('../src/hooks/useDocumentSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/hooks/useDocumentSession')>();
  return { ...actual, useDocumentSession: () => actual.useDocumentSession([mocks.initialTab!]) };
});
vi.mock('../src/hooks/useDocumentClose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/hooks/useDocumentClose')>();
  return {
    ...actual,
    useDocumentClose: (...args: Parameters<typeof actual.useDocumentClose>) => {
      const close = actual.useDocumentClose(...args);
      mocks.confirmClose = close.confirmClose;
      return close;
    },
  };
});
vi.mock('../src/components/Toolbar', () => ({
  Toolbar: (props: Record<string, () => Promise<void> | void>) => {
    mocks.toolbar = props;
    return null;
  },
}));
vi.mock('../src/components/TabBar', () => ({
  TabBar: (props: { onClose: (id: string) => void }) => {
    mocks.close = props.onClose;
    return null;
  },
}));
vi.mock('../src/components/CloseConfirmModal', () => ({
  CloseConfirmModal: (props: { onConfirm: (action: 'save' | 'discard' | 'cancel') => void }) => {
    mocks.confirmClose = props.onConfirm;
    return null;
  },
}));
vi.mock('../src/components/EditorTab', () => ({
  EditorTab: (props: {
    tabId: string;
    onUpdate: (id: string, update: EditorUpdate, isInitial?: boolean) => void;
    onRegister: (id: string, editor: Editor | null) => void;
  }) => {
    props.onRegister(props.tabId, {} as Editor);
    mocks.notify = (update, isInitial = false) => props.onUpdate(props.tabId, update, isInitial);
    mocks.edit = () =>
      props.onUpdate(props.tabId, {
        markdown: 'newer',
        outline: [],
        stats: { chars: 5, words: 1, lines: 1 },
        canUndo: true,
        canRedo: false,
      });
    return null;
  },
}));
vi.mock('../src/lib/editor', () => ({
  setMarkdown: mocks.setMarkdown,
  undo: vi.fn(),
  redo: vi.fn(),
}));
vi.mock('../src/lib/mermaid', () => ({ refreshMermaidTheme: vi.fn() }));
vi.mock('../src/lib/store', () => ({
  getRecentFiles: async () => [],
  pushRecentFile: async () => {},
  removeRecentFile: async () => {},
  getThemeMode: async () => 'light',
  setThemeMode: async () => {},
  getSourceModePref: async () => false,
  setSourceModePref: async () => {},
  getWindowState: async () => null,
  setWindowState: async () => {},
  getOutlineOpen: async () => false,
  setOutlineOpen: async () => {},
}));
vi.mock('../src/lib/fileOps', () => ({
  pickSaveFile: mocks.pickSaveFile,
  fileMtime: mocks.fileMtime,
  writeFile: mocks.legacyWriteFile,
  documentRevision: mocks.documentRevision,
  readDocument: mocks.readDocument,
  writeDocument: mocks.writeDocument,
  readFile: vi.fn(),
  pickOpenFile: vi.fn(),
  basename: (value: string) => value.split(/[\\/]/).pop(),
}));
vi.mock('../src/lib/imageOps', () => ({
  prepareImageReferences: mocks.prepareImageReferences,
  migratePendingImages: mocks.migratePendingImages,
  commitImageMigration: mocks.commitImageMigration,
  finalizeImageMigration: mocks.finalizeImageMigration,
  clearPendingImages: vi.fn(),
  saveImage: vi.fn(),
  loadImageReferences: vi.fn(),
}));
vi.mock('../src/lib/dialog', () => ({
  confirmDialog: mocks.confirmDialog,
  showMessage: mocks.showMessage,
}));

import App from '../src/App';

function tabState(): Tab {
  const ref = mocks.refs.find(
    (ref) => Array.isArray(ref.current) && (ref.current as Tab[])[0]?.id === 'tab',
  );
  return (ref!.current as Tab[])[0];
}

async function settle() {
  // Native identity validation and the preparation barrier add queued Promise jobs.
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.refs = [];
  mocks.initialTab = {
    id: 'tab',
    title: 'note.md',
    path: 'C:/notes/note.md',
    isNew: false,
    dirty: true,
    externalMtime: 100,
    externalChanged: false,
    diskRevision: 'rev-100',
    markdown: 'current',
    savedContent: 'previous',
    initialContent: 'previous',
    stats: { chars: 7, words: 1, lines: 1 },
  };
  mocks.pickSaveFile.mockResolvedValue('D:/new/note.md');
  mocks.fileMtime.mockResolvedValue(100);
  mocks.diskFiles.clear();
  mocks.diskFiles.add('C:/notes/note.md');
  mocks.documentRevision.mockImplementation(async (path: string) => {
    if (!mocks.diskFiles.has(path)) return { path, revision: null, mtime: null };
    const mtime = await mocks.fileMtime(path);
    return { path, revision: `rev-${mtime}`, mtime };
  });
  // Keep the existing asynchronous disk-write probes, while checking the new IPC entry separately.
  mocks.writeFile.mockResolvedValue(undefined);
  mocks.legacyWriteFile.mockImplementation((path: string, content: string) =>
    mocks.writeFile(path, content),
  );
  mocks.writeDocument.mockImplementation(async (path: string, content: string) => {
    await mocks.writeFile(path, content);
    mocks.diskFiles.add(path);
    return { path, revision: 'rev-100', mtime: 100, backupPath: null };
  });
  mocks.prepareImageReferences.mockImplementation(async (_id: string, markdown: string) => ({
    markdown,
    commit: () => true,
    dispose: async () => {},
  }));
  mocks.finalizeImageMigration.mockResolvedValue(undefined);
  mocks.migratePendingImages.mockImplementation(
    async (_id: string, _path: string, markdown: string) => ({
      markdown,
      updates: [],
    }),
  );
  mocks.confirmDialog.mockResolvedValue(false);
  mocks.showMessage.mockResolvedValue(undefined);
  renderToStaticMarkup(<App />);
  mocks.close!('tab');
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('App save entry points', () => {
  it('coalesces input image preparation without parsing in the input handler', async () => {
    for (const markdown of [
      'first ![](./img/a.png)',
      'second ![](./img/b.png)',
      'latest ![](./img/c.png)',
    ]) {
      mocks.notify!({
        markdown,
        outline: [],
        stats: computeStats(markdown),
        canUndo: true,
        canRedo: false,
      });
    }
    await settle();
    expect(mocks.prepareImageReferences).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(149);
    expect(mocks.prepareImageReferences).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.prepareImageReferences).toHaveBeenCalledExactlyOnceWith(
      'tab',
      'latest ![](./img/c.png)',
      'C:/notes/note.md',
    );
  });

  it('flushes the latest scheduled image preparation when saving immediately', async () => {
    mocks.edit!();
    expect(mocks.prepareImageReferences).not.toHaveBeenCalled();
    await mocks.toolbar.onSave();
    await settle();
    expect(mocks.prepareImageReferences).toHaveBeenCalledExactlyOnceWith(
      'tab',
      'newer',
      'C:/notes/note.md',
    );
    expect(mocks.writeDocument).toHaveBeenCalledExactlyOnceWith(
      'C:/notes/note.md',
      'newer',
      'rev-100',
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(mocks.prepareImageReferences).toHaveBeenCalledOnce();
  });

  it('cancels queued image reads when discarding the tab', async () => {
    mocks.edit!();
    mocks.confirmClose!('discard');
    await settle();
    await vi.advanceTimersByTimeAsync(150);
    expect(mocks.prepareImageReferences).not.toHaveBeenCalled();
  });

  it.each([
    ['existing image', '![](./img/pic.png)\n', '![](./img/pic.png)\nnewer text'],
    ['new image', 'current', 'current\n![new][ref]\n\n[ref]: <./img/new photo.png>'],
    ['edit then undo', '![](./img/pic.png)\n', '![](./img/pic.png)\n'],
  ])(
    'keeps the original base and cancels queued saves after concurrent SaveAs with %s',
    async (_name, original, newer) => {
      const update = (markdown: string) =>
        mocks.notify!({
          markdown,
          outline: [],
          stats: computeStats(markdown),
          canUndo: true,
          canRedo: false,
        });
      update(original);
      let release!: () => void;
      mocks.writeFile.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      mocks.toolbar.onSaveAs();
      await settle();
      expect(mocks.writeFile).toHaveBeenCalledTimes(1);
      if (_name === 'edit then undo') update(original + 'temporary edit');
      update(newer);
      mocks.toolbar.onSave();
      release();
      await settle();
      expect(tabState().path).toBe('C:/notes/note.md');
      expect(tabState().markdown).toBe(newer);
      expect(tabState().dirty).toBe(true);
      expect(mocks.writeFile).toHaveBeenCalledTimes(1);
      expect(mocks.commitImageMigration).not.toHaveBeenCalled();
      expect(
        mocks.showMessage.mock.calls.some(([message]) => String(message).includes('副本已写入')),
      ).toBe(true);
    },
  );

  it('does not automatically retry a disk conflict after the user cancels a manual overwrite', async () => {
    mocks.fileMtime.mockResolvedValue(200);
    mocks.toolbar.onSave();
    await settle();
    expect(mocks.confirmDialog).toHaveBeenCalledTimes(1);
    const reads = mocks.fileMtime.mock.calls.length;
    mocks.edit!();
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.fileMtime).toHaveBeenCalledTimes(reads);
    expect(mocks.writeDocument).not.toHaveBeenCalled();
  });

  it.each(['onSave', 'onSaveAs'])(
    'waits for current image bytes before migrating through %s',
    async (action) => {
      let release!: (value: {
        markdown: string;
        commit: () => boolean;
        dispose: () => Promise<void>;
      }) => void;
      const commit = vi.fn(() => true);
      mocks.prepareImageReferences.mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      mocks.toolbar[action]();
      await settle();
      expect(mocks.prepareImageReferences).toHaveBeenCalledWith(
        'tab',
        'current',
        'C:/notes/note.md',
      );
      expect(mocks.migratePendingImages).not.toHaveBeenCalled();
      expect(mocks.writeDocument).not.toHaveBeenCalled();
      release({ markdown: 'current', commit, dispose: async () => {} });
      await settle();
      expect(commit).toHaveBeenCalledTimes(1);
      expect(mocks.writeDocument).toHaveBeenCalledTimes(1);
      expect(commit.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.migratePendingImages.mock.invocationCallOrder[0],
      );
    },
  );

  it('does not publish old image bytes or save after an edit during preparation', async () => {
    let release!: (value: {
      markdown: string;
      commit: () => boolean;
      dispose: () => Promise<void>;
    }) => void;
    const commit = vi.fn(() => true);
    mocks.prepareImageReferences.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    mocks.toolbar.onSave();
    await settle();
    expect(mocks.prepareImageReferences).toHaveBeenCalledTimes(1);
    mocks.edit!();
    release({ markdown: 'current', commit, dispose: async () => {} });
    await settle();
    expect(commit).not.toHaveBeenCalled();
    expect(mocks.writeDocument).not.toHaveBeenCalled();
    expect(tabState().markdown).toBe('newer');
    expect(tabState().dirty).toBe(true);
  });

  it('cancels a save when the image cache invalidates the prepared result', async () => {
    mocks.prepareImageReferences.mockResolvedValueOnce({
      markdown: 'current',
      commit: () => false,
      dispose: async () => {},
    });
    mocks.toolbar.onSave();
    await settle();
    expect(mocks.migratePendingImages).not.toHaveBeenCalled();
    expect(mocks.writeDocument).not.toHaveBeenCalled();
    expect(tabState().dirty).toBe(true);
  });
  it.each(['onSave', 'onSaveAs'])(
    'commits image sources before refreshing the editor through %s',
    async (action) => {
      mocks.migratePendingImages.mockResolvedValue({
        markdown: '![](./assets/pic.png)',
        updates: [],
      });
      mocks.toolbar[action]();
      await settle();
      expect(mocks.commitImageMigration).toHaveBeenCalledTimes(1);
      expect(mocks.setMarkdown).toHaveBeenCalledWith(
        expect.anything(),
        '![](./assets/pic.png)',
        false,
      );
      expect(mocks.commitImageMigration.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.setMarkdown.mock.invocationCallOrder[0],
      );
      expect(tabState().dirty).toBe(false);
    },
  );

  it('queues SaveAs behind an in-flight save without overlapping writes', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.writeFile.mockImplementationOnce(async () => blocked);
    mocks.toolbar.onSave();
    await settle();
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    mocks.toolbar.onSaveAs();
    await settle();
    expect(mocks.pickSaveFile).not.toHaveBeenCalled();
    release();
    await settle();
    expect(mocks.writeFile).toHaveBeenCalledTimes(2);
    expect(mocks.writeFile.mock.calls.map(([path]) => path)).toEqual([
      'C:/notes/note.md',
      'D:/new/note.md',
    ]);
  });

  it('queues a newer save behind SaveAs and uses the updated document path', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.writeFile.mockImplementationOnce(async () => blocked);
    mocks.toolbar.onSaveAs();
    await settle();
    mocks.edit!();
    mocks.toolbar.onSave();
    await settle();
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    release();
    await settle();
    expect(mocks.writeFile.mock.calls).toEqual([
      ['D:/new/note.md', 'current'],
      ['D:/new/note.md', 'newer'],
    ]);
  });

  it('checks external conflicts when SaveAs selects the current file', async () => {
    mocks.pickSaveFile.mockResolvedValue('C:/notes/note.md');
    mocks.fileMtime.mockResolvedValue(200);
    mocks.toolbar.onSaveAs();
    await settle();
    expect(mocks.confirmDialog).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('cancels a queued SaveAs after the tab is removed', async () => {
    let release!: () => void;
    mocks.writeFile.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    mocks.toolbar.onSave();
    await settle();
    mocks.toolbar.onSaveAs();
    tabState().dirty = false;
    mocks.close!('tab');
    release();
    await settle();
    expect(mocks.pickSaveFile).not.toHaveBeenCalled();
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
  });

  it('does not commit image source paths after a failed write', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.writeFile.mockRejectedValue(new Error('disk full'));
    try {
      mocks.toolbar.onSaveAs();
      await settle();
      expect(mocks.commitImageMigration).not.toHaveBeenCalled();
      expect(tabState().path).toBe('C:/notes/note.md');
      expect(mocks.showMessage).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it('queues close-and-save through the same save entry point', async () => {
    let release!: () => void;
    mocks.pickSaveFile.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('D:/first/note.md');
        }),
    );
    tabState().path = null;
    mocks.toolbar.onSaveAs();
    await settle();
    mocks.confirmClose!('save');
    await settle();
    expect(mocks.pickSaveFile).toHaveBeenCalledTimes(1);
    release();
    await settle();
    expect(mocks.pickSaveFile).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).toHaveBeenCalledTimes(2);
  });
});

describe('App save conflicts during asset migration', () => {
  it('does not overwrite an external edit made while images are being saved', async () => {
    mocks.migratePendingImages.mockImplementationOnce(
      async (_id: string, _path: string, markdown: string) => {
        mocks.fileMtime.mockResolvedValue(200);
        return { markdown, updates: [] };
      },
    );
    await mocks.toolbar.onSave();
    await settle();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(tabState().dirty).toBe(true);
    expect(mocks.commitImageMigration).not.toHaveBeenCalled();
    expect(mocks.showMessage).toHaveBeenCalled();
  });
});

describe('App document revision contract', () => {
  it('saves through the conditional document command, never the legacy writer', async () => {
    await mocks.toolbar.onSave();
    await settle();
    expect(mocks.writeDocument).toHaveBeenCalledExactlyOnceWith(
      'C:/notes/note.md',
      'current',
      'rev-100',
    );
    expect(mocks.legacyWriteFile).not.toHaveBeenCalled();
  });

  it('detects different disk bytes even when their modification time is unchanged', async () => {
    mocks.documentRevision.mockResolvedValue({
      path: 'C:/notes/note.md',
      revision: 'different-bytes',
      mtime: 100,
    });
    await mocks.toolbar.onSave();
    await settle();
    expect(mocks.confirmDialog).toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(tabState().dirty).toBe(true);
  });

  it('keeps the draft dirty and does not use an unsafe fallback after a native conflict', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.writeDocument.mockRejectedValueOnce({
      code: 'CONFLICT',
      message: 'external edit',
      path: 'C:/notes/note.md',
      recoveryPath: 'C:/notes/local-draft.md',
      backupPath: 'C:/notes/external-version.md',
      actualRevision: 'new',
      writeState: 'unchanged',
    });
    try {
      await mocks.toolbar.onSave();
      await settle();
      expect(tabState().dirty).toBe(true);
      expect(tabState().savedContent).toBe('previous');
      expect(mocks.legacyWriteFile).not.toHaveBeenCalled();
      expect(mocks.commitImageMigration).not.toHaveBeenCalled();
      expect(mocks.showMessage).toHaveBeenCalledWith(
        expect.stringContaining('local-draft.md'),
        'error',
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it('uses the verified write receipt instead of pairing saved bytes with a later disk timestamp', async () => {
    mocks.writeDocument.mockResolvedValueOnce({
      path: 'C:/notes/note.md',
      revision: 'written-bytes',
      mtime: 123,
      backupPath: null,
    });
    await mocks.toolbar.onSave();
    await settle();
    expect(tabState().diskRevision).toBe('written-bytes');
    expect(tabState().externalMtime).toBe(123);
    expect(tabState().savedContent).toBe('current');
  });

  it('creates a SaveAs target only against an explicitly missing revision', async () => {
    await mocks.toolbar.onSaveAs();
    await settle();
    expect(mocks.writeDocument).toHaveBeenCalledExactlyOnceWith('D:/new/note.md', 'current', null);
    expect(mocks.legacyWriteFile).not.toHaveBeenCalled();
  });
});

describe.each(['onSave', 'onSaveAs'])('asset ownership around %s', (action) => {
  const failures = [
    {
      name: 'known unchanged write',
      error: { message: 'conflict', writeState: 'unchanged' },
      state: 'unchanged',
    },
    {
      name: 'committed but unverified write',
      error: { message: 'verify failed', writeState: 'committed' },
      state: 'committed',
    },
    {
      name: 'unknown native outcome',
      error: { message: 'replacement uncertain', writeState: 'unknown' },
      state: 'unknown',
    },
    {
      name: 'transport failure without a receipt',
      error: new Error('IPC disconnected'),
      state: 'unknown',
    },
  ];
  it.each(failures)(
    'finalizes a $name without deleting possibly committed assets',
    async ({ error, state }) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const migration = { markdown: 'current', updates: [], allocationIds: ['owned'] };
      mocks.migratePendingImages.mockResolvedValueOnce(migration);
      mocks.writeDocument.mockRejectedValueOnce(error);
      try {
        mocks.toolbar[action]();
        await settle();
        expect(mocks.finalizeImageMigration).toHaveBeenCalledExactlyOnceWith(migration, state);
        expect(mocks.commitImageMigration).not.toHaveBeenCalled();
        expect(tabState().dirty).toBe(true);
      } finally {
        log.mockRestore();
      }
    },
  );

  it('commits ownership after a verified receipt and clears retained-local protection', async () => {
    const migration = { markdown: 'current', updates: [], allocationIds: ['owned'] };
    mocks.initialTab!.preserveLocal = true;
    mocks.migratePendingImages.mockResolvedValueOnce(migration);
    mocks.toolbar[action]();
    await settle();
    expect(mocks.finalizeImageMigration).toHaveBeenCalledExactlyOnceWith(migration, 'committed');
    expect(tabState().preserveLocal).toBe(false);
    expect(tabState().dirty).toBe(false);
  });

  it('discards provisional assets when the tab is closed before migration completes', async () => {
    const migration = { markdown: 'current', updates: [], allocationIds: ['owned'] };
    let release!: (value: typeof migration) => void;
    mocks.migratePendingImages.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    mocks.toolbar[action]();
    await settle();
    expect(mocks.migratePendingImages).toHaveBeenCalledTimes(1);
    await mocks.confirmClose!('discard');
    release(migration);
    await settle();
    expect(mocks.writeDocument).not.toHaveBeenCalled();
    expect(mocks.finalizeImageMigration).toHaveBeenCalledExactlyOnceWith(migration, 'unchanged');
  });
});

describe('App initialization preserves authoritative source', () => {
  const samples = [
    {
      name: 'reference links',
      raw: '[Full][id] [collapsed][] [shortcut]\n\n[id]: https://example.com/full "title"\n[collapsed]: https://example.com/collapsed\n[shortcut]: https://example.com/shortcut\n',
      canonical:
        '[Full](https://example.com/full "title") [collapsed](https://example.com/collapsed) [shortcut](https://example.com/shortcut)\n',
    },
    {
      name: 'bare URL and email',
      raw: 'Visit https://example.com/path?q=1&x=2. Email audit@example.com.\n',
      canonical: 'Visit <https://example.com/path?q=1&x=2>. Email <audit@example.com>.\n',
    },
    {
      name: 'leading and trailing whitespace',
      raw: '\n\n# Heading\n\n\nOriginal paragraph.\n\n',
      canonical: '# Heading\n\nOriginal paragraph.\n',
    },
    {
      name: 'empty source',
      raw: '',
      canonical: 'renderer fallback',
    },
  ];
  const update = (markdown: string): EditorUpdate => ({
    markdown,
    outline: [{ level: 1, text: 'Heading', pos: 0 }],
    stats: computeStats(markdown),
    canUndo: true,
    canRedo: true,
  });
  const setRaw = (raw: string, dirty = false) => {
    Object.assign(tabState(), {
      markdown: raw,
      savedContent: dirty ? 'saved baseline' : raw,
      initialContent: raw,
      stats: computeStats(raw),
      dirty,
    });
  };
  for (const sample of samples) {
    it.each(['onSave', 'onSaveAs'])(
      `preserves ${sample.name} after initial normalization through %s`,
      async (action) => {
        setRaw(sample.raw);
        mocks.notify!(update(sample.canonical), true);
        await mocks.toolbar[action]();
        await settle();
        expect(mocks.writeFile).toHaveBeenCalledWith(
          action === 'onSave' ? 'C:/notes/note.md' : 'D:/new/note.md',
          sample.raw,
        );
        expect(tabState().markdown).toBe(sample.raw);
        expect(tabState().stats).toEqual(computeStats(sample.raw));
        expect(tabState().dirty).toBe(false);
        expect(tabState().initialContent).toBe(sample.raw);
      },
    );
  }
  it('keeps raw stats, saved baselines and dirty state while initializing derived metadata', () => {
    const raw = samples[0].raw;
    setRaw(raw, true);
    const initial = update(samples[0].canonical);
    mocks.notify!(initial, true);
    expect(tabState().markdown).toBe(raw);
    expect(tabState().savedContent).toBe('saved baseline');
    expect(tabState().initialContent).toBe(raw);
    expect(tabState().dirty).toBe(true);
    expect(tabState().stats).toEqual(computeStats(raw));
    const mirrorRef = mocks.refs.find((ref) => {
      const value = (ref.current as Record<string, EditorUpdate> | null)?.tab;
      return value && Array.isArray(value.outline) && typeof value.canUndo === 'boolean';
    });
    expect((mirrorRef!.current as Record<string, EditorUpdate>).tab).toEqual({
      ...initial,
      markdown: raw,
      stats: computeStats(raw),
    });
  });
  it('does not schedule autosave from a clean initial notification', async () => {
    setRaw(samples[0].raw);
    mocks.notify!(update(samples[0].canonical), true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(tabState().dirty).toBe(false);
  });
  it('saves a genuine edit immediately after the initial notification', async () => {
    setRaw(samples[0].raw);
    mocks.notify!(update(samples[0].canonical), true);
    mocks.edit!();
    await mocks.toolbar.onSave();
    await settle();
    expect(mocks.writeFile).toHaveBeenCalledWith('C:/notes/note.md', 'newer');
  });
  it('does not let a late initial notification replace a newer edit', async () => {
    setRaw(samples[0].raw);
    mocks.edit!();
    mocks.notify!(update(samples[0].canonical), true);
    expect(mocks.setMarkdown).toHaveBeenCalledWith(expect.anything(), 'newer', true);
    await mocks.toolbar.onSave();
    await settle();
    expect(mocks.writeFile).toHaveBeenCalledWith('C:/notes/note.md', 'newer');
  });
});
