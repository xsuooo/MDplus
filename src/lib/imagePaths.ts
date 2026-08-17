export interface PendingImageReference {
  placeholder: string;
  relativePath: string;
}

/** 将待迁移图片的占位引用替换为文档内相对路径。 */
export function rewriteImageReferences(markdown: string, references: PendingImageReference[]): string {
  return references.reduce((result, reference) => {
    if (!reference.placeholder || reference.placeholder === reference.relativePath) return result;
    return result.split(reference.placeholder).join(reference.relativePath);
  }, markdown);
}
