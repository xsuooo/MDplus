/** Format known Windows extended paths for UI text, including paths in messages. */
export function displayPath(text: string): string {
  return text.replace(/\\\\\?\\UNC\\/gi, '\\\\').replace(/\\\\\?\\(?=[a-z]:\\)/gi, '');
}
