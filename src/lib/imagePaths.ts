import { parse, postprocess, preprocess } from 'micromark';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';
import { decodeString } from 'micromark-util-decode-string';
import { normalizeIdentifier } from 'micromark-util-normalize-identifier';
import type { Token } from 'micromark-util-types';

export interface PendingImageReference {
  placeholder: string;
  relativePath: string;
}

interface ImageDestination {
  url: string;
  start: number;
  end: number;
  literal: boolean;
  referenceTitle?: string;
}

interface ImageReference {
  type: 'image' | 'link';
  token: Token;
  labelEnd?: number;
  label?: string;
  reference?: string;
  resource?: boolean;
}

function destinationSpan(markdown: string, token: Token): ImageDestination {
  return {
    url: decodeString(markdown.slice(token.start.offset, token.end.offset)),
    start: token.start.offset,
    end: token.end.offset,
    literal: markdown[token.start.offset - 1] === '<',
  };
}

/** 与编辑器使用相同的 GFM / math 语法，避免跨表格单元格误判或重写公式。 */
function imageDestinations(markdown: string): ImageDestination[] {
  const events = postprocess(parse({ extensions: [gfm(), math()] })
    .document().write(preprocess()(markdown, undefined, true)));
  const media: ImageReference[] = [];
  const destinations: ImageDestination[] = [];
  const references = new Map<string, ImageReference[]>();
  const linkReferences = new Set<string>();
  const definitions = new Map<string, { destination: ImageDestination; title: string }>();
  let definitionLabel = '';
  let definitionDestination: ImageDestination | undefined;
  let definitionTitle = '';

  for (const [kind, token, context] of events) {
    if (token.type === 'image' || token.type === 'link') {
      if (kind === 'enter') media.push({ type: token.type, token });
      else {
        const current = media.pop()!;
        if (!current.resource && !media.some((item) => item.type === 'image')) {
          const identifier = current.reference ?? current.label ?? '';
          if (current.type === 'image') {
            const images = references.get(identifier) ?? [];
            images.push(current);
            references.set(identifier, images);
          } else linkReferences.add(identifier);
        }
      }
    }
    if (token.type === 'label' && kind === 'exit' && media.length > 0) {
      media[media.length - 1].labelEnd = token.end.offset;
    }
    if (token.type === 'definition' && kind === 'exit' && definitionDestination && !definitions.has(definitionLabel)) {
      // CommonMark 的重复定义采用第一个,不用后面的同名定义覆盖。
      definitions.set(definitionLabel, { destination: definitionDestination, title: definitionTitle });
    }
    if (kind !== 'enter') continue;
    const current = media[media.length - 1];
    switch (token.type) {
      case 'definition':
        definitionDestination = undefined;
        definitionTitle = '';
        break;
      case 'definitionLabelString':
        definitionLabel = normalizeIdentifier(context.sliceSerialize(token));
        break;
      case 'definitionDestinationString':
        definitionDestination = destinationSpan(markdown, token);
        break;
      case 'definitionTitleString':
        definitionTitle = decodeString(context.sliceSerialize(token));
        break;
      case 'labelText':
        if (current) current.label = normalizeIdentifier(context.sliceSerialize(token));
        break;
      case 'referenceString':
        if (current) current.reference = normalizeIdentifier(context.sliceSerialize(token));
        break;
      case 'resource':
        if (current) current.resource = true;
        break;
      case 'resourceDestinationString':
        if (current?.type === 'image' && !media.slice(0, -1).some((item) => item.type === 'image')) {
          destinations.push(destinationSpan(markdown, token));
        }
        break;
    }
  }
  for (const [identifier, images] of references) {
    const definition = definitions.get(identifier);
    if (!definition) continue;
    if (linkReferences.has(identifier)) {
      // 共用定义时仅把图片引用转为 inline,不能顺带改变普通链接。
      for (const image of images) {
        destinations.push({
          url: definition.destination.url,
          start: image.labelEnd!,
          end: image.token.end.offset,
          literal: false,
          referenceTitle: definition.title,
        });
      }
    } else destinations.push(definition.destination);
  }
  return destinations.sort((a, b) => a.start - b.start);
}

/** 返回真实图片的解码 URL;加载、迁移和重写共用同一解析规则。 */
export function getImageUrls(markdown: string): string[] {
  return imageDestinations(markdown).map((destination) => destination.url);
}

function encodeDestination(url: string, literal: boolean): string {
  const escaped = url.replace(/&/g, '&amp;').replace(/[\\<>]/g, '\\$&');
  if (literal) return escaped;
  return /\s/.test(url) ? `<${escaped}>` : escaped.replace(/[()]/g, '\\$&');
}

/** 按源区间改写 destination;仅在共用定义时展开图片引用,保留普通链接。 */
export function rewriteImageReferences(markdown: string, references: PendingImageReference[]): string {
  if (references.length === 0) return markdown;
  const replacements = new Map(references.map((reference) => [reference.placeholder, reference.relativePath]));
  return imageDestinations(markdown).reduceRight((result, destination) => {
    const replacement = replacements.get(destination.url);
    if (replacement === undefined || replacement === destination.url) return result;
    let encoded = encodeDestination(replacement, destination.literal);
    if (destination.referenceTitle !== undefined) {
      // 解码后的换行和表格分隔符必须仍是字符引用，不能变成新的 Markdown 结构。
      const title = destination.referenceTitle.replace(/&/g, '&amp;')
        .replace(/[\u0000-\u001f\u007f|]/g, (character) => `&#${character.charCodeAt(0)};`)
        .replace(/[\\"]/g, '\\$&');
      encoded = `(${encoded}${title ? ` "${title}"` : ''})`;
    }
    return result.slice(0, destination.start) + encoded + result.slice(destination.end);
  }, markdown);
}
