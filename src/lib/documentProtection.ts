import type { Tab } from './types';

/** A clean edit buffer can still be the only surviving copy of a disk version. */
export function needsDocumentProtection(tab: Tab, markdown = tab.markdown): boolean {
  return tab.dirty || tab.preserveLocal === true || (tab.isNew && markdown.trim().length > 0);
}
