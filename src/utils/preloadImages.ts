// 首屏图片预解码。保留少量 Image 引用复用浏览器解码缓存，不扫描整个库。
interface PreparedImage {
  image: HTMLImageElement;
  bytes: number;
}

type ImagePriority = 'high' | 'auto' | 'low';

interface PrepareImagesOptions {
  priority?: ImagePriority;
}

interface WarmImagesOptions extends PrepareImagesOptions {
  concurrency?: number;
  signal?: AbortSignal;
}

interface PendingImage {
  image: HTMLImageElement;
  promise: Promise<void>;
  priority: ImagePriority;
}

const MAX_IMAGES = 32;
const MAX_BYTES = 64 * 1024 * 1024;
const LOAD_TIMEOUT_MS = 2500;
const PRIORITY = { low: 0, auto: 1, high: 2 };
const prepared = new Map<string, PreparedImage>();
const pending = new Map<string, PendingImage>();
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

function prepareImage(src: string, priority: ImagePriority): Promise<void> {
  if (!src) return Promise.resolve();
  const hit = prepared.get(src);
  if (hit) {
    prepared.delete(src);
    prepared.set(src, hit);
    return Promise.resolve();
  }
  const inflight = pending.get(src);
  if (inflight) {
    if (PRIORITY[priority] > PRIORITY[inflight.priority]) {
      inflight.priority = priority;
      inflight.image.fetchPriority = priority;
    }
    return inflight.promise;
  }

  let image: HTMLImageElement;
  try {
    image = new Image();
    image.decoding = 'async';
    image.fetchPriority = priority;
  } catch {
    return Promise.resolve();
  }
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  let settled = false;
  const finish = (success: boolean) => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    if (success) remember(src, image);
    pending.delete(src);
    // 缺图、解码失败或读盘超时不阻塞页面，也不缓存失败结果。
    resolve();
  };
  const timer = window.setTimeout(() => finish(false), LOAD_TIMEOUT_MS);
  pending.set(src, { image, promise, priority });
  try {
    image.src = src;
    void image.decode().then(() => finish(true), () => finish(false));
  } catch {
    finish(false);
  }
  return promise;
}

export async function prepareImages(sources: readonly string[], options: PrepareImagesOptions = {}): Promise<void> {
  const priority = options.priority ?? 'auto';
  await Promise.all([...new Set(sources.filter(Boolean))].map((src) => prepareImage(src, priority)));
}

// 后台只排队首屏来源；取消后不再启动新图片，已在途结果仍供前台复用。
export async function warmImages(sources: readonly string[], options: WarmImagesOptions = {}): Promise<void> {
  const queue = [...new Set(sources.filter(Boolean))];
  const priority = options.priority ?? 'low';
  const requested = options.concurrency ?? 2;
  const concurrency = Math.min(queue.length, Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 2);
  let next = 0;
  const work = async () => {
    while (next < queue.length && !options.signal?.aborted) {
      const src = queue[next++];
      await prepareImages([src], { priority });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, work));
}
