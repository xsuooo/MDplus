import config from '../../config/application.json';

export const AUTO_SAVE_DELAY = config.timing.autoSaveMs;
export const EXTERNAL_POLL_MS = config.timing.externalPollMs;
export const IMAGE_PREPARATION_MS = config.timing.imagePreparationMs;
export const RECOVERY_DELAY_MS = config.timing.recoveryMs;
export const TAB_RENDER_MS = config.timing.tabRenderMs;
export const WINDOW_PERSIST_MS = config.timing.windowPersistMs;
export const SOURCE_HISTORY_COALESCE_MS = config.timing.sourceHistoryCoalesceMs;
export const PRINT_LOAD_TIMEOUT_MS = config.timing.printLoadTimeoutMs;
export const LIMITS = config.limits;
