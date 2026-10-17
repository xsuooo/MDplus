export const OUTLINE_WIDTH_DEFAULT = 246;
export const OUTLINE_WIDTH_MIN = 180;
export const OUTLINE_WIDTH_MAX = 480;
export const OUTLINE_WIDTH_STEP = 16;
export const OUTLINE_WIDTH_STORAGE_KEY = 'mdplus-outline-width';

/** 夹住目录栏宽度:非有限值回落默认,避免坏值把面板撑到看不见编辑器。 */
export function normalizeOutlineWidth(value: unknown): number {
  const width = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(width)) return OUTLINE_WIDTH_DEFAULT;
  return Math.min(OUTLINE_WIDTH_MAX, Math.max(OUTLINE_WIDTH_MIN, Math.round(width)));
}

export function readOutlineWidth(storage?: Pick<Storage, 'getItem'>): number {
  try {
    const saved = (storage ?? window.localStorage).getItem(OUTLINE_WIDTH_STORAGE_KEY);
    return saved?.trim() ? normalizeOutlineWidth(Number(saved)) : OUTLINE_WIDTH_DEFAULT;
  } catch {
    return OUTLINE_WIDTH_DEFAULT;
  }
}

export function writeOutlineWidth(width: number, storage?: Pick<Storage, 'setItem'>): void {
  try {
    (storage ?? window.localStorage).setItem(OUTLINE_WIDTH_STORAGE_KEY, String(normalizeOutlineWidth(width)));
  } catch {
    // 宽度不依赖偏好存储可用。
  }
}
