/**
 * Windows comparison key: normalize separators, extended prefixes and dot segments.
 * Relative paths still need the native command's absolute path before comparison
 * with an absolute document; this helper never guesses the process cwd or drive.
 */
export function pathKey(path: string): string {
  let rest = path
    .replace(/\//g, '\\')
    .replace(/^\\\\\?\\UNC\\/i, '\\\\')
    .replace(/^\\\\\?\\/, '');
  let prefix = '';
  let rooted = false;
  const drive = /^([a-z]:)(\\?)/i.exec(rest);
  if (drive) {
    prefix = drive[0];
    rooted = !!drive[2];
    rest = rest.slice(prefix.length);
  } else if (rest.startsWith('\\\\')) {
    const parts = rest.slice(2).split('\\').filter(Boolean);
    prefix = `\\\\${parts.shift() ?? ''}\\${parts.shift() ?? ''}\\`;
    rest = parts.join('\\');
    rooted = true;
  } else if (rest.startsWith('\\')) {
    prefix = '\\';
    rest = rest.slice(1);
    rooted = true;
  }
  const segments: string[] = [];
  for (const segment of rest.split('\\')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length && segments[segments.length - 1] !== '..') segments.pop();
      else if (!rooted) segments.push(segment);
    } else segments.push(segment);
  }
  return (prefix + segments.join('\\')).toLowerCase();
}
