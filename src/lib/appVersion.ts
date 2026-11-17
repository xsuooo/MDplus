import { version } from '../../package.json';

export const APP_VERSION = version;
export const BUILD_LABEL = `MDPlus ${version} / ${__MDPLUS_BUILD_ID__}`;
export const APP_VERSION_LABEL = `v${APP_VERSION}`;
export const APP_VERSION_DETAILS = `版本与构建：${BUILD_LABEL}`;
