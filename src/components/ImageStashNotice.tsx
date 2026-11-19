import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { subscribeImageSources, unstashedImageCount } from '../lib/imageOps';
import { IconClose } from './icons';

interface ImageStashNoticeProps {
  tabId: string | null;
}

const idle = () => {};
// Static rendering has no image cache to consult.
const none = () => 0;

/** Explains missing previews while a full stash leaves images in their files. Never modal. */
export function ImageStashNotice({ tabId }: ImageStashNoticeProps) {
  const subscribe = useCallback(
    (listener: () => void) => (tabId ? subscribeImageSources(tabId, listener) : idle),
    [tabId],
  );
  const count = useSyncExternalStore(
    subscribe,
    () => (tabId ? unstashedImageCount(tabId) : 0),
    none,
  );
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());

  // A dismissal covers one occurrence: once every image is previewable again, a later one shows.
  useEffect(() => {
    if (!tabId || count) return;
    setDismissed((current) => {
      if (!current.has(tabId)) return current;
      const next = new Set(current);
      next.delete(tabId);
      return next;
    });
  }, [tabId, count]);

  if (!tabId || !count || dismissed.has(tabId)) return null;

  return (
    <div className="workflow-notice image-stash-notice" role="status" aria-live="polite">
      <span>
        {`${count} 张图片暂时无法预览。文字可以正常保存，原图片不会被改动。关闭其他含图片的文档后，再编辑或保存以恢复预览。`}
      </span>
      <button
        className="workflow-notice-close"
        onClick={() => setDismissed((current) => new Set(current).add(tabId))}
        aria-label="关闭图片预览提示"
      >
        <IconClose size={14} />
      </button>
    </div>
  );
}
