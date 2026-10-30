export const CODE_FONTS = [
  { id: 'jetbrains-sarasa', label: 'JetBrains Mono + 更纱黑体', family: '"MDPlus JetBrains Mono", "MDPlus Sarasa Gothic SC"' },
  { id: 'fira-wenkai', label: 'Fira Code + 霞鹜文楷', family: '"MDPlus Fira Code", "MDPlus LXGW WenKai"' },
  { id: 'cascadia-misans', label: 'Cascadia Code + MiSans', family: '"MDPlus Cascadia Code", "MDPlus MiSans"' },
] as const;

export const BODY_FONTS = [
  { id: 'misans', label: 'MiSans', family: '"MDPlus MiSans"', strongWeight: 600 },
  { id: 'sarasa', label: '更纱黑体', family: '"MDPlus Sarasa Gothic SC"', strongWeight: 600 },
  { id: 'wenkai', label: '霞鹜文楷', family: '"MDPlus LXGW WenKai"', strongWeight: 500 },
] as const;

export type CodeFont = typeof CODE_FONTS[number]['id'];
export type BodyFont = typeof BODY_FONTS[number]['id'];
export const DEFAULT_CODE_FONT: CodeFont = 'jetbrains-sarasa';
export const DEFAULT_BODY_FONT: BodyFont = 'misans';
// The old pair selection remains the code preference, never a body-font override.
export const CODE_FONT_STORAGE_KEY = 'mdplus-editor-font';
export const BODY_FONT_STORAGE_KEY = 'mdplus-body-font';

export function normalizeCodeFont(value: unknown): CodeFont {
  return CODE_FONTS.find((font) => font.id === value)?.id ?? DEFAULT_CODE_FONT;
}
export function normalizeBodyFont(value: unknown): BodyFont {
  return BODY_FONTS.find((font) => font.id === value)?.id ?? DEFAULT_BODY_FONT;
}
function read(key: string, storage?: Pick<Storage, 'getItem'>): string | null {
  try {
    return (storage ?? window.localStorage).getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string, storage?: Pick<Storage, 'setItem'>): void {
  try {
    (storage ?? window.localStorage).setItem(key, value);
  } catch {
    // Font selection remains usable when preference storage is unavailable.
  }
}
export const readCodeFont = (storage?: Pick<Storage, 'getItem'>): CodeFont => normalizeCodeFont(read(CODE_FONT_STORAGE_KEY, storage));
export const readBodyFont = (storage?: Pick<Storage, 'getItem'>): BodyFont => normalizeBodyFont(read(BODY_FONT_STORAGE_KEY, storage));
export const writeCodeFont = (font: CodeFont, storage?: Pick<Storage, 'setItem'>): void => write(CODE_FONT_STORAGE_KEY, font, storage);
export const writeBodyFont = (font: BodyFont, storage?: Pick<Storage, 'setItem'>): void => write(BODY_FONT_STORAGE_KEY, font, storage);
