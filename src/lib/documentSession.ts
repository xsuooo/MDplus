import { pathKey } from './pathIdentity';
import { sanitizeSessionPlace, type SessionEditorPlace } from './sessionPosition';

export interface SessionDocument {
  path: string;
  title: string;
  place?: SessionEditorPlace;
}
export interface SavedDocumentSession {
  version: 1;
  documents: SessionDocument[];
  activePath: string | null;
}
export interface SessionRestoreFailure {
  path: string;
  title: string;
  message: string;
}

export const EMPTY_DOCUMENT_SESSION: SavedDocumentSession = {
  version: 1,
  documents: [],
  activePath: null,
};

/** Drop invalid fields and legacy body data before accepting anything from settings. */
export function sanitizeDocumentSession(value: unknown): SavedDocumentSession {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { ...EMPTY_DOCUMENT_SESSION, documents: [] };
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || !Array.isArray(input.documents))
    return { ...EMPTY_DOCUMENT_SESSION, documents: [] };
  const documents: SessionDocument[] = [];
  const seen = new Set<string>();
  for (const candidate of input.documents.slice(0, 200)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const entry = candidate as Record<string, unknown>;
    if (
      typeof entry.path !== 'string' ||
      !entry.path.trim() ||
      entry.path.length > 32768 ||
      [...entry.path].some((character) => character.charCodeAt(0) < 32) ||
      !/^(?:[a-z]:[\\/]|[\\/]{2}|\/)/i.test(entry.path)
    )
      continue;
    const key = pathKey(entry.path);
    if (seen.has(key)) continue;
    seen.add(key);
    const title =
      typeof entry.title === 'string' && entry.title.length <= 1024
        ? entry.title
        : (entry.path.split(/[\\/]/).pop() ?? entry.path);
    const place = sanitizeSessionPlace(entry.place);
    documents.push({ path: entry.path, title, ...(place ? { place } : {}) });
  }
  const active = typeof input.activePath === 'string' ? pathKey(input.activePath) : null;
  return {
    version: 1,
    documents,
    activePath: documents.find((entry) => pathKey(entry.path) === active)?.path ?? null,
  };
}

/** Failed paths keep their original slot among successfully reopened documents. */
export function mergeSessionDocuments(
  live: SessionDocument[],
  retained: SessionDocument[],
  previous: SessionDocument[],
): SessionDocument[] {
  const result = [...live];
  const order = new Map(previous.map((entry, index) => [pathKey(entry.path), index]));
  for (const entry of retained) {
    const key = pathKey(entry.path);
    if (result.some((candidate) => pathKey(candidate.path) === key)) continue;
    const ordinal = order.get(key) ?? Infinity;
    const at = result.findIndex(
      (candidate) => (order.get(pathKey(candidate.path)) ?? Infinity) > ordinal,
    );
    result.splice(at < 0 ? result.length : at, 0, entry);
  }
  return result;
}
