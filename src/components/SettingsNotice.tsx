interface SettingsNoticeProps {
  error: 'load' | 'save' | null;
  onRetry: () => Promise<void>;
}

export function SettingsNotice({ error, onRetry }: SettingsNoticeProps) {
  if (!error) return null;
  return (
    <div className="settings-notice" role="alert" data-settings-error={error}>
      <span>
        {error === 'load'
          ? '无法读取设置，暂时使用默认设置。'
          : '设置未能保存，当前选择仅在这次打开时有效。'}
      </span>
      <button className="btn" aria-label="重试设置" onClick={() => void onRetry()}>
        重试
      </button>
    </div>
  );
}
