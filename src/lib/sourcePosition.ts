/** Freeze wrapping metrics before a source tab becomes hidden or changes font. */
export function sourceTextLayout(input: HTMLTextAreaElement) {
  const style = getComputedStyle(input);
  const properties: Record<string, string> = {};
  for (const property of [
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'font-variant-ligatures',
    'line-height',
    'letter-spacing',
    'tab-size',
    'padding-top',
    'padding-bottom',
    'padding-left',
    'padding-right',
  ]) {
    properties[property] = style.getPropertyValue(property);
  }
  return { width: input.clientWidth, properties };
}

export function measureSourceLayout<T>(
  layout: ReturnType<typeof sourceTextLayout>,
  value: string,
  measure: (top: (offset: number) => number, lineHeight: number) => T,
): T {
  const mirror = document.createElement('div');
  for (const [property, value] of Object.entries(layout.properties))
    mirror.style.setProperty(property, value);
  Object.assign(mirror.style, {
    position: 'fixed',
    left: '-100000px',
    top: '0',
    width: `${layout.width}px`,
    boxSizing: 'border-box',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    visibility: 'hidden',
    pointerEvents: 'none',
  });
  const text = document.createTextNode(value + '\n');
  mirror.append(text);
  document.body.append(mirror);
  try {
    const origin = mirror.getBoundingClientRect().top;
    const lineHeight =
      parseFloat(layout.properties['line-height']) ||
      parseFloat(layout.properties['font-size']) * 1.7;
    return measure((offset) => {
      const at = Math.min(Math.max(0, offset), text.length - 1);
      const range = document.createRange();
      range.setStart(text, at);
      range.setEnd(text, at + 1);
      return range.getBoundingClientRect().top - origin;
    }, lineHeight);
  } finally {
    mirror.remove();
  }
}

/** Measure source offsets using the textarea's actual wrapping and font metrics. */
export function measureSourceText<T>(
  input: HTMLTextAreaElement,
  value: string,
  measure: (top: (offset: number) => number, lineHeight: number) => T,
): T {
  return measureSourceLayout(sourceTextLayout(input), value, measure);
}

export function mapSourceScroll(
  input: HTMLTextAreaElement,
  before: string,
  after: string,
  mapOffset: (offset: number) => number,
): number {
  if (!input.clientWidth || input.scrollTop === 0) return input.scrollTop;
  const anchor = measureSourceText(input, before, (top) => {
    let low = 0;
    let high = before.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (top(middle) < input.scrollTop) low = middle + 1;
      else high = middle;
    }
    return { offset: low, gap: top(low) - input.scrollTop };
  });
  return measureSourceText(input, after, (top) =>
    Math.max(0, top(mapOffset(anchor.offset)) - anchor.gap),
  );
}
