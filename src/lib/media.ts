interface MediaSize {
  title: string;
  width: number;
  height: number;
}
export type MediaPreview = MediaSize & ({ kind: 'image'; src: string } | { kind: 'diagram'; src: string; svg: string });

export function fitMedia(width: number, height: number, availableWidth: number, availableHeight: number): number {
  if (![width, height, availableWidth, availableHeight].every((value) => Number.isFinite(value) && value > 0)) return 1;
  return Math.min(1, availableWidth / width, availableHeight / height);
}

/** Accept only Mermaid's strict-sanitized SVG; display it in inert SVG image mode. */
export function diagramPreview(markup: string, fontCSS: string): Omit<MediaPreview & { kind: 'diagram' }, 'src'> & { imageSVG: string } {
  const doc = new DOMParser().parseFromString(markup, 'text/html');
  const svg = doc.querySelector('svg');
  const bounds = svg?.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  const width = bounds?.[2] ?? 0;
  const height = bounds?.[3] ?? 0;
  if (!svg || ![width, height].every((value) => Number.isFinite(value) && value > 0)) throw new Error('图表尺寸无效');
  svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height));
  svg.style.cssText = 'max-width:none';
  const serialized = svg.outerHTML;
  const fonts = doc.createElementNS('http://www.w3.org/2000/svg', 'style');
  fonts.textContent = fontCSS; svg.append(fonts);
  return { kind: 'diagram', title: '图表', svg: serialized, imageSVG: new XMLSerializer().serializeToString(svg), width, height };
}
