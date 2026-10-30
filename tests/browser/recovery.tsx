import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import App from '../../src/App';
import type { RecoverySnapshot } from '../../src/lib/recovery';

export const recoveryCases = [
  'recovery-restore-save', 'recovery-write-failure', 'recovery-discard',
  'recovery-paste-cache-failure', 'recovery-source-checkpoint', 'recovery-save-failure',
] as const;
export type RecoveryCase = typeof recoveryCases[number];

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until(condition: () => unknown) {
  const deadline = performance.now() + 12000;
  while (!condition()) {
    check(performance.now() < deadline, 'Recovery regression timed out');
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}
function click(selector: string) {
  const element = document.querySelector<HTMLButtonElement>(selector);
  check(element && !element.disabled, `Missing enabled button: ${selector}`);
  element.click();
}

export async function runRecoveryRegression(testCase: RecoveryCase): Promise<string> {
  mockWindows('main');
  Object.assign(globalThis, { isTauri: true });
  const originalPath = 'C:/中文 目录/原文.md';
  const restoredPath = 'C:/导出 目录/恢复 副本.md';
  const files = new Map([[originalPath, 'original document\n']]);
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII='), (c) => c.charCodeAt(0));
  const initial: RecoverySnapshot = {
    id: 'recovery-test', title: '恢复 草稿.md', originalPath,
    markdown: 'Recovered text\n\n![](mdplus-image:picture)\n',
    images: [{ placeholder: 'mdplus-image:picture', filename: '图片 一.png', key: 'picture.png' }],
  };
  const restores = testCase === 'recovery-restore-save' || testCase === 'recovery-discard' || testCase === 'recovery-save-failure';
  const snapshots = new Map<string, RecoverySnapshot>(restores ? [[initial.id, initial]] : []);
  const events: string[] = [];
  const messages: string[] = [];
  const binaryWrites: string[] = [];
  const store = new Map<string, unknown>();
  let checkpoints = 0;
  mockIPC(async (command, payload) => {
    const args = (payload ?? {}) as Record<string, any>;
    switch (command) {
      case 'take_startup_files': return restores ? [] : [originalPath];
      case 'take_pending_open_files': return [];
      case 'plugin:store|load': return 1;
      case 'plugin:store|get': return [store.get(args.key), store.has(args.key)];
      case 'plugin:store|set': store.set(args.key, args.value); return;
      case 'plugin:store|save': return;
      case 'plugin:window|is_minimized':
      case 'plugin:window|is_maximized': return false;
      case 'plugin:window|available_monitors': return [];
      case 'plugin:window|inner_size': return { width: 1100, height: 800 };
      case 'plugin:window|outer_position': return { x: 0, y: 0 };
      case 'plugin:window|show':
      case 'plugin:window|set_focus': return;
      case 'plugin:dialog|save': return restoredPath;
      case 'plugin:dialog|message': messages.push(args.message); return args.buttons === 'YesNo' ? 'Yes' : 'Ok';
      case 'plugin:path|dirname': return args.path.replace(/\/[^/]+$/, '');
      case 'plugin:path|join': return args.paths.join('/').replace('/./', '/');
      case 'read_file': return files.get(args.path);
      case 'file_mtime': {
        if (!files.has(args.path)) throw new Error('File not found');
        return 100;
      }
      case 'write_file': {
        if (testCase === 'recovery-save-failure') throw new Error('simulated write failure');
        events.push('document-saved'); files.set(args.path, args.content); return;
      }
      case 'create_directory': return;
      case 'save_binary_file': binaryWrites.push(args.path); return;
      case 'list_recovery_snapshots': return [...snapshots.values()].filter((s) => !args.activeIds.includes(s.id))
        .map((s) => ({ ...s, updatedAt: Date.now(), damaged: false }));
      case 'read_recovery_snapshot': return {
        snapshot: snapshots.get(args.id),
        images: [{ ...initial.images[0], data: [...png], mime: 'image/png' }],
      };
      case 'cache_recovery_image':
        if (testCase === 'recovery-paste-cache-failure') throw new Error('cache full');
        events.push('image-cached'); return;
      case 'write_recovery_snapshot':
        checkpoints++;
        if (testCase === 'recovery-write-failure') throw new Error('disk full');
        snapshots.set(args.snapshot.id, args.snapshot); events.push('snapshot-saved'); return;
      case 'delete_recovery_snapshot': snapshots.delete(args.id); events.push('snapshot-deleted'); return;
      default: throw new Error(`Unmocked recovery IPC: ${command}`);
    }
  }, { shouldMockEvents: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host); root.render(<App />);
  try {
    if (restores) {
      await until(() => document.querySelector('.recovery-modal'));
      click('.recovery-entry .btn-primary');
      await until(() => document.querySelector('.editor-tab.active .ProseMirror img'));
      const image = document.querySelector<HTMLImageElement>('.editor-tab.active img:not(.ProseMirror-separator)')!;
      await until(() => image.naturalWidth > 0);
      check(snapshots.has(initial.id), 'Recovering discarded the only durable copy');
      check(files.get(originalPath) === 'original document\n', 'Recovery overwrote the original');
      if (testCase === 'recovery-discard') {
        click('.tab.active .tab-close');
        await until(() => document.querySelector('#close-document-title'));
        const discard = [...document.querySelectorAll<HTMLButtonElement>('.modal-actions button')]
          .find((button) => button.textContent?.trim() === '放弃');
        check(discard, 'Discard confirmation was not shown');
        discard.click();
        await until(() => !document.querySelector('[role="tab"]'));
        check(!snapshots.has(initial.id), 'Explicit discard retained private recovery data');
      } else {
        click('button[title^="保存 (Ctrl+S)"]');
        if (testCase === 'recovery-save-failure') {
          await until(() => messages.some((message) => message.includes('simulated write failure')));
          check(snapshots.has(initial.id), 'Failed save deleted the recovery snapshot');
        } else {
          await until(() => events.includes('snapshot-deleted'));
          check(events.indexOf('document-saved') < events.indexOf('snapshot-deleted'), 'Recovery cleaned before save success');
          check(files.get(restoredPath)?.includes('./assets/图片 一.png'), 'Recovered image was not migrated');
          check(binaryWrites.some((path) => path.includes('导出 目录/assets/图片 一.png')), 'Image file missing');
        }
      }
    } else {
      await until(() => document.querySelector('.editor-tab.active .ProseMirror'));
      click('button[aria-label="切换源码模式"]');
      await until(() => document.querySelector('.source-editor:not([hidden]) .source-textarea'));
      const field = document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) .source-textarea')!;
      if (testCase === 'recovery-paste-cache-failure') {
        const before = field.value;
        const clipboardData = new DataTransfer();
        clipboardData.items.add(new File([png], 'paste.png', { type: 'image/png' }));
        field.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
        await until(() => messages.length > 0);
        check(field.value === before, 'Failed cache write inserted an unprotected image token');
      } else {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, '中文 新草稿');
        field.dispatchEvent(new Event('input', { bubbles: true }));
        await until(() => checkpoints > 0);
        if (testCase === 'recovery-write-failure') {
          await until(() => document.querySelector('.recovery-status-error'));
          check(!document.querySelector('.recovery-status-protected'), 'Failed snapshot claimed protection');
        } else {
          check([...snapshots.values()].some((snapshot) => snapshot.markdown === '中文 新草稿'), 'Source draft did not reach recovery');
        }
      }
    }
    return `${testCase}: real React/Milkdown, simulated durable/native boundary passed`;
  } finally { root.unmount(); host.remove(); }
}
