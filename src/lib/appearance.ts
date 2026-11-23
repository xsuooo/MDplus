export const APPEARANCE_STORAGE_KEY = 'mdplus-appearance';

export const APPEARANCES = [
  { id: 'folio', name: '纸页', label: 'Folio', description: '暖纸、朱砂与编辑部秩序' },
  { id: 'nocturne', name: '夜航', label: 'Nocturne', description: '石墨、微光与沉静的层次' },
  { id: 'prism', name: '冷光', label: 'Prism', description: '冰蓝、钴色与玻璃光学' },
] as const;

export type Appearance = (typeof APPEARANCES)[number]['id'];

export function normalizeAppearance(value: unknown): Appearance {
  return APPEARANCES.some((appearance) => appearance.id === value)
    ? (value as Appearance)
    : 'folio';
}

export function readAppearance(): Appearance {
  try {
    return normalizeAppearance(localStorage.getItem(APPEARANCE_STORAGE_KEY));
  } catch {
    return 'folio';
  }
}

export function writeAppearance(appearance: Appearance): void {
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, appearance);
  } catch {
    // A blocked local preference must not interrupt writing or native settings.
  }
}
