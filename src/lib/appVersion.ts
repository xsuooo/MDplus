import { version } from '../../package.json';
import { BUILD_LABEL } from './buildInfo';

export const APP_VERSION = version;
export const APP_VERSION_LABEL = `v${APP_VERSION}`;
export const APP_VERSION_DETAILS = `版本与构建：${BUILD_LABEL}`;
