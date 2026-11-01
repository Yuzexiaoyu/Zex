// 详情首屏图片预解码。保留少量 Image 引用复用浏览器解码缓存，不扫描整个库。
interface PreparedImage {
  image: HTMLImageElement;
  bytes: number;
}

const MAX_IMAGES = 16;
const MAX_BYTES = 64 * 1024 * 1024;
const LOAD_TIMEOUT_MS = 2500;
const prepared = new Map<string, PreparedImage>();
const pending = new Map<string, Promise<void>>();
let preparedBytes = 0;

export function isImagePrepared(src: string): boolean {
  return !src || prepared.has(src);
}

function remember(src: string, image: HTMLImageElement) {
  const bytes = image.naturalWidth * image.naturalHeight * 4;
  if (bytes > MAX_BYTES) return;
  while (prepared.size >= MAX_IMAGES || preparedBytes + bytes > MAX_BYTES) {
    const oldest = prepared.keys().next().value;
    if (oldest === undefined) break;
    preparedBytes -= prepared.get(oldest)!.bytes;
    prepared.delete(oldest);
  }
  prepared.set(src, { image, bytes });
  preparedBytes += bytes;
}

function prepareImage(src: string): Promise<void> {
  if (!src) return Promise.resolve();
  const hit = prepared.get(src);
  if (hit) {
    prepared.delete(src);
    prepared.set(src, hit);
    return Promise.resolve();
  }
  const inflight = pending.get(src);
  if (inflight) return inflight;

  const promise = new Promise<void>((resolve) => {
    const image = new Image();
    image.decoding = 'async';
    let settled = false;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (success) remember(src, image);
      pending.delete(src);
      // 缺图、解码失败或读盘超时不阻塞详情页，也不缓存失败结果。
      resolve();
    };
    const timer = window.setTimeout(() => finish(false), LOAD_TIMEOUT_MS);
    image.src = src;
    void image.decode().then(() => finish(true), () => finish(false));
  });
  pending.set(src, promise);
  return promise;
}

export async function prepareImages(sources: readonly string[]): Promise<void> {
  await Promise.all([...new Set(sources.filter(Boolean))].map(prepareImage));
}
