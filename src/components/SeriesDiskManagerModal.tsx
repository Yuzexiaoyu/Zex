import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import * as api from '../api';
import { confirm, message } from '@tauri-apps/plugin-dialog';
import { HardDrive, X, ArrowRight, Film, XCircle, AlertTriangle, Loader2, Check, SlidersHorizontal } from 'lucide-react';
import type { DiskVolume, SeriesDiskEntry, SeriesMoveResult } from '../types';
import { useModalGamepad } from '../gamepad';

// 待移动项（剧 id → 迁移方案，同剧多次拖拽以后一次为准）
interface MoveItem {
  seriesId: string;
  title: string;
  from: string;
  to: string;
  size: number;
  targetPath: string; // 目标根目录（目标盘:\剧名\）
}

interface Props {
  onClose: () => void;
}

// 拖拽状态：与游戏库排序同款 Pointer Events 方案（HTML5 DnD 在 WebView2 不可靠）
interface DragState {
  id: string;
  x: number;
  y: number;
  startX: number;
  startY: number;
  grabDX: number;
  grabDY: number;
  active: boolean;
}

function fmtBytes(n: number): string {
  if (!n || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

// 剧名清理为 Windows 合法目录名
function safeFolderName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || '影视';
}

export default function SeriesDiskManagerModal({ onClose }: Props) {
  const [volumes, setVolumes] = useState<DiskVolume[]>([]);
  const [entries, setEntries] = useState<SeriesDiskEntry[]>([]);
  const [moves, setMoves] = useState<Record<string, MoveItem>>({});
  const [volumeError, setVolumeError] = useState('');
  const [drag, setDragState] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [cancelling, setCancelling] = useState(false); // 移动中点了「取消移动」，等待后端中止
  const [moveProgress, setMoveProgress] = useState<{ seriesId: string; title: string; done: number; total: number } | null>(null);
  const [results, setResults] = useState<SeriesMoveResult[]>([]);
  // 卷显示筛选：hiddenDrives = 被隐藏的盘符（独立持久化，与游戏磁盘管理分开）
  const [hiddenDrives, setHiddenDrives] = useState<Set<string>>(new Set());
  const [showDrivePanel, setShowDrivePanel] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const volumeRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const setDrag = (d: DragState | null) => {
    dragRef.current = d;
    setDragState(d);
  };

  // 弹窗期间手柄按键不穿透到背后（B/Esc 关闭，拖拽用鼠标）。
  // esc={!drag}：拖拽中按 Esc 只取消拖拽（onDragKeyDown），不顺手关掉整个弹窗。
  // 移动进行中禁止一切关闭（遮罩/叉/Esc/B）：取消只能走底部「取消移动」按钮，
  // 避免误关后进度显示丢失、几十 GB 复制在后台无人可见地继续
  const guardedClose = () => { if (!applying) onClose(); };
  useModalGamepad('modal:series-disk-manager', { onClose: guardedClose, esc: !drag });

  useEffect(() => {
    api.getDiskVolumes().then(setVolumes).catch((e) => setVolumeError(String(e)));
    api.getSeriesDiskLayout().then(setEntries).catch(() => {});
  }, []);

  // 读取持久化的隐藏卷列表（settings: series_disk_manager_hidden_drives，与游戏磁盘管理分开）
  useEffect(() => {
    api.getSetting('series_disk_manager_hidden_drives')
      .then((raw) => {
        if (!raw) return;
        try {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) {
            setHiddenDrives(new Set(arr.filter((d): d is string => typeof d === 'string')));
          }
        } catch { /* 损坏的持久化值忽略 */ }
      })
      .catch(() => {});
  }, []);

  // 卸载时清掉 window 级拖拽监听
  useEffect(() => () => {
    window.removeEventListener('pointermove', onDragPointerMove);
    window.removeEventListener('pointerup', onDragPointerUp);
    window.removeEventListener('keydown', onDragKeyDown);
    window.removeEventListener('blur', onDragCancel);
  }, []);

  // 监听「应用移动」的复制进度事件（后端逐文件 emit）
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<{ seriesId: string; title: string; done: number; total: number }>(
      'series-move-progress',
      (e) => { if (!cancelled) setMoveProgress(e.payload); },
    ).then((f) => { if (!cancelled) unlisten = f; });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // 「显示卷」面板：点击弹窗内其它区域由内容容器 onClick 收起；此处仅兜底窗口失焦
  useEffect(() => {
    if (!showDrivePanel) return;
    const close = () => setShowDrivePanel(false);
    window.addEventListener('blur', close);
    return () => window.removeEventListener('blur', close);
  }, [showDrivePanel]);

  // 按盘分组：有待移动标记的剧归到目标盘（视觉上"已搬过去"，撤销后回到原盘）
  const entriesByDrive = useMemo(() => {
    const map: Record<string, SeriesDiskEntry[]> = {};
    for (const e of entries) {
      const d = moves[e.seriesId] ? moves[e.seriesId].to : e.drive;
      (map[d] ||= []).push(e);
    }
    return map;
  }, [entries, moves]);

  // 盘符不在当前卷列表里的剧数（跨盘 / 无盘符）
  const unknownCount = useMemo(() => {
    const drives = new Set(volumes.map((v) => v.drive));
    let n = 0;
    for (const [d, list] of Object.entries(entriesByDrive)) {
      if (!drives.has(d)) n += list.length;
    }
    return n;
  }, [entriesByDrive, volumes]);

  // 只渲染未隐藏的卷（剧随盘一起隐藏）
  const visibleVolumes = volumes.filter((v) => !hiddenDrives.has(v.drive));

  // ─── 卷显示筛选 ────────────────────────────
  // 只在用户操作时持久化（避免挂载读取完成前误覆盖已存值）
  const persistHidden = (next: Set<string>) => {
    setHiddenDrives(next);
    void api.setSetting('series_disk_manager_hidden_drives', JSON.stringify(Array.from(next))).catch(() => {});
  };
  const toggleDrive = (drive: string) => {
    const next = new Set(hiddenDrives);
    if (next.has(drive)) next.delete(drive);
    else next.add(drive);
    persistHidden(next);
  };
  const showAllDrives = () => persistHidden(new Set());
  const hideAllDrives = () => persistHidden(new Set(volumes.map((v) => v.drive)));

  // 应用后该盘可用空间：移入的扣掉、移出的加回
  const previewFree = (drive: string): number => {
    const vol = volumes.find((v) => v.drive === drive);
    if (!vol) return 0;
    let free = vol.available;
    for (const m of Object.values(moves)) {
      if (m.to === drive) free -= m.size;
      if (m.from === drive) free += m.size;
    }
    return free;
  };

  const removeMove = (seriesId: string) => {
    setMoves((m) => {
      const next = { ...m };
      delete next[seriesId];
      return next;
    });
  };

  // 目标根目录：目标盘:\剧名\（内部结构照搬原剧根）
  const targetPathOf = (e: SeriesDiskEntry, targetDrive: string): string => {
    const drive = targetDrive.replace(/[\\/]+$/, '') + '\\';
    return `${drive}${safeFolderName(e.title)}`;
  };

  const handleDrop = (seriesId: string, targetDrive: string) => {
    const e = entries.find((x) => x.seriesId === seriesId);
    if (!e) return;
    const from = e.drive;                        // 原始归属盘
    const current = moves[seriesId]?.to ?? from; // 当前显示盘（已移动过用目标盘）
    if (current === targetDrive) return;         // 还在原处，无意义
    setResults([]); // 开始新的迁移方案，清掉上一次的应用结果
    if (targetDrive === from) {
      // 拖回原始盘 → 撤销这次移动，剧回到原始归属
      setMoves((m) => {
        const next = { ...m };
        delete next[seriesId];
        return next;
      });
      return;
    }
    setMoves((m) => ({
      ...m,
      [seriesId]: {
        seriesId,
        title: e.title,
        from,
        to: targetDrive,
        size: e.totalSize,
        targetPath: targetPathOf(e, targetDrive),
      },
    }));
  };

  // ─── Pointer 拖拽 ──────────────────────────

  const hitTestDrive = (x: number, y: number): string | null => {
    for (const [drive, el] of Object.entries(volumeRefs.current)) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return drive;
    }
    return null;
  };

  const cleanupDrag = () => {
    window.removeEventListener('pointermove', onDragPointerMove);
    window.removeEventListener('pointerup', onDragPointerUp);
    window.removeEventListener('keydown', onDragKeyDown);
    window.removeEventListener('blur', onDragCancel);
  };

  const handleCardPointerDown = (e: React.PointerEvent, series: SeriesDiskEntry) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return; // 撤销按钮不触发拖拽
    e.preventDefault(); // 防止图片原生拖拽/文本选择
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDrag({
      id: series.seriesId,
      x: e.clientX,
      y: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      grabDX: e.clientX - r.left,
      grabDY: e.clientY - r.top,
      active: false,
    });
    window.addEventListener('pointermove', onDragPointerMove);
    window.addEventListener('pointerup', onDragPointerUp);
    window.addEventListener('keydown', onDragKeyDown);
    window.addEventListener('blur', onDragCancel);
  };

  const onDragPointerMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.active && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
    setDrag({ ...d, x: e.clientX, y: e.clientY, active: true });
    setDropTarget(hitTestDrive(e.clientX, e.clientY));
  };

  const onDragPointerUp = (e: PointerEvent) => {
    cleanupDrag();
    const d = dragRef.current;
    if (!d) return;
    setDrag(null);
    setDropTarget(null);
    if (d.active) {
      const drive = hitTestDrive(e.clientX, e.clientY);
      if (drive) handleDrop(d.id, drive);
    }
  };

  const onDragKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      cleanupDrag();
      setDrag(null);
      setDropTarget(null);
    }
  };

  const onDragCancel = () => {
    cleanupDrag();
    setDrag(null);
    setDropTarget(null);
  };

  const moveCount = Object.keys(moves).length;

  // 应用迁移方案：确认 → 后端逐部剧移动（复制进度实时显示）→ 刷新数据
  const handleApply = async () => {
    if (moveCount === 0 || applying) return;
    const ok = await confirm(
      `确定要把 ${moveCount} 部影视移动到目标磁盘吗？\n\n跨盘移动会复制视频文件并删除源文件（约需几分钟到几十分钟不等），期间请勿关闭窗口。`,
      { title: '影视磁盘管理', kind: 'warning' },
    );
    if (!ok) return;
    setApplying(true);
    setResults([]);
    setMoveProgress(null);
    const plans = Object.values(moves).map((m) => ({ seriesId: m.seriesId, targetRoot: m.targetPath }));
    try {
      const res = await api.applySeriesMoves(plans);
      setResults(res);
      setMoves({});
      setDropTarget(null);
    } catch (err: any) {
      await message(`移动失败：${err?.message ?? err}`, { title: '影视磁盘管理', kind: 'error' });
    } finally {
      setApplying(false);
      setCancelling(false);
      setMoveProgress(null);
    }
    // 刷新独立于移动结果（M5）：移动已成功/部分成功，刷新失败只是界面数据旧，
    // 不能报「移动失败」误导用户
    setEntries(await api.getSeriesDiskLayout().catch(() => []));
    setVolumes(await api.getDiskVolumes().catch(() => []));
  };

  // 取消移动：置位后端取消标志 → 复制循环在下一个文件检查点中止并清理目标残留，
  // 影视文件留在原目录。applySeriesMoves 的命令会很快返回（结果里带「已取消」），
  // 到时 handleApply 的 finally 复位 applying/cancelling
  const handleCancelMove = async () => {
    if (!applying || cancelling) return;
    setCancelling(true);
    try {
      await api.cancelDiskMove();
    } catch {
      setCancelling(false); // 置位失败（极端情况）：复位按钮，可重试
    }
  };

  const draggedSeries = drag ? entries.find((e) => e.seriesId === drag.id) : null;

  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-6" onClick={guardedClose}>
      <div className="absolute inset-0 bg-black/75 backdrop-blur-md animate-fade-in" />

      <div
        className="relative w-[94vw] max-w-6xl h-[90vh] glass-modal shadow-2xl animate-scale-in flex flex-col overflow-hidden"
        onClick={(e) => {
          e.stopPropagation();
          setShowDrivePanel(false); // 点击弹窗内面板外的任意处收起「显示卷」面板
        }}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-border-glass">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-[rgba(0,212,255,0.12)] border border-[rgba(0,212,255,0.25)] flex items-center justify-center">
              <HardDrive size={18} className="text-[#00d4ff]" />
            </div>
            <div>
              <h2 className="text-lg font-bold leading-tight">磁盘管理</h2>
              <p className="text-xs text-text-secondary mt-0.5">拖拽整部剧到目标磁盘，底部查看容量预览</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {volumeError && <span className="text-xs text-[#ef4444]">{volumeError}</span>}

            {/* 卷显示筛选 */}
            <div className="relative">
              <button
                onClick={(e) => { e.stopPropagation(); setShowDrivePanel((s) => !s); }}
                className={`h-9 px-3 rounded-xl flex items-center gap-1.5 text-xs border transition-all ${
                  showDrivePanel || hiddenDrives.size > 0
                    ? 'bg-[rgba(0,212,255,0.12)] border-[rgba(0,212,255,0.3)] text-[#00d4ff]'
                    : 'bg-bg-surface border-border-glass text-text-secondary hover:text-white hover:bg-bg-surface-active'
                }`}
                title="选择要显示的卷"
              >
                <SlidersHorizontal size={14} />
                显示卷
                {hiddenDrives.size > 0 && (
                  <span className="px-1 rounded bg-[#00d4ff]/20 text-[10px]">{hiddenDrives.size}</span>
                )}
              </button>

              {showDrivePanel && (
                <div
                  className="absolute right-0 top-full mt-2 z-50 w-72 glass-modal solid-modal shadow-2xl animate-scale-in overflow-hidden"
                  style={{ borderColor: 'rgba(0, 212, 255, 0.45)' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="px-4 py-3 border-b border-border-glass flex items-center justify-between">
                    <p className="text-sm font-semibold">显示哪些卷</p>
                    <span className="text-xs text-text-tertiary">{visibleVolumes.length}/{volumes.length} 已显示</span>
                  </div>
                  <div className="p-2 max-h-64 overflow-y-auto space-y-0.5">
                    {volumes.map((v) => {
                      const checked = !hiddenDrives.has(v.drive);
                      return (
                        <label key={v.drive} className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-bg-surface-active select-none">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleDrive(v.drive)}
                            className="w-4 h-4 accent-[#00d4ff] shrink-0"
                          />
                          <span className="w-7 h-7 rounded-lg bg-bg-surface border border-border-glass flex items-center justify-center text-xs font-bold shrink-0">
                            {v.drive.replace(':', '')}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm text-text-primary leading-tight truncate">
                              {v.drive}
                              {v.label && <span className="text-text-tertiary font-normal"> · {v.label}</span>}
                            </span>
                            <span className="block text-[11px] text-text-tertiary leading-tight">
                              {fmtBytes(v.total)} · {(entriesByDrive[v.drive] || []).length} 部
                            </span>
                          </span>
                          {!checked && <span className="text-[10px] text-text-tertiary shrink-0">已隐藏</span>}
                        </label>
                      );
                    })}
                  </div>
                  <div className="px-3 py-2 border-t border-border-glass flex gap-2">
                    <button onClick={showAllDrives} className="flex-1 text-xs py-1.5 rounded-lg bg-bg-surface hover:bg-bg-surface-active text-text-secondary">全部显示</button>
                    <button onClick={hideAllDrives} className="flex-1 text-xs py-1.5 rounded-lg bg-bg-surface hover:bg-bg-surface-active text-text-secondary">全部隐藏</button>
                  </div>
                </div>
              )}
            </div>

            <button
              onClick={guardedClose}
              disabled={applying}
              className="w-9 h-9 rounded-xl flex items-center justify-center text-text-secondary hover:text-white hover:bg-bg-surface-active transition-all disabled:opacity-40 disabled:hover:bg-transparent"
              title={applying ? '移动进行中，请用「取消移动」中止' : '关闭'}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* 磁盘卡网格 */}
        <div className="flex-1 min-h-0 overflow-y-auto p-6">
          {volumes.length === 0 && !volumeError ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-text-tertiary">
              <Loader2 size={28} className="animate-spin" />
              <span className="text-sm">正在读取磁盘卷…</span>
            </div>
          ) : visibleVolumes.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-text-tertiary">
              <HardDrive size={28} className="opacity-40" />
              <span className="text-sm">所有卷已隐藏</span>
              <button onClick={() => setShowDrivePanel(true)} className="text-xs text-[#00d4ff] hover:underline">点击选择要显示的卷</button>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-5 content-start">
              {visibleVolumes.map((v) => {
                const list = entriesByDrive[v.drive] || [];
                const free = previewFree(v.drive);
                const low = free < 10 * 1024 ** 3; // 可用 < 10GB 提示
                const over = free < 0;              // 应用后空间不足
                const isDrop = dropTarget === v.drive;
                const inSize = Object.values(moves)
                  .filter((m) => m.to === v.drive)
                  .reduce((s, m) => s + m.size, 0);
                const outSize = Object.values(moves)
                  .filter((m) => m.from === v.drive)
                  .reduce((s, m) => s + m.size, 0);
                const pct = (n: number) => (v.total > 0 ? (n / v.total) * 100 : 0);
                return (
                  <div
                    key={v.drive}
                    ref={(el) => { volumeRefs.current[v.drive] = el; }}
                    className={`glass-card p-5 flex flex-col hover:transform-none transition-all ${
                      isDrop ? 'ring-2 ring-[#00d4ff]/70 border-[#00d4ff]/70' : ''
                    } ${over ? 'border-[#ef4444]/60' : ''}`}
                  >
                    {/* 盘符头 */}
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="w-10 h-10 rounded-xl bg-bg-surface border border-border-glass flex items-center justify-center text-base font-bold shrink-0">
                          {v.drive.replace(':', '')}
                        </span>
                        <div className="min-w-0">
                          <p className="text-[15px] font-semibold leading-tight truncate">
                            {v.drive}
                            {v.label && <span className="text-text-tertiary font-normal"> · {v.label}</span>}
                          </p>
                          <p className="text-xs text-text-tertiary mt-0.5 truncate">
                            {v.file_system}{v.removable ? ' · 可移动' : ''} · {fmtBytes(v.total)}
                          </p>
                        </div>
                      </div>
                      <span className="shrink-0 text-[11px] px-1.5 py-0.5 rounded-md bg-bg-surface text-text-secondary">{list.length} 部</span>
                    </div>

                    {/* 容量条：应用后实时预览 */}
                    <div className="h-2 rounded-full bg-bg-surface overflow-hidden flex mb-2">
                      <div className="h-full bg-[#00d4ff]/70 flex-none" style={{ width: `${pct(Math.max(0, v.used - outSize))}%` }} />
                      {outSize > 0 && (
                        <div className="h-full bg-amber-400/70 flex-none" style={{ width: `${pct(Math.min(outSize, v.used))}%` }} />
                      )}
                      {inSize > 0 && (
                        <div className="h-full bg-emerald-400/70 flex-none" style={{ width: `${pct(inSize)}%` }} />
                      )}
                    </div>
                    <div className="flex items-center justify-between text-xs text-text-secondary mb-3">
                      <span>已用 {fmtBytes(v.used)}</span>
                      <span>可用 {fmtBytes(v.available)}</span>
                    </div>

                    {/* 容量预览（有移动时） */}
                    {free !== v.available && (
                      <div className={`mb-3 px-2.5 py-1.5 rounded-lg text-xs border ${
                        over
                          ? 'bg-[#ef4444]/10 border-[#ef4444]/30 text-[#ef4444]'
                          : low
                            ? 'bg-amber-500/10 border-amber-500/30 text-amber-500'
                            : 'bg-[rgba(0,212,255,0.08)] border-[rgba(0,212,255,0.2)] text-[#00d4ff]'
                      }`}>
                        应用后可用 <b>{fmtBytes(free)}</b>
                        {over && '（空间不足！）'}
                      </div>
                    )}

                    {/* 剧列表 */}
                    <div className={`flex-1 min-h-0 space-y-2 ${list.length ? 'max-h-72 overflow-y-auto pr-2' : ''}`}>
                      {list.length === 0 && (
                        <div className={`h-20 rounded-xl border border-dashed flex items-center justify-center text-xs transition-colors ${
                          isDrop ? 'border-[#00d4ff]/60 text-[#00d4ff] bg-[rgba(0,212,255,0.05)]' : 'border-border-glass text-text-tertiary'
                        }`}>
                          {isDrop ? '松开以移动到此处' : '该盘暂无影视'}
                        </div>
                      )}
                      {list.map((s) => {
                        const isDragging = drag?.id === s.seriesId && drag.active;
                        const target = moves[s.seriesId];
                        return (
                          <div
                            key={s.seriesId}
                            onPointerDown={(e) => handleCardPointerDown(e, s)}
                            className={`group flex items-center gap-3 rounded-xl px-2.5 py-2 border cursor-grab active:cursor-grabbing transition-all hover:bg-bg-surface-active touch-none select-none ${
                              isDragging ? 'opacity-40' : ''
                            } ${target ? 'border-[#00d4ff]/40 bg-[rgba(0,212,255,0.06)]' : 'border-transparent'}`}
                          >
                            {s.posterPath ? (
                              <img src={convertFileSrc(s.posterPath, 'covers')} className="w-10 h-[60px] rounded object-cover shrink-0 pointer-events-none" alt="" />
                            ) : (
                              <span className="w-10 h-[60px] rounded bg-gradient-to-br from-[#00d4ff]/18 to-bg-surface border border-border-glass flex items-center justify-center shrink-0 pointer-events-none">
                                <Film size={15} className="text-text-tertiary" />
                              </span>
                            )}
                            <div className="min-w-0 flex-1 pointer-events-none">
                              <p className="text-sm font-medium text-text-primary truncate">{s.title}</p>
                              <p className="text-[11px] text-text-tertiary truncate mt-0.5">
                                {s.files.length} 集 · {fmtBytes(s.totalSize)}
                                {target && <span className="text-[#00d4ff]"> · 待移至 {target.to}</span>}
                              </p>
                            </div>
                            {target && (
                              <button onClick={() => removeMove(s.seriesId)} className="shrink-0 text-text-tertiary hover:text-[#ef4444]" title="撤销移动">
                                <XCircle size={16} />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 待移动方案列表（纵向） */}
        {moveCount > 0 && !applying && results.length === 0 && (
          <div className="shrink-0 border-t border-border-glass px-6 pt-3 pb-2">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-text-secondary">待移动方案</p>
              <span className="text-[11px] text-text-tertiary">共 {moveCount} 部 · 跨盘会复制并删除源文件</span>
            </div>
            <div className="disk-scroll-y max-h-44 overflow-y-auto space-y-1.5 pr-1">
              {Object.values(moves).map((m) => (
                <div key={m.seriesId} className="flex items-center gap-3 rounded-xl px-3 py-2 bg-[rgba(0,212,255,0.05)] border border-[rgba(0,212,255,0.15)]">
                  <span className="shrink-0 w-9 h-9 rounded-lg bg-bg-surface border border-border-glass flex items-center justify-center text-xs font-bold text-text-secondary">
                    {m.from.replace(':', '')}
                  </span>
                  <ArrowRight size={12} className="shrink-0 text-[#00d4ff]" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-text-primary truncate leading-tight">
                      {m.title}
                      <span className="ml-1.5 text-xs font-normal text-text-tertiary">{fmtBytes(m.size)}</span>
                    </p>
                    <p className="text-[11px] font-mono text-[#00d4ff] truncate leading-tight mt-0.5" title={m.targetPath}>{m.targetPath}</p>
                  </div>
                  <button onClick={() => removeMove(m.seriesId)} className="shrink-0 text-text-tertiary hover:text-[#ef4444]" title="撤销移动">
                    <XCircle size={16} />
                  </button>
                </div>
              ))}
              {unknownCount > 0 && (
                <div className="flex items-center gap-1.5 text-[11px] text-amber-500 px-1 pt-0.5">
                  <AlertTriangle size={12} /> {unknownCount} 部剧路径不在当前卷
                </div>
              )}
            </div>
          </div>
        )}

        {/* 底部：进度 + 结果 + 应用 */}
        <div className="shrink-0 border-t border-border-glass px-6 py-3">
          <div className="flex items-center gap-4">
            <div className="flex-1 min-w-0">
              {applying ? (
                // 移动进度
                moveProgress ? (
                  <div className="flex items-center gap-3">
                    <Loader2 size={15} className="animate-spin text-[#00d4ff] shrink-0" />
                    <span className="text-xs text-text-primary truncate shrink-0 max-w-44">正在移动 {moveProgress.title}</span>
                    <div className="flex-1 min-w-24 h-1.5 rounded-full bg-bg-surface overflow-hidden">
                      <div
                        className="h-full bg-[#00d4ff]/70 transition-[width] duration-200"
                        style={{ width: `${moveProgress.total > 0 ? Math.min(100, (moveProgress.done / moveProgress.total) * 100) : 0}%` }}
                      />
                    </div>
                    <span className="text-xs text-text-tertiary shrink-0">{fmtBytes(moveProgress.done)} / {fmtBytes(moveProgress.total)}</span>
                  </div>
                ) : (
                  <span className="flex items-center text-xs text-text-tertiary gap-2">
                    <Loader2 size={14} className="animate-spin" />准备中…
                  </span>
                )
              ) : results.length > 0 ? (
                // 应用结果
                <div className="disk-scroll-x flex items-center gap-2">
                  <span className="text-xs text-text-tertiary shrink-0">结果：</span>
                  {results.map((r) => (
                    <span
                      key={r.seriesId}
                      title={r.error ?? undefined}
                      className={`shrink-0 inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border max-w-lg ${
                        r.ok
                          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-500'
                          : 'bg-[#ef4444]/10 border-[#ef4444]/30 text-[#ef4444]'
                      }`}
                    >
                      {r.ok ? <Check size={12} className="shrink-0" /> : <AlertTriangle size={12} className="shrink-0" />}
                      <span className="truncate min-w-0">{r.title || '未知影视'}</span>
                      {r.ok ? '已移动' : (
                        <span className="truncate">
                          {/* 取消/拒绝的长文本（含细节）放 title，chip 内截断不溢出 */}
                          {(r.error ?? '').includes('移动已取消')
                            ? '已取消，影视留在原目录'
                            : (r.error ?? '').split('\n')[0]}
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="text-xs text-text-tertiary">拖拽剧集卡片到目标磁盘，形成迁移方案</span>
              )}
            </div>
            <div className="flex items-center gap-3 shrink-0">
              {applying ? (
                // 移动中：取消 = 完整取消机制（中止复制 → 清理目标残留 → 影视留在原目录）
                <button
                  onClick={handleCancelMove}
                  disabled={cancelling}
                  className="btn btn-ghost px-4 py-2 text-sm disabled:opacity-50"
                >
                  {cancelling ? <><Loader2 size={14} className="animate-spin" />正在取消…</> : '取消移动'}
                </button>
              ) : (
                <button onClick={onClose} className="btn btn-ghost px-4 py-2 text-sm disabled:opacity-50">
                  取消
                </button>
              )}
              <button
                onClick={handleApply}
                disabled={moveCount === 0 || applying}
                className="btn btn-accent px-5 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {applying ? <><Loader2 size={14} className="animate-spin" />移动中…</> : <><Check size={14} />应用（{moveCount}）</>}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 拖拽克隆：跟随指针 */}
      {drag?.active && draggedSeries && createPortal(
        <div
          className="drag-clone"
          style={{ left: drag.x - drag.grabDX, top: drag.y - drag.grabDY }}
        >
          <div className="flex items-center gap-3 px-2.5 py-2 rounded-xl glass-card w-64">
            {draggedSeries.posterPath ? (
              <img src={convertFileSrc(draggedSeries.posterPath, 'covers')} className="w-9 h-[54px] rounded object-cover shrink-0" alt="" />
            ) : (
              <span className="w-9 h-[54px] rounded bg-bg-surface border border-border-glass flex items-center justify-center shrink-0">
                <Film size={14} className="text-text-tertiary" />
              </span>
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-primary truncate">{draggedSeries.title}</p>
              <p className="text-[11px] text-text-tertiary truncate mt-0.5">
                {draggedSeries.drive} · {draggedSeries.files.length} 集 · {fmtBytes(draggedSeries.totalSize)}
              </p>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>,
    document.body,
  );
}
