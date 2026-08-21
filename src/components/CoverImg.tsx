import { useEffect, useState } from 'react';

// ── 封面内存缓存 <img>：解决快速滚动时封面加载不出来/闪烁 ──
// 虚拟滚动下封面 img 随行卸载/重建，每次挂载都走 covers 协议往返 +
// 解码重来；滚动速度快时协议请求被行销毁中止，滚回来白帧/闪烁。
// 这里加载统一走 fetch（组件卸载不会中止它）→ blob → objectURL 入 LRU：
//   - 缓存命中：objectURL 直出，零协议往返、零读盘
//   - 未命中：占位（无 src 显示背景色），fetch 完成才出图；失败兜底原 URL
// 关键：已显示的图绝不换 src —— img 换源会清空当前帧重新解码，内容相同
// 也会闪一下；唯一一次「出现」是从占位到图，无内容可闪。
//
// 注意这层缓存只省「重复取」，不省「解码」—— 缓存里是压缩字节，浏览器每次
// 新建 img 仍要解一遍。所以图本身的像素量必须小（音乐封面在后端已压到 256px，
// 见 lib.rs shrink_cover）；靠调大上限来压闪是无效的：解码后的位图归浏览器
// 自己的帧缓存管，装不下照样一边解一边丢。
//
// LRU 用 Map 天然保序：命中时删旧插新提升热位，超限（800 张 / 32MB 双控）
// 淘汰最旧并 revoke。?v= 版本号变化 → 新 URL 新 key，旧条目自然淘汰，
// 封面更新后不会显示旧图。
//
// refs 是挂载计数：淘汰时必须跳过还挂在 <img> 上的条目 —— objectURL 一旦
// revoke 就无法再取，浏览器丢弃已解码帧后那张图会彻底变空白。缓存容量小于
// DOM 工作集时（旧的 64MB 上限配 8MB 大图就是这样）这几乎必然发生。
interface CacheEntry { url: string; bytes: number; refs: number }
const MAX_ENTRIES = 800;
const MAX_BYTES = 32 * 1024 * 1024;
const cache = new Map<string, CacheEntry>();
let totalBytes = 0;

function overLimit(): boolean {
  return cache.size >= MAX_ENTRIES || totalBytes > MAX_BYTES;
}

function evict() {
  if (!overLimit()) return;
  // 按 LRU 顺序遍历（Map 迭代中 delete 是安全的），跳过正在显示的条目。
  // 全都在显示时什么也不淘汰 —— 宁可短暂超限，也不能吊销在用的地址
  for (const [key, entry] of cache) {
    if (!overLimit()) break;
    if (entry.refs > 0) continue;
    URL.revokeObjectURL(entry.url);
    totalBytes -= entry.bytes;
    cache.delete(key);
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

// 挂载/卸载登记：只影响能否被淘汰，不影响缓存命中。retain 交回条目对象、release
// 对着同一个对象减 —— 不按 key 减，是为了防「条目被淘汰后同 key 重新入缓存」时
// 把新条目的计数误减掉
function retain(key: string): CacheEntry | null {
  const entry = cache.get(key) ?? null;
  if (entry) entry.refs += 1;
  return entry;
}
function release(entry: CacheEntry | null) {
  if (entry) entry.refs = Math.max(0, entry.refs - 1);
}

async function loadToCache(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    const objectUrl = URL.createObjectURL(blob);
    evict();
    cache.set(url, { url: objectUrl, bytes: blob.size, refs: 0 });
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

  // 本次挂载期间把条目钉住，不许被淘汰。held 由 effect 与 fetch 回调共享：
  // 卸载/换 src 先发生时 cancelled 已置位，回调不会再去钉，held 保持 null → 无需 release
  useEffect(() => {
    if (!src) return;
    let held: CacheEntry | null = null;
    if (cache.get(src)) {
      touch(src);
      held = retain(src);
      return () => release(held);
    }
    setFallback(false);
    let cancelled = false;
    loadToCache(src).then((url) => {
      if (cancelled) return; // 已卸载：缓存照常写入，下次挂载同步命中
      // 只有本挂载周期仍活着才钉住 —— cancelled 后的回调再 retain 会永久泄漏
      // （release 对不上号）
      held = retain(src);
      if (url) setCached(url);
      else setFallback(true);
    });
    return () => {
      cancelled = true;
      release(held);
    };
  }, [src]);

  // src 为空（还没出图）时不写 src 属性 —— src="" 是无效 URL，会白拿一次失败请求
  return <img src={cached ?? (fallback ? src : undefined)} {...rest} />;
}
