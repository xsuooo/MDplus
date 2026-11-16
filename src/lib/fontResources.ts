import { BODY_FONTS, CODE_FONTS, type BodyFont, type CodeFont } from './editorFont';
import miSansRegular from '../assets/fonts/MiSans-Regular.woff2?url';
import miSansSemibold from '../assets/fonts/MiSans-Semibold.woff2?url';
import sarasaRegular from '../assets/fonts/SarasaGothicSC-Regular.woff2?url';
import sarasaSemibold from '../assets/fonts/SarasaGothicSC-SemiBold.woff2?url';
import wenkaiRegular from '../assets/fonts/LXGWWenKai.woff2?url';
import wenkaiMedium from '../assets/fonts/LXGWWenKai-Medium.woff2?url';
import jetBrainsMono from '../assets/fonts/JetBrainsMono.woff2?url';
import firaCode from '../assets/fonts/FiraCode.woff2?url';
import cascadiaCode from '../assets/fonts/CascadiaCode.ttf?url';

// Explicit imports prevent unused font sources or backups from entering every installer.
const faces = [
  ['MDPlus MiSans', miSansRegular, '400', 'MiSans-License.pdf'],
  ['MDPlus MiSans', miSansSemibold, '600', 'MiSans-License.pdf'],
  ['MDPlus Sarasa Gothic SC', sarasaRegular, '400', 'Sarasa-OFL.txt'],
  ['MDPlus Sarasa Gothic SC', sarasaSemibold, '600', 'Sarasa-OFL.txt'],
  ['MDPlus LXGW WenKai', wenkaiRegular, '400', 'LXGWWenKai-OFL.txt'],
  ['MDPlus LXGW WenKai', wenkaiMedium, '500', 'LXGWWenKai-OFL.txt'],
  ['MDPlus JetBrains Mono', jetBrainsMono, '100 800', 'JetBrainsMono-OFL.txt'],
  ['MDPlus Fira Code', firaCode, '300 700', 'FiraCode-OFL.txt'],
  ['MDPlus Cascadia Code', cascadiaCode, '200 700', 'CascadiaCode-OFL.txt'],
] as const;

export async function dataURL(url: string): Promise<string> {
  if (url.startsWith('data:')) return url;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  } catch {
    throw new Error(`无法读取内嵌资源：${url.slice(0, 160)}`);
  }
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
export async function embeddedFonts(
  body: BodyFont,
  code?: CodeFont,
): Promise<{ css: string; licenses: string[] }> {
  const families =
    bodyFamily(body) + (code ? CODE_FONTS.find((entry) => entry.id === code)!.family : '');
  const selected = faces.filter(([family]) => families.includes(`"${family}"`));
  const css = (
    await Promise.all(
      selected.map(
        async ([family, url, weight]) =>
          `@font-face{font-family:"${family}";src:url("${await dataURL(url)}");font-weight:${weight};font-display:block;}`,
      ),
    )
  ).join('\n');
  return { css, licenses: [...new Set(selected.map((face) => face[3]))] };
}
