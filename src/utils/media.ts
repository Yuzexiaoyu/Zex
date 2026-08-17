import { convertFileSrc } from '@tauri-apps/api/core';
import { t } from '../i18n';

// 本地封面/剧照的可访问 URL。
// version 用于打破 WebView 缓存：TMDB 重新获取后文件名不变（series_{id}.jpg），
// 不带版本号的话页面会一直显示旧图；covers 协议只解析 path，query 会被忽略，附加安全。
export function coverSrc(path: string, version?: string): string {
  if (!path) return '';
  const url = convertFileSrc(path, 'covers');
  return version ? `${url}?v=${encodeURIComponent(version)}` : url;
}

// 秒 → "3h 21m" / "45m" / "12s"（游戏时长与剧集累计观看时长共用）
export function formatDuration(seconds: number): string {
  if (!seconds) return '-';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`; // 不足 1 分钟显示秒数，避免看着像 0m
}

// 秒 → { h, m }：统计页英雄区要把数字和单位分开排版（大数字 + 小单位），
// 所以返回结构而不是拼好的字符串
export function splitHoursMinutes(seconds: number): { h: number; m: number } {
  const s = Math.max(0, Math.floor(seconds || 0));
  return { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) };
}

// 秒 → "266 小时 42 分" / "42 分钟"（统计页用；formatDuration 的 "3h 21m" 在大字号下太西式）
export function formatHoursMinutes(seconds: number): string {
  const { h, m } = splitHoursMinutes(seconds);
  if (h > 0) return m > 0 ? t('common.duration.hoursMinutes', { h, m }) : t('common.duration.hours', { n: h });
  if (m > 0) return t('common.duration.minutes', { n: m });
  // 0 和"有记录但不足 1 分钟"要分开：前者是真没玩过，后者是玩了几十秒
  return seconds > 0 ? t('common.duration.underMinute') : t('common.duration.zero');
}

// 分钟 → "1 小时 02 分" / "45 分钟"
export function formatRuntime(minutes: number): string {
  if (!minutes || minutes <= 0) return '';
  if (minutes < 60) return t('common.duration.minutes', { n: minutes });
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? t('common.duration.hoursMinutesPadded', { h, m: String(m).padStart(2, '0') }) : t('common.duration.hours', { n: h });
}

// "2022-04-09" → "2022"
export function yearOf(date: string): string {
  const y = (date || '').slice(0, 4);
  return /^\d{4}$/.test(y) ? y : '';
}

// 观看进度百分比（0-100），无时长数据时返回 0
export function watchPercent(watchedMs: number, runtimeMinutes: number): number {
  if (!watchedMs || !runtimeMinutes) return 0;
  return Math.max(0, Math.min(100, (watchedMs / 60000 / runtimeMinutes) * 100));
}

// 去掉视频文件名后缀（老数据里集标题可能是 "xxx.S01E01.mp4"）
export function cleanEpisodeTitle(title: string, episodeNumber: number): string {
  const cleaned = (title || '').replace(/\.[^./\\]+$/, '').trim();
  return cleaned || t('common.episodeN', { n: episodeNumber });
}
