/** Measure source offsets using the textarea's actual wrapping and font metrics. */
export function measureSourceText<T>(input: HTMLTextAreaElement, value: string,
  measure: (top: (offset: number) => number, lineHeight: number) => T): T {
  const style = getComputedStyle(input);
  const mirror = document.createElement('div');
  for (const property of ['font-family', 'font-size', 'font-weight', 'font-style', 'font-variant-ligatures',
    'line-height', 'letter-spacing', 'tab-size', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right']) {
    mirror.style.setProperty(property, style.getPropertyValue(property));
  }
  Object.assign(mirror.style, { position: 'fixed', left: '-100000px', top: '0', width: `${input.clientWidth}px`,
    boxSizing: 'border-box', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', visibility: 'hidden', pointerEvents: 'none' });
  const text = document.createTextNode(value + '\n');
  mirror.append(text); document.body.append(mirror);
  try {
    const origin = mirror.getBoundingClientRect().top;
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.7;
    return measure((offset) => {
      const at = Math.min(Math.max(0, offset), text.length - 1);
      const range = document.createRange(); range.setStart(text, at); range.setEnd(text, at + 1);
      return range.getBoundingClientRect().top - origin;
    }, lineHeight);
  } finally { mirror.remove(); }
}

export function mapSourceScroll(input: HTMLTextAreaElement, before: string, after: string,
  mapOffset: (offset: number) => number): number {
  if (!input.clientWidth || input.scrollTop === 0) return input.scrollTop;
  const anchor = measureSourceText(input, before, (top) => {
    let low = 0; let high = before.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (top(middle) < input.scrollTop) low = middle + 1;
      else high = middle;
    }
    return { offset: low, gap: top(low) - input.scrollTop };
  });
  return measureSourceText(input, after, (top) => Math.max(0, top(mapOffset(anchor.offset)) - anchor.gap));
}
