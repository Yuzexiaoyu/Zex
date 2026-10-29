import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { X, Loader2, FolderOpen } from 'lucide-react';
import * as api from '../api';
import type { Game } from '../types';
import { useT } from '../i18n';

// 右键「解压恢复」：选目录 → 把已归档游戏的压缩包解回磁盘，可选解压后删除压缩包。
export default function GameRestoreDialog({ game, onClose, onBusy, onRefresh }: {
  game: Game; onClose: () => void; onBusy: (b: boolean) => void; onRefresh: () => Promise<void>;
}) {
  const t = useT();
  const [targetDir, setTargetDir] = useState('');
  const [deleteArchive, setDeleteArchive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [progress, setProgress] = useState<api.GameRestoreProgress | null>(null);
  const [result, setResult] = useState<api.GameRestoreResult | null>(null);
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; unlistenRef.current?.(); unlistenRef.current = null; };
  }, []);

  const pickDir = async () => {
    setChoosing(true);
    try {
      const sel = await open({ directory: true, multiple: false, title: t('games.restorePickDir') });
      if (typeof sel === 'string' && mounted.current) setTargetDir(sel);
    } catch (e) { if (mounted.current) setError(String(e)); }
    finally { if (mounted.current) setChoosing(false); }
  };

  // 目录选择只在用户点「选择解压目录」时弹出，不在打开弹窗时自动弹。
  const close = () => { if (!busyRef.current && !choosing) onClose(); };

  const start = async () => {
    if (busyRef.current || !targetDir.trim() || choosing) return;
    busyRef.current = true; onBusy(true);
    setBusy(true); setError(''); setResult(null);
    setProgress({ gameId: game.id, phase: 'extracting', percent: 0 });
    try {
      const stop = await listen<api.GameRestoreProgress>('game-archive-progress', (e) => {
        if (mounted.current && e.payload.gameId === game.id) setProgress(e.payload);
      });
      if (!mounted.current) { stop(); return; }
      unlistenRef.current = stop;
      const res = await api.decompressGame(game.id, targetDir.trim(), deleteArchive);
      if (mounted.current) setResult(res);
    } catch (e) {
      if (mounted.current) setError(t('games.restoreFailed', { msg: String(e) }));
    } finally {
      unlistenRef.current?.(); unlistenRef.current = null;
      try { await onRefresh(); } catch { /* 刷新失败不影响解压结果展示 */ }
      busyRef.current = false; onBusy(false);
      if (mounted.current) setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[320] flex items-center justify-center p-6" onClick={(e) => { e.stopPropagation(); close(); }}>
      <div className="absolute inset-0 bg-black/75 backdrop-blur-md" />
      <div role="dialog" aria-modal="true" className="relative glass-modal solid-modal w-[560px] max-w-full max-h-[85vh] overflow-y-auto p-6 space-y-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold">{t('games.restoreTitle')} · {game.name}</h2>
          <button onClick={close} disabled={busy || choosing} className="btn btn-ghost disabled:opacity-40" aria-label={t('common.close')}><X size={18} /></button>
        </div>
        <div className="text-xs text-text-secondary break-all select-text">{game.archive_path}</div>
        {!result && <>
          <div className="space-y-1.5">
            <span className="block text-xs font-medium text-text-secondary">{t('games.restoreTargetHint')}</span>
            <div className="flex gap-2 items-center">
              <div className="input flex-1 min-w-0 text-xs flex items-center overflow-hidden">
                <span className="truncate">{targetDir || <span className="text-text-tertiary">{t('games.restoreNoDir')}</span>}</span>
              </div>
              <button className="btn btn-ghost text-xs shrink-0" onClick={pickDir} disabled={busy || choosing}><FolderOpen size={14} /> {t('games.restorePickDir')}</button>
            </div>
          </div>
          <label className="flex gap-2 items-center text-xs text-text-secondary cursor-pointer">
            <input type="checkbox" className="accent-[#00d4ff]" checked={deleteArchive} onChange={(e) => setDeleteArchive(e.target.checked)} disabled={busy} />
            <span>{t('games.restoreDeleteArchive')}</span>
          </label>
        </>}
        {busy && progress && <div className="space-y-2 text-sm" role="status">
          <p className="flex items-center gap-2"><Loader2 size={15} className="animate-spin" />{t(`games.restorePhase.${progress.phase}`)} · {Math.round(Math.max(0, Math.min(100, progress.percent || 0)))}%</p>
          <p className="text-xs text-text-secondary">{t('games.restoreBusy')}</p>
        </div>}
        {result && <div className="rounded-xl border border-border-glass p-4 space-y-2 text-sm break-all select-text">
          <p className={result.warning ? 'text-amber-400 font-semibold' : 'text-emerald-400 font-semibold'}>{t('games.restoreComplete')}</p>
          <p>{t('games.restoreInstallDir', { dir: result.installDir })}</p>
          <p className="text-text-secondary text-xs">{t(result.archiveDeleted ? 'games.restoreArchiveDeleted' : 'games.restoreArchiveKept')}</p>
          {result.warning && <p className="text-amber-400 whitespace-pre-wrap">{result.warning}</p>}
        </div>}
        {error && <p role="alert" className="text-sm text-red-400 whitespace-pre-wrap break-all select-text">{error}</p>}
        <div className="flex justify-end gap-3">
          {!busy && <button className="btn btn-ghost text-sm" onClick={close} disabled={choosing}>{t('common.close')}</button>}
          {!result && <button className="btn btn-accent text-sm disabled:opacity-40" onClick={start} disabled={busy || choosing || !targetDir.trim()}>{t('games.restoreStart')}</button>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

