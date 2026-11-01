export type CoverResult = { status: 'ready'; url: string } | { status: 'error' };
export type CoverPriority = 'auto' | 'high' | 'low';

export interface CoverRequest {
  /** Null while queued/loading; a ready result is already retained by this request. */
  initial: CoverResult | null;
  promise: Promise<CoverResult | null>;
  setPriority: (priority: CoverPriority) => void;
  release: () => void;
  reportError: () => void;
}

interface CacheOptions {
  maxEntries?: number;
  maxBytes?: number;
  maxConcurrent?: number;
  maxFailures?: number;
  failureTtlMs?: number;
  fetch?: (source: string) => Promise<Response>;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  now?: () => number;
}

interface Entry { source: string; url: string; bytes: number; refs: number; retired: boolean }
interface Lease {
  priority: CoverPriority;
  entry: Entry | null;
  load: Load | null;
  released: boolean;
  result: CoverResult | null;
  resolve: (value: CoverResult | null) => void;
}
interface Load { source: string; started: boolean; waiters: Set<Lease> }
const PRIORITY_RANK: Record<CoverPriority, number> = { low: 0, auto: 1, high: 2 };

/** Compressed-byte LRU; this does not reserve decoded browser bitmaps. */
export function createCoverCache(options: CacheOptions = {}) {
  const maxEntries = options.maxEntries ?? 800;
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  const maxConcurrent = options.maxConcurrent ?? 6;
  const maxFailures = options.maxFailures ?? 800;
  const failureTtlMs = options.failureTtlMs ?? 30_000;
  const fetchImage = options.fetch ?? ((source: string) => fetch(source));
  const createUrl = options.createObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeUrl = options.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url));
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const failures = new Map<string, number>();
  const inFlight = new Map<string, Load>();
  const queue: Load[] = [];
  let totalBytes = 0;
  let residentCount = 0;
  let active = 0;

  function destroy(entry: Entry) {
    revokeUrl(entry.url);
    totalBytes -= entry.bytes;
    residentCount -= 1;
  }

  function evict() {
    // Only live image leases may exceed the budget. Releasing them immediately retries eviction.
    for (const [source, entry] of entries) {
      if (residentCount <= maxEntries && totalBytes <= maxBytes) break;
      if (entry.refs) continue;
      entries.delete(source);
      entry.retired = true;
      destroy(entry);
    }
  }

  function expireFailures() {
    const time = now();
    for (const [source, retryAt] of failures) if (retryAt <= time) failures.delete(source);
  }

  function recordFailure(source: string) {
    expireFailures();
    failures.delete(source);
    failures.set(source, now() + failureTtlMs);
    while (failures.size > maxFailures) failures.delete(failures.keys().next().value!);
  }

  function publish(lease: Lease, result: CoverResult, entry?: Entry) {
    if (lease.released) return;
    if (entry) {
      entry.refs += 1;
      lease.entry = entry;
    }
    lease.load = null;
    lease.result = result;
    lease.resolve(result);
  }

  async function run(load: Load) {
    let entry: Entry | undefined;
    try {
      const response = await fetchImage(load.source);
      if (!response.ok) throw new Error('Cover request failed');
      const blob = await response.blob();
      entry = { source: load.source, url: createUrl(blob), bytes: blob.size, refs: 0, retired: false };
      entries.set(load.source, entry);
      residentCount += 1;
      totalBytes += entry.bytes;
      failures.delete(load.source);
    } catch {
      recordFailure(load.source);
    } finally {
      const result: CoverResult = entry ? { status: 'ready', url: entry.url } : { status: 'error' };
      // Promise callbacks run later. Pin EVERY waiting consumer before eviction/pumping can run.
      for (const lease of load.waiters) publish(lease, result, entry);
      load.waiters.clear();
      inFlight.delete(load.source);
      active -= 1;
      evict();
      pump();
    }
  }

  function pump() {
    while (active < maxConcurrent && queue.length) {
      // A shared source follows its highest-priority live consumer. Scan newest first so
      // equal priorities retain LIFO ordering, including the existing remount promotion.
      let selected = queue.length - 1;
      let bestPriority = -1;
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        let priority = -1;
        for (const lease of queue[i].waiters) priority = Math.max(priority, PRIORITY_RANK[lease.priority]);
        if (priority > bestPriority) {
          selected = i;
          bestPriority = priority;
        }
        if (bestPriority === PRIORITY_RANK.high) break;
      }
      const [load] = queue.splice(selected, 1);
      load.started = true;
      active += 1;
      // An already-started fetch survives unmounts and can populate the cache for a revisit.
      void run(load);
    }
  }

  function request(source: string, priority: CoverPriority = 'auto'): CoverRequest {
    let resolve!: Lease['resolve'];
    const promise = new Promise<CoverResult | null>((done) => { resolve = done; });
    const lease: Lease = { priority, entry: null, load: null, released: false, result: null, resolve };
    expireFailures();
    const hit = entries.get(source);
    if (hit) {
      entries.delete(source);
      entries.set(source, hit);
      publish(lease, { status: 'ready', url: hit.url }, hit);
    } else if (!source || failures.has(source)) {
      publish(lease, { status: 'error' });
    } else {
      let load = inFlight.get(source);
      if (!load) {
        load = { source, started: false, waiters: new Set() };
        inFlight.set(source, load);
        queue.push(load);
      } else if (!load.started) {
        queue.splice(queue.indexOf(load), 1);
        queue.push(load); // Recently remounted rows take precedence over old offscreen requests.
      }
      lease.load = load;
      load.waiters.add(lease);
      pump();
    }

    return {
      initial: lease.result,
      promise,
      setPriority(priority) {
        // Do not release, refetch, or reorder within a priority group. The next pump reads
        // the live leases, so downgrades and released high-priority consumers also take effect.
        if (!lease.released) lease.priority = priority;
      },
      release() {
        if (lease.released) return;
        lease.released = true;
        if (lease.load) {
          const load = lease.load;
          load.waiters.delete(lease);
          if (!load.started && !load.waiters.size) {
            queue.splice(queue.indexOf(load), 1);
            inFlight.delete(load.source);
          }
          lease.load = null;
        }
        if (lease.entry) {
          lease.entry.refs -= 1;
          if (lease.entry.retired && !lease.entry.refs) destroy(lease.entry);
          lease.entry = null;
        }
        lease.resolve(null);
        evict();
      },
      reportError() {
        const entry = lease.entry;
        // A late error from an old retired blob must not poison a newer replacement entry.
        if (!entry || entries.get(source) !== entry) return;
        entries.delete(source);
        entry.retired = true;
        recordFailure(source);
        // All mounted references, including this failed image, keep their object URL until release.
      },
    };
  }

  return {
    request,
    getStats: () => ({ entries: residentCount, bytes: totalBytes, failures: failures.size, active, queued: queue.length }),
  };
}

export const coverCache = createCoverCache();
