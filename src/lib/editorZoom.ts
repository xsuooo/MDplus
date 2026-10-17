export const EDITOR_ZOOM_DEFAULT = 100;
export const EDITOR_ZOOM_MIN = 50;
export const EDITOR_ZOOM_MAX = 250;
export const EDITOR_ZOOM_STEP = 10;
export const EDITOR_ZOOM_STORAGE_KEY = 'mdplus-editor-zoom';

export type EditorZoomAction = 'increase' | 'decrease' | 'reset';

export function normalizeEditorZoom(value: number): number {
  if (!Number.isFinite(value)) return EDITOR_ZOOM_DEFAULT;
  return Math.min(EDITOR_ZOOM_MAX, Math.max(EDITOR_ZOOM_MIN, Math.round(value / EDITOR_ZOOM_STEP) * EDITOR_ZOOM_STEP));
}

export function nextEditorZoom(value: number, action: EditorZoomAction): number {
  if (action === 'reset') return EDITOR_ZOOM_DEFAULT;
  return normalizeEditorZoom(normalizeEditorZoom(value) + (action === 'increase' ? EDITOR_ZOOM_STEP : -EDITOR_ZOOM_STEP));
}

export function readEditorZoom(storage?: Pick<Storage, 'getItem'>): number {
  try {
    const saved = (storage ?? window.localStorage).getItem(EDITOR_ZOOM_STORAGE_KEY);
    return saved?.trim() ? normalizeEditorZoom(Number(saved)) : EDITOR_ZOOM_DEFAULT;
  } catch {
    return EDITOR_ZOOM_DEFAULT;
  }
}

export function writeEditorZoom(value: number, storage?: Pick<Storage, 'setItem'>): void {
  try {
    (storage ?? window.localStorage).setItem(EDITOR_ZOOM_STORAGE_KEY, String(normalizeEditorZoom(value)));
  } catch {
    // 缩放不依赖偏好存储可用。
  }
}

export function editorZoomKeyAction(event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'key'>): EditorZoomAction | null {
  if (!event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.key === '=' || event.key === '+') return 'increase';
  if (event.key === '-' || event.key === '−') return 'decrease';
  if (event.key === '0') return 'reset';
  return null;
}

const CONTENT_SELECTOR = '.editor-tab.active .milkdown-container, .source-textarea';

export function isEditorZoomTarget(root: HTMLElement, target: EventTarget | null): boolean {
  const node = target as Node | null;
  const element = node?.nodeType === 1 ? node as Element : node?.parentElement;
  return Boolean(element && root.contains(element) && element.closest(CONTENT_SELECTOR));
}

export function bindEditorZoomControls(root: HTMLElement, onZoom: (action: EditorZoomAction) => void): () => void {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey || event.metaKey || event.altKey || !Number.isFinite(event.deltaY) || event.deltaY === 0 || !isEditorZoomTarget(root, event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    onZoom(event.deltaY < 0 ? 'increase' : 'decrease');
  };
  const onKey = (event: KeyboardEvent) => {
    const action = editorZoomKeyAction(event);
    const target = event.target === doc || event.target === view ? doc.activeElement : event.target;
    if (!action || event.defaultPrevented || !isEditorZoomTarget(root, target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    onZoom(action);
  };
  root.addEventListener('wheel', onWheel, { passive: false, capture: true });
  view?.addEventListener('keydown', onKey, true);
  return () => {
    root.removeEventListener('wheel', onWheel, { capture: true });
    view?.removeEventListener('keydown', onKey, { capture: true });
  };
}
