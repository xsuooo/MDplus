import { renderToStaticMarkup } from 'react-dom/server';
import type { Editor } from '@milkdown/kit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tab } from '../src/lib/types';

const mocks = vi.hoisted(() => ({
  initialTab: null as Tab | null,
  toolbar: {} as Record<string, () => Promise<void> | void>,
  close: null as ((id: string) => void) | null,
  edit: null as (() => void) | null,
  confirmClose: null as ((action: 'save' | 'discard' | 'cancel') => void) | null,
  refs: [] as { current: unknown }[],
  useStateIndex: 0,
  arrayRefSeen: false,
  pickSaveFile: vi.fn(),
  fileMtime: vi.fn(),
  writeFile: vi.fn(),
  migratePendingImages: vi.fn(),
  commitImageMigration: vi.fn(),
  setMarkdown: vi.fn(),
  confirmDialog: vi.fn(),
  showMessage: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  // Exercise App's actual handlers without mounting a WebView or running startup effects.
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = mocks.useStateIndex++;
      const value = index === 0 ? [mocks.initialTab] : index === 1 ? 'tab' :
        index === 9 ? mocks.initialTab : typeof initial === 'function' ? initial() : initial;
      return [value, vi.fn()];
    },
    useRef: (initial: unknown) => {
      const value = Array.isArray(initial) && !mocks.arrayRefSeen
        ? (mocks.arrayRefSeen = true, [mocks.initialTab])
        : initial;
      const ref = { current: value };
      mocks.refs.push(ref);
      return ref;
    },
    useEffect: () => {},
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
  EditorTab: (props: { tab: Tab; onUpdate: (id: string, update: unknown) => void; onRegister: (id: string, editor: Editor | null) => void }) => {
    props.onRegister(props.tab.id, {} as Editor);
    mocks.edit = () => props.onUpdate(props.tab.id, {
      markdown: 'newer', outline: [], stats: { chars: 5, words: 1, lines: 1 }, canUndo: true, canRedo: false,
    });
    return null;
  },
}));
vi.mock('../src/lib/editor', () => ({ setMarkdown: mocks.setMarkdown, undo: vi.fn(), redo: vi.fn() }));
vi.mock('../src/lib/mermaid', () => ({ refreshMermaidTheme: vi.fn() }));
vi.mock('../src/lib/store', () => ({
  getRecentFiles: async () => [], pushRecentFile: async () => {},
  removeRecentFile: async () => {}, getThemeMode: async () => 'light',
  setThemeMode: async () => {}, getSourceModePref: async () => false,
  setSourceModePref: async () => {}, getWindowState: async () => null,
  setWindowState: async () => {}, getOutlineOpen: async () => false, setOutlineOpen: async () => {},
}));
vi.mock('../src/lib/fileOps', () => ({
  pickSaveFile: mocks.pickSaveFile, fileMtime: mocks.fileMtime, writeFile: mocks.writeFile,
  readFile: vi.fn(), pickOpenFile: vi.fn(), basename: (value: string) => value.split(/[\\/]/).pop(),
}));
vi.mock('../src/lib/imageOps', () => ({
  migratePendingImages: mocks.migratePendingImages,
  commitImageMigration: mocks.commitImageMigration,
  clearPendingImages: vi.fn(), saveImage: vi.fn(), loadImageReferences: vi.fn(),
}));
vi.mock('../src/lib/dialog', () => ({
  confirmDialog: mocks.confirmDialog, showMessage: mocks.showMessage,
}));

import App from '../src/App';

function tabState(): Tab {
  const ref = mocks.refs.find((ref) => Array.isArray(ref.current) && (ref.current as Tab[])[0]?.id === 'tab');
  return (ref!.current as Tab[])[0];
}

async function settle() {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.refs = [];
  mocks.useStateIndex = 0;
  mocks.arrayRefSeen = false;
  mocks.initialTab = {
    id: 'tab', title: 'note.md', path: 'C:/notes/note.md', isNew: false,
    dirty: true, externalMtime: 100, externalChanged: false,
    markdown: 'current', savedContent: 'previous', initialContent: 'previous',
    stats: { chars: 7, words: 1, lines: 1 },
  };
  mocks.pickSaveFile.mockResolvedValue('D:/new/note.md');
  mocks.fileMtime.mockResolvedValue(100);
  mocks.writeFile.mockResolvedValue(undefined);
  mocks.migratePendingImages.mockImplementation(async (_id: string, _path: string, markdown: string) => ({
    markdown, updates: [],
  }));
  mocks.confirmDialog.mockResolvedValue(false);
  mocks.showMessage.mockResolvedValue(undefined);
  renderToStaticMarkup(<App />);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('App save entry points', () => {
  it.each(['onSave', 'onSaveAs'])('commits image sources before refreshing the editor through %s', async (action) => {
    mocks.migratePendingImages.mockResolvedValue({ markdown: '![](./assets/pic.png)', updates: [] });
    mocks.toolbar[action]();
    await settle();
    expect(mocks.commitImageMigration).toHaveBeenCalledTimes(1);
    expect(mocks.setMarkdown).toHaveBeenCalledWith(expect.anything(), '![](./assets/pic.png)');
    expect(mocks.commitImageMigration.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.setMarkdown.mock.invocationCallOrder[0]);
    expect(tabState().dirty).toBe(false);
  });

  it('queues SaveAs behind an in-flight save without overlapping writes', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
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
      'C:/notes/note.md', 'D:/new/note.md',
    ]);
  });

  it('queues a newer save behind SaveAs and uses the updated document path', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
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
      ['D:/new/note.md', 'current'], ['D:/new/note.md', 'newer'],
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
    mocks.writeFile.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
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
    mocks.pickSaveFile.mockImplementationOnce(() => new Promise<string>((resolve) => {
      release = () => resolve('D:/first/note.md');
    }));
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
