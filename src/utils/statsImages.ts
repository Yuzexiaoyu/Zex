import type { TopEntry } from '../types';
import { coverSrc } from './media';

export function statsCoverSrc(entry: TopEntry): string {
  return coverSrc(entry.wide_path || entry.cover_path);
}
