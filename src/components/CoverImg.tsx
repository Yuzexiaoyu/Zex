import { useLayoutEffect, useRef, useState } from 'react';
import { coverCache, type CoverRequest, type CoverResult } from '../utils/cover-cache';

interface Props extends React.ImgHTMLAttributes<HTMLImageElement> {
  src: string;
  /** Statistics keep a placeholder on failure; existing library views retain the original-URL fallback. */
  failureMode?: 'original' | 'placeholder';
}

interface ImageState {
  source: string;
  result: CoverResult | null;
  status: 'loading' | 'ready' | 'error';
}

export default function CoverImg({ src, failureMode = 'original', fetchPriority = 'auto', onLoad, onError, ...rest }: Props) {
  const [state, setState] = useState<ImageState>({ source: src, result: null, status: 'loading' });
  const requestRef = useRef<{ source: string; request: CoverRequest } | null>(null);

  useLayoutEffect(() => {
    if (!src) {
      setState({ source: src, result: null, status: 'error' });
      return;
    }
    // Acquire before exposing a cached URL. A render that React abandons never pins a cache entry.
    // Layout effects publish cache hits before paint, without an unprotected render-time lookup.
    const request = coverCache.request(src, fetchPriority);
    requestRef.current = { source: src, request };
    let disposed = false;
    const publish = (result: CoverResult | null) => {
      if (!disposed) setState({ source: src, result, status: 'loading' });
    };
    publish(request.initial);
    if (!request.initial) void request.promise.then(publish);
    return () => {
      disposed = true;
      requestRef.current = null;
      request.release();
    };
  }, [src]);

  useLayoutEffect(() => {
    // Visibility can change without changing the source. Keep its lease and ready image intact.
    if (requestRef.current?.source === src) requestRef.current.request.setPriority(fetchPriority);
  }, [src, fetchPriority]);

  // A prop change must never render the previous source's blob, even before effect cleanup runs.
  const current = state.source === src ? state : null;
  const result = current?.result;
  const failedPlaceholder = result?.status === 'error' && failureMode === 'placeholder';
  const imageSrc = result?.status === 'ready' ? result.url
    : result?.status === 'error' && !failedPlaceholder ? src || undefined : undefined;
  const status = failedPlaceholder || !src ? 'error' : current?.status ?? 'loading';

  return <img
    {...rest}
    key={src}
    src={imageSrc}
    fetchPriority={fetchPriority}
    data-cover-source={src}
    data-cover-status={status}
    onLoad={(event) => {
      setState((value) => value.source === src ? { ...value, status: 'ready' } : value);
      onLoad?.(event);
    }}
    onError={(event) => {
      // A successful fetch can still contain an invalid image. Retire that blob, keeping leases
      // alive until their DOM nodes unmount; future mounts share the same failure cooldown.
      if (result?.status === 'ready') {
        if (requestRef.current?.source === src) requestRef.current.request.reportError();
        setState((value) => value.source === src
          ? { source: src, result: { status: 'error' }, status: failureMode === 'original' ? 'loading' : 'error' }
          : value);
      } else {
        setState((value) => value.source === src ? { ...value, status: 'error' } : value);
      }
      onError?.(event);
    }}
  />;
}
