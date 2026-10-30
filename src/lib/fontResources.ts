import { BODY_FONTS, CODE_FONTS, type BodyFont, type CodeFont } from './editorFont';

const urls = import.meta.glob('../assets/fonts/*', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const faces = [
  ['MDPlus MiSans', 'MiSans-Regular.woff2', '400', 'MiSans-License.pdf'],
  ['MDPlus MiSans', 'MiSans-Semibold.woff2', '600', 'MiSans-License.pdf'],
  ['MDPlus Sarasa Gothic SC', 'SarasaGothicSC-Regular.woff2', '400', 'Sarasa-OFL.txt'],
  ['MDPlus Sarasa Gothic SC', 'SarasaGothicSC-SemiBold.woff2', '600', 'Sarasa-OFL.txt'],
  ['MDPlus LXGW WenKai', 'LXGWWenKai.woff2', '400', 'LXGWWenKai-OFL.txt'],
  ['MDPlus LXGW WenKai', 'LXGWWenKai-Medium.woff2', '500', 'LXGWWenKai-OFL.txt'],
  ['MDPlus JetBrains Mono', 'JetBrainsMono.woff2', '100 800', 'JetBrainsMono-OFL.txt'],
  ['MDPlus Fira Code', 'FiraCode.woff2', '300 700', 'FiraCode-OFL.txt'],
  ['MDPlus Cascadia Code', 'CascadiaCode.ttf', '200 700', 'CascadiaCode-OFL.txt'],
] as const;

export async function dataURL(url: string): Promise<string> {
  if (url.startsWith('data:')) return url;
  let response: Response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(20000) }); }
  catch { throw new Error(`无法读取内嵌资源：${url.slice(0, 160)}`); }
  if (!response.ok) throw new Error(`资源读取失败 (${response.status}): ${url}`);
  const blob = await response.blob();
  return blobDataURL(blob);
}

export function blobDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('资源转换失败'));
    reader.readAsDataURL(blob);
  });
}

export function bodyFamily(font: BodyFont): string {
  return BODY_FONTS.find((entry) => entry.id === font)!.family;
}

/** Keep full, unmodified font files and their licenses with portable documents. */
export async function embeddedFonts(body: BodyFont, code?: CodeFont): Promise<{ css: string; licenses: string[] }> {
  const families = bodyFamily(body) + (code ? CODE_FONTS.find((entry) => entry.id === code)!.family : '');
  const selected = faces.filter(([family]) => families.includes(`"${family}"`));
  const css = (await Promise.all(selected.map(async ([family, file, weight]) =>
    `@font-face{font-family:"${family}";src:url("${await dataURL(urls[`../assets/fonts/${file}`])}");font-weight:${weight};font-display:block;}`
  ))).join('\n');
  return { css, licenses: [...new Set(selected.map((face) => face[3]))] };
}
