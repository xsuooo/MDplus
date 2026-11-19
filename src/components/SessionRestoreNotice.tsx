import { useEffect, useState } from 'react';
import { IconClose } from './icons';

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

export function SessionRestoreNotice({
  failures: entries,
  busy,
  onRetry,
}: SessionRestoreNoticeProps) {
  const failures = entries.filter((failure) => !failure.path);
  const [dismissed, setDismissed] = useState(false);
  const failureSignature = JSON.stringify(failures);
  useEffect(() => setDismissed(false), [failureSignature]);
  useEffect(() => {
    if (busy) setDismissed(false);
  }, [busy]);
  if (!failures.length || dismissed) return null;

  return (
    <div className="workflow-notice session-restore-notice" role="status" aria-live="polite">
      <details>
        <summary>上次打开的文档列表暂时不可用</summary>
        <ul>
          {failures.map((failure, index) => (
            <li key={`${failure.path}:${index}`}>
              <strong>{failure.title}</strong>
              <span>{failure.message}</span>
            </li>
          ))}
        </ul>
      </details>
      <button className="btn" onClick={onRetry} disabled={busy}>
        {busy ? '正在重试…' : '重试'}
      </button>
      <button
        className="workflow-notice-close"
        onClick={() => setDismissed(true)}
        aria-label="关闭重新打开提示"
        title="关闭提示，仍可在最近打开菜单中重试"
      >
        <IconClose size={14} />
      </button>
    </div>
  );
}
