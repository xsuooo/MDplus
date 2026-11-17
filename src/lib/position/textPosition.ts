/** Map a UTF-16 selection through one contiguous text replacement. */
export function mapTextOffset(before: string, after: string, offset: number): number {
  let start = 0;
  // Unchanged positions need no document-wide diff, especially hidden source carets at zero.
  while (
    start < offset &&
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++;
  if (offset <= start) return Math.min(offset, after.length);
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  if (offset >= oldEnd) return Math.min(after.length, offset + newEnd - oldEnd);
  return start + Math.min(offset - start, newEnd - start);
}
