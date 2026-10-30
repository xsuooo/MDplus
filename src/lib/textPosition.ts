/** Map a UTF-16 selection through one contiguous text replacement. */
export function mapTextOffset(before: string, after: string, offset: number): number {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  if (offset <= start) return Math.min(offset, after.length);
  if (offset >= oldEnd) return Math.min(after.length, offset + newEnd - oldEnd);
  return start + Math.min(offset - start, newEnd - start);
}
