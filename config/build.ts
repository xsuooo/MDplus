import { execFileSync } from 'node:child_process';

/** CI may provide an immutable release ID; local builds identify their Git revision. */
export function buildId(): string {
  const provided = process.env.MDPLUS_BUILD_ID ?? process.env.GITHUB_SHA;
  if (provided) {
    if (!/^[a-zA-Z0-9._+-]{1,128}$/.test(provided)) throw new Error('Invalid build identifier');
    return provided;
  }
  try {
    const revision = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const changed = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return `${revision}${changed ? '+dirty' : ''}`;
  } catch {
    return 'development';
  }
}
