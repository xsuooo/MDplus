import { dirname, join } from '@tauri-apps/api/path';

/** Resolve against the triggering document, never the WebView URL or process cwd. */
export async function resolveDocumentLink(
  href: string,
  sourcePath: string | null,
): Promise<{ path: string; hasFragment: boolean }> {
  const hash = href.indexOf('#');
  const rawPath = hash < 0 ? href : href.slice(0, hash);
  if (!rawPath) throw new Error('暂不支持标题锚点定位。请使用相对 .md 或 .markdown 文稿链接。');
  if (rawPath.includes('?')) throw new Error('暂不支持带查询参数的文稿链接。');
  let relative = rawPath;
  try {
    relative = decodeURIComponent(rawPath);
  } catch {
    /* A literal malformed percent escape remains part of the filename. */
  }
  if (/^(?:[\\/]|[a-z][a-z\d+.-]*:)/i.test(relative) || !/\.(md|markdown)$/i.test(relative))
    throw new Error('当前只支持相对 .md 或 .markdown 文稿链接。');
  if (!sourcePath) throw new Error('请先保存当前文稿，再打开相对文稿链接。');
  return { path: await join(await dirname(sourcePath), relative), hasFragment: hash >= 0 };
}
