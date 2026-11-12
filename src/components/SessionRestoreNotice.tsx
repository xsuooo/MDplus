import { useEffect, useState } from 'react';
import { IconClose } from './icons';
import { displayPath } from '../lib/pathDisplay';

interface SessionFailure {
  path: string;
  title: string;
  message: string;
}

interface SessionRestoreNoticeProps {
  failures: readonly SessionFailure[];
  busy: boolean;
  onRetry: () => void;
}

export function SessionRestoreNotice({ failures, busy, onRetry }: SessionRestoreNoticeProps) {
  const [dismissed, setDismissed] = useState(false);
  const failureSignature = JSON.stringify(failures);
  useEffect(() => setDismissed(false), [failureSignature]);
  useEffect(() => {
    if (busy) setDismissed(false);
  }, [busy]);
  if (!failures.length || dismissed) return null;
  const documentCount = failures.filter((failure) => failure.path).length;

  return (
    <div className="workflow-notice session-restore-notice" role="status" aria-live="polite">
      <details>
        <summary>
          {documentCount
            ? `有 ${documentCount} 个文稿未能恢复，可重试`
            : '会话记录需要处理，可重试'}
        </summary>
        <ul>
          {failures.map((failure, index) => (
            <li key={`${failure.path}:${index}`}>
              <strong>{failure.title}</strong>
              {failure.path && (
                <span className="workflow-notice-path">{displayPath(failure.path)}</span>
              )}
              <span>{failure.message}</span>
            </li>
          ))}
        </ul>
      </details>
      <button className="btn" onClick={onRetry} disabled={busy}>
        {busy ? '正在重试…' : '重试恢复'}
      </button>
      <button
        className="workflow-notice-close"
        onClick={() => setDismissed(true)}
        aria-label="关闭会话恢复提示"
        title="关闭提示，仍可在最近打开菜单中重试"
      >
        <IconClose size={14} />
      </button>
    </div>
  );
}
