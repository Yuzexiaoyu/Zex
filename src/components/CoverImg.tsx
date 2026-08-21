import { useEffect, useState } from 'react';

// ── 封面内存缓存 <img>：解决快速滚动时封面加载不出来/闪烁 ──
// 虚拟滚动下封面 img 随行卸载/重建，每次挂载都走 covers 协议往返 +
// 解码重来；滚动速度快时协议请求被行销毁中止，滚回来白帧/闪烁。
// 这里加载统一走 fetch（组件卸载不会中止它）→ blob → objectURL 入 LRU：
//   - 缓存命中：objectURL 直出，零协议往返、零读盘
//   - 未命中：占位（空 src 显示背景色），fetch 完成才出图；失败兜底原 URL
// 关键：已显示的图绝不换 src —— img 换源会清空当前帧重新解码，内容相同
// 也会闪一下；唯一一次「出现」是从占位到图，无内容可闪。
//
// LRU 用 Map 天然保序：命中时删旧插新提升热位，超限（500 张 / 64MB 双控）
// 淘汰最旧并 revoke。?v= 版本号变化 → 新 URL 新 key，旧条目自然淘汰，
// 封面更新后不会显示旧图。
interface CacheEntry { url: string; bytes: number }
const MAX_ENTRIES = 500;
const MAX_BYTES = 64 * 1024 * 1024;
const cache = new Map<string, CacheEntry>();
let totalBytes = 0;

function evict() {
  while (cache.size >= MAX_ENTRIES || totalBytes > MAX_BYTES) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) return;
    const entry = cache.get(oldestKey)!;
    URL.revokeObjectURL(entry.url);
    totalBytes -= entry.bytes;
    cache.delete(oldestKey);
  }
}

// 命中即提到最新位（Map 删旧插新）
function touch(key: string) {
  const entry = cache.get(key);
  if (entry) {
    cache.delete(key);
    cache.set(key, entry);
  }
}

async function loadToCache(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    const objectUrl = URL.createObjectURL(blob);
    evict();
    cache.set(url, { url: objectUrl, bytes: blob.size });
    totalBytes += blob.size;
    return objectUrl;
  } catch {
    return null; // 调用方兜底原 URL 直连
  }
}

interface Props extends React.ImgHTMLAttributes<HTMLImageElement> {
  src: string;
}

export default function CoverImg({ src, ...rest }: Props) {
  // 初始同步命中缓存（常驻列表行重挂载时首帧即出图）
  const [cached, setCached] = useState<string | null>(() => {
    if (!src) return null;
    const hit = cache.get(src);
    if (hit) touch(src);
    return hit?.url ?? null;
  });
  // fetch 失败才切原 URL 兜底（正常路径永远不出现）
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    if (!src) return;
    if (cache.get(src)) {
      touch(src);
      return;
    }
    setFallback(false);
    let cancelled = false;
    loadToCache(src).then((url) => {
      if (cancelled) return; // 已卸载：缓存照常写入，下次挂载同步命中
      if (url) setCached(url);
      else setFallback(true);
    });
    return () => { cancelled = true; };
  }, [src]);

  return <img src={cached ?? (fallback ? src : '')} {...rest} />;
}
