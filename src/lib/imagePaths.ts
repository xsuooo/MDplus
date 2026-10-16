export interface PendingImageReference {
  placeholder: string;
  relativePath: string;
}

/** 将待迁移图片的占位引用替换为文档内相对路径。 */
export function rewriteImageReferences(markdown: string, references: PendingImageReference[]): string {
  const replacements = new Map(references.map((reference) => [reference.placeholder, reference.relativePath]));
  return markdown.replace(/(!\[[^\]]*\]\()([^)\s]+)/g, (match, prefix: string, url: string) => {
    const replacement = replacements.get(url);
    return replacement ? `${prefix}${replacement}` : match;
  });
}
