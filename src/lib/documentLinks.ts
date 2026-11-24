import { invoke } from '@tauri-apps/api/core';
import { dirname, join } from '@tauri-apps/api/path';

/**
 * A web address the system browser may open, serialized so the native side receives exactly
 * one unambiguous URL. Anything that is not absolute http(s) returns null and stays a document link.
 */
export function externalLinkUrl(href: string): string | null {
  const trimmed = href.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Opens a validated http(s) address in the system default browser. */
export async function openExternalLink(href: string): Promise<void> {
  const url = externalLinkUrl(href);
  if (!url) throw new Error('无法打开这个链接：只支持 http 或 https 网址。');
  try {
    await invoke<void>('open_external_link', { url });
  } catch {
    throw new Error(`无法在浏览器中打开链接：${url}`);
  }
}

/** Resolve against the triggering document, never the WebView URL or process cwd. */
export async function resolveDocumentLink(
  href: string,
  sourcePath: string | null,
): Promise<{ path: string; hasFragment: boolean }> {
  const hash = href.indexOf('#');
  const rawPath = hash < 0 ? href : href.slice(0, hash);
  if (!rawPath) throw new Error('暂时无法跳到链接指定的标题。请链接到 .md 或 .markdown 文档。');
  if (rawPath.includes('?')) throw new Error('暂不支持带查询参数的文稿链接。');
  let relative = rawPath;
  try {
    relative = decodeURIComponent(rawPath);
  } catch {
    /* A literal malformed percent escape remains part of the filename. */
  }
  if (/^(?:[\\/]|[a-z][a-z\d+.-]*:)/i.test(relative) || !/\.(md|markdown)$/i.test(relative))
    throw new Error('只能打开网页链接（http/https），或相对的 .md、.markdown 文稿链接。');
  if (!sourcePath) throw new Error('请先保存当前文稿，再打开相对文稿链接。');
  return { path: await join(await dirname(sourcePath), relative), hasFragment: hash >= 0 };
}
