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
          ? '未能读取已保存的设置，当前使用默认显示。'
          : '设置尚未保存，当前选择仍保留在本次会话中。'}
      </span>
      <button className="btn" aria-label="重试设置" onClick={() => void onRetry()}>
        重试
      </button>
    </div>
  );
}
