// 词典合并入口：各模块词条放在 locales/ 下自己的文件里，
// 这里统一摊平成一张大表（area 前缀保证 key 不冲突，重复词条后者覆盖前者）
import { zh as commonZh, en as commonEn } from './locales/common';
import { zh as settingsZh, en as settingsEn } from './locales/settings';
import { zh as musicZh, en as musicEn } from './locales/music';
import { zh as gamesZh, en as gamesEn } from './locales/games';
import { zh as seriesZh, en as seriesEn } from './locales/series';
import { zh as statsZh, en as statsEn } from './locales/stats';
import { zh as miscZh, en as miscEn } from './locales/misc';

export const zh: Record<string, string> = {
  ...commonZh,
  ...settingsZh,
  ...musicZh,
  ...gamesZh,
  ...seriesZh,
  ...statsZh,
  ...miscZh,
};

export const en: Record<string, string> = {
  ...commonEn,
  ...settingsEn,
  ...musicEn,
  ...gamesEn,
  ...seriesEn,
  ...statsEn,
  ...miscEn,
};
