// LRC 解析：把内嵌歌词原文拆成带时间轴的行。
// 支持：[mm:ss.xx] / [mm:ss.xxx] 两种小数位、一行多时间戳（重复段）、[offset:] 整体偏移；
// 跳过 [ti:]/[ar:] 等元数据行；顺带剥掉增强 LRC 的 <mm:ss.xx> 字级标签（只保留整行文本）
export interface LrcLine {
  timeMs: number;
  text: string;
}

const TIME_TAG = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META_TAG = /^\[([a-zA-Z#]+):(.*)\]$/;
const WORD_TAG = /<[^>]*>/g;

export function parseLrc(raw: string): LrcLine[] {
  const out: LrcLine[] = [];
  let offset = 0;
  for (const rawLine of raw.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    TIME_TAG.lastIndex = 0;
    const stamps: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = TIME_TAG.exec(line)) !== null) {
      const min = Number(m[1]);
      const sec = Number(m[2]);
      // 一位小数=十分秒，两位=厘秒，三位=毫秒
      const frac = m[3] ? Number(m[3]) * (m[3].length === 1 ? 100 : m[3].length === 2 ? 10 : 1) : 0;
      stamps.push(min * 60000 + sec * 1000 + frac);
    }

    if (stamps.length === 0) {
      // 无时间戳的行：只关心 [offset:ms]，其余元数据（ti/ar/al/by…）直接丢
      const meta = META_TAG.exec(line);
      if (meta && meta[1].toLowerCase() === 'offset') {
        const v = Number(meta[2]);
        if (Number.isFinite(v)) offset = v;
      }
      continue;
    }

    WORD_TAG.lastIndex = 0;
    const text = line.replace(TIME_TAG, '').replace(WORD_TAG, '').trim();
    for (const t of stamps) {
      out.push({ timeMs: Math.max(0, t + offset), text });
    }
  }
  out.sort((a, b) => a.timeMs - b.timeMs);
  return out;
}

// 当前进度落在哪一行：最后一个 timeMs <= posMs 的行；还没到第一句返回 -1
export function activeLineIndex(lines: LrcLine[], posMs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].timeMs <= posMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
