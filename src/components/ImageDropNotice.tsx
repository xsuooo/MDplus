import type { ImageDropProgress, ImageDropResult } from '../lib/imageDrop';
import { displayPath } from '../lib/pathDisplay';
import { IconClose } from './icons';

interface ImageDropNoticeProps {
  result: ImageDropResult | null;
  progress: ImageDropProgress | null;
  onDismiss: () => void;
}

const reasons: Record<NonNullable<ImageDropResult['reason']>, string> = {
  'no-document': '请先新建或打开文稿，再插入图片。',
  'outside-editor': '请将图片拖到文稿正文中的插入位置。',
  'target-closed': '原文稿已关闭，本次图片插入已取消。',
  'editor-unavailable': '编辑器尚未准备好，请稍后重新插入图片。',
  'target-changed': '原文稿已切换编辑模式，本次图片插入已取消。请重新插入。',
};

export function ImageDropNotice({ result, progress, onDismiss }: ImageDropNoticeProps) {
  if (progress)
    return (
      <div className="workflow-notice image-drop-notice" role="status" aria-live="polite">
        <span>
          正在插入图片，已处理 {progress.completed} / {progress.total} 张…
        </span>
      </div>
    );
  if (!result || (!result.reason && !result.inserted && !result.failures.length)) return null;
  const message = result.reason
    ? reasons[result.reason]
    : result.failures.length
      ? result.inserted
        ? `已插入 ${result.inserted} 张图片，${result.failures.length} 张未能插入。`
        : `有 ${result.failures.length} 张图片未能插入。`
      : `已插入 ${result.inserted} 张图片。Ctrl+Z 可撤销本批插入。`;

  return (
    <div className="workflow-notice image-drop-notice" role="status" aria-live="polite">
      {result.failures.length ? (
        <details>
          <summary>{message}</summary>
          <ul>
            {result.failures.map((failure, index) => (
              <li key={`${failure.path}:${index}`}>
                <span className="workflow-notice-path">{displayPath(failure.path)}</span>
                <span>{failure.message}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <span>{message}</span>
      )}
      <button className="workflow-notice-close" onClick={onDismiss} aria-label="关闭图片导入提示">
        <IconClose size={14} />
      </button>
    </div>
  );
}
