export interface SourceTextEdit {
  from: number;
  to: number;
  text: string;
}

export interface SourceSelection {
  start: number;
  end: number;
}

export interface SourceEditorApi {
  read(): SourceSelection & { text: string };
  /** All offsets refer to the text before this operation. */
  applyEdits(edits: readonly SourceTextEdit[], selection?: SourceSelection): boolean;
  undo(): void;
  redo(): void;
}

export type SourceEditorChangeListener = (
  before: string,
  after: string,
  edits?: readonly SourceTextEdit[],
  mapOffset?: (offset: number) => number,
) => void;

const inputs = new WeakMap<HTMLTextAreaElement, SourceEditorApi>();
const listeners = new WeakMap<SourceEditorApi, Set<SourceEditorChangeListener>>();

export function getSourceEditorApi(input: HTMLTextAreaElement): SourceEditorApi | undefined {
  return inputs.get(input);
}

export function registerSourceEditorApi(
  input: HTMLTextAreaElement,
  api: SourceEditorApi,
): () => void {
  inputs.set(input, api);
  return () => {
    if (inputs.get(input) === api) inputs.delete(input);
    listeners.delete(api);
  };
}

export function subscribeSourceEditorChanges(
  api: SourceEditorApi,
  listener: SourceEditorChangeListener,
): () => void {
  let subscribers = listeners.get(api);
  if (!subscribers) {
    subscribers = new Set();
    listeners.set(api, subscribers);
  }
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
    if (!subscribers.size) listeners.delete(api);
  };
}

export function publishSourceEditorChange(
  api: SourceEditorApi,
  before: string,
  after: string,
  edits?: readonly SourceTextEdit[],
  mapOffset?: (offset: number) => number,
): void {
  if (before === after) return;
  listeners.get(api)?.forEach((listener) => listener(before, after, edits, mapOffset));
}

/** Rebase an offset through a sorted edit set without collapsing separate edits into one diff. */
export function mapSourceEditOffset(offset: number, edits: readonly SourceTextEdit[]): number {
  let delta = 0;
  for (const edit of edits) {
    if (offset <= edit.from) break;
    if (offset < edit.to) return edit.from + delta + Math.min(offset - edit.from, edit.text.length);
    delta += edit.text.length - (edit.to - edit.from);
  }
  return Math.max(0, offset + delta);
}

/** Validate the entire operation before changing the live draft. */
export function prepareSourceEdits(
  text: string,
  edits: readonly SourceTextEdit[],
): { text: string; edits: SourceTextEdit[] } | undefined {
  const sorted = edits.map((edit) => ({ ...edit })).sort((a, b) => a.from - b.from || a.to - b.to);
  let end = 0;
  let previous: SourceTextEdit | undefined;
  const parts: string[] = [];
  for (const edit of sorted) {
    if (
      !Number.isInteger(edit.from) ||
      !Number.isInteger(edit.to) ||
      edit.from < 0 ||
      edit.to < edit.from ||
      edit.to > text.length ||
      typeof edit.text !== 'string' ||
      (previous && (edit.from < previous.to || edit.from === previous.from))
    )
      return;
    parts.push(text.slice(end, edit.from), edit.text);
    end = edit.to;
    previous = edit;
  }
  parts.push(text.slice(end));
  return { text: parts.join(''), edits: sorted };
}
