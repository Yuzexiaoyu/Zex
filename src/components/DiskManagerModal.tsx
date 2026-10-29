import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useAppStore } from '../store';
import * as api from '../api';
import { confirm, message, save } from '@tauri-apps/plugin-dialog';
import { HardDrive, X, ArrowRight, Gamepad2, XCircle, AlertTriangle, Loader2, Check, SlidersHorizontal, Info } from 'lucide-react';
import type { DiskVolume, Game, GameMoveResult } from '../types';
import { useModalGamepad } from '../gamepad';
import { useT } from '../i18n';
import { useDiskManagerLayout } from '../utils/useDiskManagerLayout';
import GameRestoreDialog from './GameRestoreDialog';

// 待移动项（游戏 id → 迁移方案，同游戏多次拖拽以后一次为准）
interface MoveItem {
  gameId: string;
  name: string;
  from: string;
  to: string;
  size: number;
  targetPath: string; // 迁移目标完整路径
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
  grabDX: number;   // 指针在卡片内的抓取偏移（克隆跟随用）
  grabDY: number;
  active: boolean;  // 超过 4px 阈值才算真正拖拽（低于阈值视为普通点击）
}

function fmtBytes(n: number): string {
  if (!n || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

// 目录大小会话缓存（模块级，应用生命周期内）：磁盘管理每次打开都全量重算几十 GB
// 要等几分钟，同一会话内重开直接读缓存（游戏装卸后重启应用即重新计算，缓存只加速重复打开）
const folderSizeCache = new Map<string, number>();
let folderSizeGeneration = 0;

// 游戏归属盘符：优先 install_dir（Steam 游戏带完整目录），否则 exe_path 首字母；
// 无法判定返回 null（渲染处翻译成「未知」）
function driveOf(g: Game, volumes: DiskVolume[]): string | null {
  const p = (g.archive_status ? g.archive_path || '' : g.install_dir || g.exe_path || '').trim();
  const m = /^([a-zA-Z]):/.exec(p);
  if (m) return m[1].toUpperCase() + ':';
  // UNC 路径（如游戏压缩包存到 NAS：\\NAS\share\...）：按 UNC 根匹配到对应的网络映射盘，
  // 否则归档到 NAS 的游戏会落到「未知」而不是它所在的映射盘卡片
  if (p.startsWith('\\\\')) {
    const lower = p.toLowerCase().replace(/\//g, '\\');
    for (const v of volumes) {
      const u = (v.unc || '').toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
      if (u && (lower === u || lower.startsWith(u + '\\'))) return v.drive;
    }
  }
  return null;
}

// 大小计算路径：install_dir 即整个安装目录；否则用 exe_path 所在目录
function sizePathOf(g: Game): string | null {
  const inst = (g.install_dir || '').trim();
  if (inst) return inst;
  const exe = (g.exe_path || '').trim();
  if (exe) return exe.replace(/\\[^\\/]*$/, '');
  return null;
}

// 游戏安装目录的文件夹名（迁移后的目录名）
function folderNameOf(g: Game): string {
  const p = (g.install_dir || g.exe_path || '').trim();
  const segs = p.split(/[\\/]/).filter(Boolean);
  return segs[segs.length - 1] || g.name;
}

// 迁移目标完整路径：
// Steam 游戏（steam_appid > 0）→ 优先目标盘已有 Steam 库的 steamapps\common\<游戏文件夹>
//   （已有库（如 D:\Steam）时不再新建 SteamLibrary 目录 —— 后者 Steam 客户端不识别）；
//   目标盘没有库 → 目标盘:\SteamLibrary\steamapps\common\<游戏文件夹>
// 普通游戏 → 目标盘根目录\<游戏文件夹>
function targetPathOf(g: Game, targetDrive: string, steamLibPaths: string[]): string {
  const folder = folderNameOf(g);
  const drive = targetDrive.replace(/[\\/]+$/, '') + '\\';
  // 已归档游戏移动的是压缩包本身：落到目标盘根目录、保留原文件名
  if (g.archive_status) {
    const base = (g.archive_path || '').split(/[\\/]/).filter(Boolean).pop() || `${g.name}.7z`;
    return `${drive}${base}`;
  }
  if (g.steam_appid > 0) {
    // 盘符匹配的已有库路径（后端已按 steam 根优先 + 只留仍存在的目录）
    const driveLetter = targetDrive.replace(':', '').toUpperCase();
    const lib = steamLibPaths.find((p) => {
      const m = /^([a-zA-Z]):/.exec(p);
      return m && m[1].toUpperCase() === driveLetter;
    });
    const base = lib ? lib.replace(/[\\/]+$/, '') : `${drive}SteamLibrary`;
    return `${base}\\steamapps\\common\\${folder}`;
  }
  return `${drive}${folder}`;
}

export default function DiskManagerModal({ onClose }: Props) {
  const t = useT();
  const modalRef = useDiskManagerLayout();
  const games = useAppStore((s) => s.games);
  const loadGames = useAppStore((s) => s.loadGames);
  const [volumes, setVolumes] = useState<DiskVolume[]>(api.getCachedDiskVolumes);
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const [moves, setMoves] = useState<Record<string, MoveItem>>({});
  const [steamLibPaths, setSteamLibPaths] = useState<string[]>([]); // 已有 Steam 库路径（移动目标优先用它们）
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [volumeError, setVolumeError] = useState('');
  const [drag, setDragState] = useState<DragState | null>(null);
  const [applying, setApplying] = useState(false);
  const [cancelling, setCancelling] = useState(false); // 移动中点了「取消移动」，等待后端中止
  const [moveProgress, setMoveProgress] = useState<{ gameId: string; name: string; done: number; total: number } | null>(null);
  const [results, setResults] = useState<GameMoveResult[]>([]);
  // Steam 一键静默重启状态：restartDone = 重启成功，chip 收起避免重复触发
  const [restarting, setRestarting] = useState(false);
  const [restartDone, setRestartDone] = useState(false);
  // 卷显示筛选：hiddenDrives = 被隐藏的盘符（持久化到 settings）
  const [hiddenDrives, setHiddenDrives] = useState<Set<string>>(new Set());
  const [showDrivePanel, setShowDrivePanel] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  // 磁盘卡 DOM 引用（命中测试：松手时坐标落在哪张卡 → 移动目标）
  const volumeRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // 与 setState 同步维护 ref，pointer 事件回调里读的是最新值（避免闭包过期）
  const setDrag = (d: DragState | null) => {
    dragRef.current = d;
    setDragState(d);
  };

  // 弹窗期间手柄按键不穿透到背后（B/Esc 关闭，拖拽用鼠标）。
  // esc={!drag}：拖拽中按 Esc 只取消拖拽（onDragKeyDown），不顺手关掉整个弹窗。
  // 移动进行中禁止一切关闭（遮罩/叉/Esc/B）：取消只能走底部「取消移动」按钮，
  // 避免误关后进度显示丢失、几十 GB 复制在后台无人可见地继续
  const [archiveGame, setArchiveGame] = useState<Game | null>(null);
  const [restoreGame, setRestoreGame] = useState<Game | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveMenu, setArchiveMenu] = useState<{ game: Game; x: number; y: number } | null>(null);
  const [archiveMenuPos, setArchiveMenuPos] = useState({ left: 0, top: 0 });
  const archiveMenuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!archiveMenu || !archiveMenuRef.current) return;
    const el = archiveMenuRef.current;
    setArchiveMenuPos({
      left: Math.max(8, Math.min(archiveMenu.x, window.innerWidth - el.offsetWidth - 8)),
      top: Math.max(8, Math.min(archiveMenu.y, window.innerHeight - el.offsetHeight - 8)),
    });
    el.querySelector('button')?.focus();
  }, [archiveMenu]);
  useEffect(() => {
    if (!archiveMenu) return;
    const close = () => setArchiveMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [archiveMenu]);
  const guardedClose = () => {
    if (archiveMenu) { setArchiveMenu(null); return; }
    if (!applying && !archiveBusy && !archiveGame && !restoreGame) onClose();
  };
  useModalGamepad('modal:disk-manager', { onClose: guardedClose, esc: !drag });

  // 磁盘管理「删除」：强删——已归档删 .7z，普通游戏删整个安装目录，再删库记录。二次确认后执行。
  const handleDiskDelete = async (g: Game) => {
    setArchiveMenu(null);
    const target = (g.archive_status ? g.archive_path : g.install_dir) || '';
    const ok = await confirm(
      t(g.archive_status ? 'games.diskDeleteArchiveConfirm' : 'games.diskDeleteGameConfirm', { path: target }),
      { title: `${t('games.deleteGame')} · ${g.name}`, kind: 'warning' },
    );
    if (!ok) return;
    try {
      await api.deleteGameAndFiles(g.id);
      folderSizeGeneration++;
      folderSizeCache.clear();
      setSizes({});
      await Promise.all([loadGames(), api.getDiskVolumes().then(setVolumes)]);
    } catch (e: any) {
      await message(t('games.diskDeleteFailed', { msg: typeof e === 'string' ? e : (e?.message ?? String(e)) }), { kind: 'error' });
    }
  };

  // 先展示会话快照，卷容量后台刷新；关闭后忽略迟到的结果。
  useEffect(() => {
    let cancelled = false;
    api.preloadDiskVolumes()
      .then((volumes) => { if (!cancelled) setVolumes(volumes); })
      .catch((e) => { if (!cancelled) setVolumeError(String(e)); });
    return () => { cancelled = true; };
  }, []);

  // 拉取已有 Steam 库路径（移动 Steam 游戏时优先落进目标盘的已有库）
  useEffect(() => {
    api.steamLibraryPaths().then(setSteamLibPaths).catch(() => {});
  }, []);

  // 读取持久化的隐藏卷列表（settings: disk_manager_hidden_drives）
  useEffect(() => {
    api.getSetting('disk_manager_hidden_drives')
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

  // 并发计算各游戏安装目录大小（界面加载后逐步填充，不阻塞）。
  // 大小走会话缓存（模块级 Map）：磁盘管理每次打开都全量重算几十 GB 要等几分钟，
  // 同一会话内重开直接读缓存（游戏装卸后重启应用即重新计算，缓存只加速重复打开）
  useEffect(() => {
    let cancelled = false;
    const generation = folderSizeGeneration;
    const jobs: { id: string; path: string }[] = [];
    for (const g of games) {
      if (g.archive_status) {
        setSizes((s) => ({ ...s, [g.id]: g.archive_size || 0 }));
        continue;
      }
      const p = sizePathOf(g);
      if (p) jobs.push({ id: g.id, path: p });
    }
    let i = 0;
    const worker = async () => {
      while (i < jobs.length && !cancelled && generation === folderSizeGeneration) {
        const job = jobs[i++];
        const cached = folderSizeCache.get(job.path);
        if (cached !== undefined) {
          if (!cancelled) setSizes((s) => ({ ...s, [job.id]: cached }));
          continue;
        }
        const size = await api.getFolderSize(job.path).catch(() => 0);
        if (!cancelled && generation === folderSizeGeneration) {
          folderSizeCache.set(job.path, size);
          setSizes((s) => ({ ...s, [job.id]: size }));
        }
      }
    };
    // 并发 4 个 worker 逐个消费任务队列
    const n = Math.min(4, Math.max(1, jobs.length));
    for (let k = 0; k < n; k++) void worker();
    return () => { cancelled = true; };
  }, [games]);

  // 卸载时清掉 window 级拖拽监听，防止泄漏
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
    listen<{ gameId: string; name: string; done: number; total: number }>(
      'disk-move-progress',
      (e) => { if (!cancelled) setMoveProgress(e.payload); },
    ).then((f) => { if (!cancelled) unlisten = f; });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // 「显示卷」面板：点击弹窗内其它区域由内容容器 onClick 收起；
  // 此处仅兜底窗口失焦（点击 WebView 窗口外）关闭
  useEffect(() => {
    if (!showDrivePanel) return;
    const close = () => setShowDrivePanel(false);
    window.addEventListener('blur', close);
    return () => window.removeEventListener('blur', close);
  }, [showDrivePanel]);

  // 按盘符分组：有待移动标记的游戏归到目标盘（视觉上"已搬过去"，撤销后回到原盘）
  const gamesByDrive = useMemo(() => {
    const map: Record<string, Game[]> = {};
    for (const g of games) {
      const d = moves[g.id] ? moves[g.id].to : (driveOf(g, volumes) ?? 'UNKNOWN');
      (map[d] ||= []).push(g);
    }
    return map;
  }, [games, moves, volumes]);

  // 盘符不在当前卷列表里的游戏数（没读到的盘 / 无盘符路径）
  const unknownCount = useMemo(() => {
    const drives = new Set(volumes.map((v) => v.drive));
    let n = 0;
    for (const [d, list] of Object.entries(gamesByDrive)) {
      if (!drives.has(d)) n += list.length;
    }
    return n;
  }, [gamesByDrive, volumes]);

  // 只渲染未隐藏的卷（游戏随盘一起隐藏）
  const visibleVolumes = volumes.filter((v) => !hiddenDrives.has(v.drive));

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

  const removeMove = (gameId: string) => {
    setMoves((m) => {
      const next = { ...m };
      delete next[gameId];
      return next;
    });
  };

  // ─── 卷显示筛选 ────────────────────────────
  // 只在用户操作时持久化（避免挂载读取完成前误覆盖已存值）
  const persistHidden = (next: Set<string>) => {
    setHiddenDrives(next);
    void api.setSetting('disk_manager_hidden_drives', JSON.stringify(Array.from(next))).catch(() => {});
  };
  const toggleDrive = (drive: string) => {
    const next = new Set(hiddenDrives);
    if (next.has(drive)) next.delete(drive);
    else next.add(drive);
    persistHidden(next);
  };
  const showAllDrives = () => persistHidden(new Set());
  const hideAllDrives = () => persistHidden(new Set(volumes.map((v) => v.drive)));

  const handleDrop = (gameId: string, targetDrive: string) => {
    const g = games.find((x) => x.id === gameId);
    if (!g || archiveGame || archiveBusy || applying) return;
    // S1 防线：无法安全移动的提前拦截（后端也会拒绝）。已归档按压缩包移动，需要 archive_path；
    // 未归档按安装目录移动，需要 install_dir。
    if (g.archive_status ? !(g.archive_path || '').trim() : !(g.install_dir || '').trim()) {
      void message(
        t('disk.noInstallDir', { name: g.name }),
        { title: t('disk.cannotMove'), kind: 'warning' },
      );
      return;
    }
    const from = driveOf(g, volumes);          // 原始归属盘（null = 无法判定，显示「未知」）
    const current = moves[gameId]?.to ?? from; // 当前显示盘（已移动过用目标盘）
    if (current === targetDrive) return;       // 还在原处，无意义
    setResults([]); // 开始新的迁移方案，清掉上一次的应用结果
    if (targetDrive === from) {
      // 拖回原始盘 → 撤销这次移动，游戏回到原始归属
      setMoves((m) => {
        const next = { ...m };
        delete next[gameId];
        return next;
      });
      return;
    }
    const targetPath = targetPathOf(g, targetDrive, steamLibPaths);
    setMoves((m) => ({
      ...m,
      [gameId]: { gameId, name: g.name, from: from ?? 'UNKNOWN', to: targetDrive, size: sizes[gameId] || 0, targetPath },
    }));
  };

  // ─── Pointer 拖拽 ──────────────────────────

  // 命中测试：坐标落在哪张磁盘卡上
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

  const handleCardPointerDown = (e: React.PointerEvent, g: Game) => {
    if (applying || archiveGame || archiveBusy) return;
    if (g.archive_status && !(g.archive_path || '').trim()) return; // 归档但无压缩包路径不可拖
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return; // 撤销按钮不触发拖拽
    e.preventDefault(); // 防止图片原生拖拽/文本选择
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDrag({
      id: g.id,
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
    // 4px 阈值内视为点击
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

  // 应用迁移方案：确认 → 后端逐个移动（复制进度实时显示）→ 刷新数据
  const handleApply = async () => {
    if (moveCount === 0 || applying || archiveGame || archiveBusy) return;
    const ok = await confirm(
      t('disk.applyConfirmGames', { n: moveCount }),
      { title: t('disk.manage'), kind: 'warning' },
    );
    if (!ok) return;
    // M7：Steam 游戏的目标盘不在 Steam 库中 → 额外警告（不阻止，用户确认后仍可移动）
    const steamMoves = Object.values(moves).filter((m) => {
      const g = games.find((x) => x.id === m.gameId);
      return g && !g.archive_status && (g.steam_appid ?? 0) > 0;
    });
    if (steamMoves.length > 0) {
      const steamLibs = new Set(await api.steamLibraryDrives().catch(() => []));
      const badDrives = [...new Set(steamMoves.map((m) => m.to).filter((d) => !steamLibs.has(d)))];
      if (badDrives.length > 0) {
        const go = await confirm(
          t('disk.steamWarnBody', { n: steamMoves.length, drives: badDrives.join('、') }),
          { title: t('disk.steamWarnTitle'), kind: 'warning' },
        );
        if (!go) return;
      }
    }
    setApplying(true);
    setResults([]);
    setRestartDone(false); // 新一轮移动重新出现「重启 Steam」入口
    setMoveProgress(null);
    const plans = Object.values(moves).map((m) => ({ gameId: m.gameId, targetPath: m.targetPath }));
    try {
      const res = await api.applyGameMoves(plans);
      setResults(res);
      setMoves({});
      setDropTarget(null);
    } catch (err: any) {
      await message(t('disk.moveFailed', { msg: err?.message ?? err }), { title: t('disk.manage'), kind: 'error' });
    } finally {
      setApplying(false);
      setCancelling(false);
      setMoveProgress(null);
    }
    // 刷新独立于移动结果（M5）：移动已成功/部分成功，loadGames 失败只是界面数据旧，
    // 不能报「移动失败」误导用户
    await loadGames().catch(() => {});
    const vols = await api.getDiskVolumes().catch(() => [] as DiskVolume[]);
    setVolumes(vols);
  };

  // 取消移动：置位后端取消标志 → 复制循环在下一个文件检查点中止并清理目标残留，
  // 游戏留在原目录。applyGameMoves 的命令会很快返回（结果里带「已取消」），
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

  // 静默重启 Steam（Steam 清单已搬迁时出现）：确认 → 后端做安全检查（游戏在跑→拒绝）
  // → -shutdown 优雅退出 → -silent 托盘启动。成功收起入口，失败提示原因（保留手动重启兜底）
  const handleRestartSteam = async () => {
    if (restarting) return;
    const ok = await confirm(
      t('disk.restartConfirm'),
      { title: t('disk.restartSteamTitle'), kind: 'warning' },
    );
    if (!ok) return;
    setRestarting(true);
    try {
      const res = await api.restartSteamForRecognition();
      if (res.ok) {
        setRestartDone(true);
        await message(t('disk.restartDone'), { title: t('common.done'), kind: 'info' });
      } else {
        await message(res.error ?? t('disk.restartFailed'), { title: t('disk.notRestarted'), kind: 'warning' });
      }
    } catch (err: any) {
      await message(t('disk.restartErr', { msg: err?.message ?? err }), { title: t('common.error'), kind: 'error' });
    } finally {
      setRestarting(false);
    }
  };

  const draggedGame = drag ? games.find((g) => g.id === drag.id) : null;

  return createPortal(
    <div className="disk-manager-overlay fixed inset-0 z-[300] flex items-start justify-center px-6" onClick={guardedClose}>
      <div className="absolute inset-0 bg-black/75 backdrop-blur-md animate-fade-in" />

      <div
        ref={modalRef}
        className="disk-manager-modal relative w-[94vw] max-w-6xl glass-modal shadow-2xl animate-scale-in flex flex-col overflow-visible"
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
              <h2 className="text-lg font-bold leading-tight">{t('disk.manage')}</h2>
              <p className="text-xs text-text-secondary mt-0.5">{t('disk.descGames')}</p>
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
                title={t('disk.pickDrivesTitle')}
              >
                <SlidersHorizontal size={14} />
                {t('disk.showDrives')}
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
                    <p className="text-sm font-semibold">{t('disk.whichDrives')}</p>
                    <span className="text-xs text-text-tertiary">{t('disk.shownCount', { shown: visibleVolumes.length, total: volumes.length })}</span>
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
                              {fmtBytes(v.total)} · {t('disk.countGames', { n: (gamesByDrive[v.drive] || []).length })}
                            </span>
                          </span>
                          {!checked && <span className="text-[10px] text-text-tertiary shrink-0">{t('disk.hidden')}</span>}
                        </label>
                      );
                    })}
                  </div>
                  <div className="px-3 py-2 border-t border-border-glass flex gap-2">
                    <button onClick={showAllDrives} className="flex-1 text-xs py-1.5 rounded-lg bg-bg-surface hover:bg-bg-surface-active text-text-secondary">{t('disk.showAll')}</button>
                    <button onClick={hideAllDrives} className="flex-1 text-xs py-1.5 rounded-lg bg-bg-surface hover:bg-bg-surface-active text-text-secondary">{t('disk.hideAll')}</button>
                  </div>
                </div>
              )}
            </div>

            <button
              onClick={guardedClose}
              disabled={applying || archiveBusy || !!archiveGame}
              className="w-9 h-9 rounded-xl flex items-center justify-center text-text-secondary hover:text-white hover:bg-bg-surface-active transition-all disabled:opacity-40 disabled:hover:bg-transparent"
              title={applying ? t('disk.movingBusy') : t('common.close')}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* 磁盘卡网格 */}
        <div data-disk-body className="disk-manager-body shrink-0 min-h-0 p-6">
          {volumes.length === 0 && !volumeError ? (
            <div className="min-h-40 flex flex-col items-center justify-center gap-3 text-text-tertiary">
              <Loader2 size={28} className="animate-spin" />
              <span className="text-sm">{t('disk.loading')}</span>
            </div>
          ) : visibleVolumes.length === 0 ? (
            <div className="min-h-40 flex flex-col items-center justify-center gap-2 text-text-tertiary">
              <HardDrive size={28} className="opacity-40" />
              <span className="text-sm">{t('disk.allHidden')}</span>
              <button onClick={() => setShowDrivePanel(true)} className="text-xs text-[#00d4ff] hover:underline">{t('disk.clickToShow')}</button>
            </div>
          ) : (
            <div data-disk-grid className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-5 content-start">
              {visibleVolumes.map((v) => {
                const list = gamesByDrive[v.drive] || [];
                const free = previewFree(v.drive);
                const low = free < 10 * 1024 ** 3; // 可用 < 10GB 提示
                const over = free < 0;              // 应用后空间不足
                const isDrop = dropTarget === v.drive;
                // 容量预览分段：移入 / 移出总大小
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
                    className={`disk-manager-card glass-card p-5 flex flex-col hover:transform-none ${
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
                            {v.file_system}{v.removable ? ` · ${t('disk.removable')}` : ''}{v.remote ? ` · ${t('disk.network')}` : ''} · {fmtBytes(v.total)}
                          </p>
                        </div>
                      </div>
                      <span className="shrink-0 text-[11px] px-1.5 py-0.5 rounded-md bg-bg-surface text-text-secondary">{t('disk.countGames', { n: list.length })}</span>
                    </div>

                    {/* 容量条：应用后实时预览
                        蓝 = 保留占用 · 黄 = 将释放（移出） · 绿 = 将新增（移入） */}
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
                      <span>{t('disk.used', { size: fmtBytes(v.used) })}</span>
                      <span>{t('disk.free', { size: fmtBytes(v.available) })}</span>
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
                        {t('disk.freeAfter')} <b>{fmtBytes(free)}</b>
                        {over && t('disk.noSpace')}
                      </div>
                    )}

                    {/* 游戏列表：内容先撑高卡片，达到可用高度后才滚动 */}
                    <div data-disk-list className="disk-manager-list disk-scroll-y flex-1 min-h-0">
                      <div data-disk-content className="space-y-2">
                        {list.length === 0 && (
                          <div className={`h-20 rounded-xl border border-dashed flex items-center justify-center text-xs transition-colors ${
                            isDrop ? 'border-[#00d4ff]/60 text-[#00d4ff] bg-[rgba(0,212,255,0.05)]' : 'border-border-glass text-text-tertiary'
                          }`}>
                            {isDrop ? t('disk.dropHere') : t('disk.noneGames')}
                          </div>
                        )}
                        {list.map((g) => {
                          const isDragging = drag?.id === g.id && drag.active;
                          const target = moves[g.id];
                          const size = g.archive_status ? g.archive_size || 0 : sizes[g.id];
                          return (
                            <div
                              key={g.id}
                              onPointerDown={(e) => handleCardPointerDown(e, g)}
                              onContextMenu={(e) => {
                                e.preventDefault(); e.stopPropagation();
                                if (applying || archiveBusy || archiveGame || drag?.active) return;
                                setArchiveMenu({ game: g, x: e.clientX, y: e.clientY });
                              }}
                              title={g.archive_status ? `${g.archive_path || ''}\n${g.archive_status === 'cleanup_pending' ? t('games.archiveLeftoverWarning') : t('games.archiveCannotLaunch')}` : undefined}
                              className={`group flex items-center gap-3 rounded-xl px-2.5 py-2 border ${(g.archive_status && !(g.archive_path || '').trim()) ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'} transition-all hover:bg-bg-surface-active touch-none select-none ${
                                isDragging ? 'opacity-40' : ''
                              } ${target ? 'border-[#00d4ff]/40 bg-[rgba(0,212,255,0.06)]' : 'border-transparent'}`}
                            >
                              {g.cover_path ? (
                                <img src={convertFileSrc(g.cover_path, 'covers')} className="w-10 h-[60px] rounded object-cover shrink-0 pointer-events-none" alt="" />
                              ) : (
                                <span className="w-10 h-[60px] rounded bg-gradient-to-br from-[#00d4ff]/18 to-bg-surface border border-border-glass flex items-center justify-center shrink-0 pointer-events-none">
                                  <Gamepad2 size={15} className="text-text-tertiary" />
                                </span>
                              )}
                              <div className="min-w-0 flex-1 pointer-events-none">
                                <p className="text-sm font-medium text-text-primary truncate">{g.name}</p>
                                <p className="text-[11px] text-text-tertiary truncate mt-0.5">
                                  {size !== undefined ? fmtBytes(size) : t('disk.computing')}
                                  {g.archive_status && <span className="text-amber-400"> · {t(g.archive_status === 'cleanup_pending' ? 'games.archiveLeftover' : 'games.archived')}</span>}
                                  {target && <span className="text-[#00d4ff]"> · {t('disk.movingTo', { drive: target.to })}</span>}
                                </p>
                              </div>
                              {target && (
                                <button onClick={() => removeMove(g.id)} className="shrink-0 text-text-tertiary hover:text-[#ef4444]" title={t('disk.undoMove')}>
                                  <XCircle size={16} />
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 待移动方案列表（纵向排列，每行完整可见） */}
        {moveCount > 0 && !applying && results.length === 0 && (
          <div data-disk-queue className="disk-manager-queue shrink-0 min-h-0 flex flex-col border-t border-border-glass px-6 pt-3 pb-2">
            <div className="shrink-0 flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-text-secondary">{t('disk.plans')}</p>
              <span className="text-[11px] text-text-tertiary">{t('disk.plansSummaryGames', { n: moveCount })}</span>
            </div>
            <div data-disk-list className="disk-manager-list disk-scroll-y min-h-0 flex-1">
              <div data-disk-content className="space-y-1.5">
                {Object.values(moves).map((m) => (
                  <div key={m.gameId} className="flex items-center gap-3 rounded-xl px-3 py-2 bg-[rgba(0,212,255,0.05)] border border-[rgba(0,212,255,0.15)]">
                    <span className="shrink-0 w-9 h-9 rounded-lg bg-bg-surface border border-border-glass flex items-center justify-center text-xs font-bold text-text-secondary">
                      {m.from === 'UNKNOWN' ? t('disk.unknownDrive') : m.from.replace(':', '')}
                    </span>
                    <ArrowRight size={12} className="shrink-0 text-[#00d4ff]" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-text-primary truncate leading-tight">
                        {m.name}
                        <span className="ml-1.5 text-xs font-normal text-text-tertiary">{fmtBytes(m.size)}</span>
                      </p>
                      <p className="text-[11px] font-mono text-[#00d4ff] truncate leading-tight mt-0.5" title={m.targetPath}>{m.targetPath}</p>
                    </div>
                    <button onClick={() => removeMove(m.gameId)} className="shrink-0 text-text-tertiary hover:text-[#ef4444]" title={t('disk.undoMove')}>
                      <XCircle size={16} />
                    </button>
                  </div>
                ))}
                {unknownCount > 0 && (
                  <div className="flex items-center gap-1.5 text-[11px] text-amber-500 px-1 pt-0.5">
                    <AlertTriangle size={12} /> {t('disk.unknownGames', { n: unknownCount })}
                  </div>
                )}
              </div>
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
                    <span className="text-xs text-text-primary truncate shrink-0 max-w-44">{t('disk.moving', { title: moveProgress.name })}</span>
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
                    <Loader2 size={14} className="animate-spin" />{t('disk.preparing')}
                  </span>
                )
              ) : results.length > 0 ? (
                // 应用结果
                <div className="disk-scroll-x flex items-center gap-2">
                  <span className="text-xs text-text-tertiary shrink-0">{t('disk.result')}</span>
                  {results.map((r) => (
                    <span
                      key={r.gameId}
                      title={r.warning ?? r.error ?? undefined}
                      className={`shrink-0 inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border max-w-lg ${
                        r.ok && r.warning
                          ? 'bg-amber-500/10 border-amber-500/30 text-amber-500'
                          : r.ok
                          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-500'
                          : 'bg-[#ef4444]/10 border-[#ef4444]/30 text-[#ef4444]'
                      }`}
                    >
                      {r.ok && !r.warning ? <Check size={12} className="shrink-0" /> : <AlertTriangle size={12} className="shrink-0" />}
                      <span className="truncate min-w-0">{r.name || t('disk.unknownGame')}</span>
                      {r.ok ? (
                        // 移动成功：源被占用未删净时显警告标签，完整说明在 title 悬浮
                        <span className="truncate">{r.warning ? t('disk.movedLeftover') : t('disk.moved')}</span>
                      ) : (
                        <span className="truncate">
                          {/* 取消/拒绝的长文本（含细节）放 title，chip 内截断不溢出 */}
                          {(r.error ?? '').includes('移动已取消')
                            ? t('disk.cancelledGame')
                            : (r.error ?? '').split('\n')[0]}
                        </span>
                      )}
                    </span>
                  ))}
                  {/* Steam 清单已随文件夹搬迁：Steam 运行时不会实时扫描库，重启后才会识别。
                      一键静默重启（后端安全检查 → -shutdown 优雅退出 → -silent 托盘启动），
                      成功后收起入口，失败提示原因保留手动重启兜底 */}
                  {results.some((r) => r.steamManifestMoved) && !restartDone && (
                    <span
                      title={t('disk.restartHint')}
                      className="shrink-0 inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border border-[#00d4ff]/30 bg-[#00d4ff]/10 text-[#00d4ff]"
                    >
                      <Info size={12} className="shrink-0" />
                      {t('disk.restartSteam')}
                      <button
                        onClick={handleRestartSteam}
                        disabled={restarting}
                        className="ml-0.5 shrink-0 px-2 py-0.5 rounded-md bg-[#00d4ff]/15 hover:bg-[#00d4ff]/30 transition-colors disabled:opacity-50"
                      >
                        {restarting ? <Loader2 size={12} className="animate-spin" /> : t('disk.silentRestart')}
                      </button>
                    </span>
                  )}
                </div>
              ) : (
                <span className="text-xs text-text-tertiary">{t('disk.hintGames')}</span>
              )}
            </div>
            <div className="flex items-center gap-3 shrink-0">
              {applying ? (
                // 移动中：取消 = 完整取消机制（中止复制 → 清理目标残留 → 游戏留在原目录）
                <button
                  onClick={handleCancelMove}
                  disabled={cancelling}
                  className="btn btn-ghost px-4 py-2 text-sm disabled:opacity-50"
                >
                  {cancelling ? <><Loader2 size={14} className="animate-spin" />{t('disk.cancelling')}</> : t('disk.cancelMove')}
                </button>
              ) : (
                <button onClick={guardedClose} disabled={archiveBusy || !!archiveGame} className="btn btn-ghost px-4 py-2 text-sm disabled:opacity-50">
                  {t('common.cancel')}
                </button>
              )}
              <button
                onClick={handleApply}
                disabled={moveCount === 0 || applying || archiveBusy || !!archiveGame}
                className="btn btn-accent px-5 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {applying ? <><Loader2 size={14} className="animate-spin" />{t('disk.applying')}</> : <><Check size={14} />{t('disk.apply', { n: moveCount })}</>}
              </button>
            </div>
          </div>
        </div>
      </div>

      {archiveMenu && (
        <div ref={archiveMenuRef} className="fixed z-[310] glass-card w-44 py-1.5 shadow-2xl animate-scale-in"
          style={archiveMenuPos} onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setArchiveMenu(null); } }}>
          {archiveMenu.game.archive_status ? (
            <button className="context-menu-item disabled:opacity-40" disabled={!archiveMenu.game.archive_path?.trim()}
              onClick={() => { setRestoreGame(archiveMenu.game); setArchiveMenu(null); }}>
              {t('games.restore')}
            </button>
          ) : (
            <button className="context-menu-item disabled:opacity-40" disabled={!!moves[archiveMenu.game.id] || !archiveMenu.game.install_dir?.trim()}
              title={moves[archiveMenu.game.id] ? t('games.archiveUndoMove') : undefined}
              onClick={() => { setArchiveGame(archiveMenu.game); setArchiveMenu(null); }}>
              {t('games.compress')}
            </button>
          )}
          <div className="context-menu-divider" />
          <button className="context-menu-item text-danger"
            onClick={() => handleDiskDelete(archiveMenu.game)}>
            {t('games.deleteGame')}
          </button>
        </div>
      )}
      {archiveGame && <GameArchiveDialog game={archiveGame} size={sizes[archiveGame.id]} onClose={() => setArchiveGame(null)}
        onBusy={setArchiveBusy} onRefresh={async () => {
          folderSizeGeneration++;
          folderSizeCache.clear();
          setSizes({});
          await Promise.all([loadGames(), api.getDiskVolumes().then(setVolumes)]);
        }} />}
      {restoreGame && <GameRestoreDialog game={restoreGame} onClose={() => setRestoreGame(null)}
        onBusy={setArchiveBusy} onRefresh={async () => {
          folderSizeGeneration++;
          folderSizeCache.clear();
          setSizes({});
          await Promise.all([loadGames(), api.getDiskVolumes().then(setVolumes)]);
        }} />}

      {/* 拖拽克隆：跟随指针 */}
      {drag?.active && draggedGame && createPortal(
        <div
          className="drag-clone"
          style={{ left: drag.x - drag.grabDX, top: drag.y - drag.grabDY }}
        >
          <div className="flex items-center gap-3 px-2.5 py-2 rounded-xl glass-card w-64">
            {draggedGame.cover_path ? (
              <img src={convertFileSrc(draggedGame.cover_path, 'covers')} className="w-9 h-[54px] rounded object-cover shrink-0" alt="" />
            ) : (
              <span className="w-9 h-[54px] rounded bg-bg-surface border border-border-glass flex items-center justify-center shrink-0">
                <Gamepad2 size={14} className="text-text-tertiary" />
              </span>
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-primary truncate">{draggedGame.name}</p>
              <p className="text-[11px] text-text-tertiary truncate mt-0.5">
                {driveOf(draggedGame, volumes) ?? t('disk.unknownDrive')} · {sizes[draggedGame.id] !== undefined ? fmtBytes(sizes[draggedGame.id]) : t('disk.computing')}
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

function GameArchiveDialog({ game, size, onClose, onBusy, onRefresh }: {
  game: Game; size?: number; onClose: () => void; onBusy: (busy: boolean) => void; onRefresh: () => Promise<void>;
}) {
  const t = useT();
  const source = game.install_dir.replace(/[\\/]+$/, '');
  const [path, setPath] = useState(`${source}.7z`);
  const [level, setLevel] = useState<1 | 5 | 9>(5);
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<api.GameArchiveProgress | null>(null);
  const [result, setResult] = useState<api.GameArchiveResult | null>(null);
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  const invokedRef = useRef(false);
  const mounted = useRef(true);
  const unlistenRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; unlistenRef.current?.(); unlistenRef.current = null; };
  }, []);
  const close = () => { if (!busyRef.current && !choosing) onClose(); };
  useModalGamepad('modal:game-archive', { onClose: close });
  const browse = async () => {
    setChoosing(true);
    try {
      const selected = await save({ defaultPath: path, filters: [{ name: '7-Zip', extensions: ['7z'] }] });
      if (selected && mounted.current) { setPath(selected); }
    } catch (err) { if (mounted.current) setError(String(err)); }
    finally { if (mounted.current) setChoosing(false); }
  };
  const start = async () => {
    if (busyRef.current || !path.trim() || choosing) return;
    busyRef.current = true;
    onBusy(true);
    setBusy(true); setError(''); setResult(null); setCancelling(false);
    setProgress({ gameId: game.id, phase: 'preparing', percent: 0 });
    try {
      const stop = await listen<api.GameArchiveProgress>('game-archive-progress', (event) => {
        if (mounted.current && event.payload.gameId === game.id) setProgress(event.payload);
      });
      if (!mounted.current) { stop(); return; }
      unlistenRef.current = stop;
      invokedRef.current = true;
      const res = await api.compressGame(game.id, path.trim(), level);
      if (mounted.current) setResult(res);
    } catch (err) {
      if (mounted.current) setError(String(err));
    } finally {
      unlistenRef.current?.(); unlistenRef.current = null;
      invokedRef.current = false;
      try { await onRefresh(); }
      catch (err) { if (mounted.current) setError((old) => [old, t('games.archiveRefreshFailed', { msg: String(err) })].filter(Boolean).join('\n')); }
      busyRef.current = false;
      onBusy(false);
      if (mounted.current) { setBusy(false); setCancelling(false); }
    }
  };
  const cancel = async () => {
    if (!busyRef.current || !invokedRef.current || cancelling || progress?.phase === 'cleaning') return;
    setCancelling(true);
    try { await api.cancelGameArchive(); }
    catch (err) { if (mounted.current) { setCancelling(false); setError(String(err)); } }
  };
  return createPortal(
    <div className="fixed inset-0 z-[320] flex items-center justify-center p-6" onClick={(e) => { e.stopPropagation(); close(); }}>
      <div className="absolute inset-0 bg-black/75 backdrop-blur-md" />
      <div role="dialog" aria-modal="true" aria-labelledby="game-archive-title" className="relative glass-modal solid-modal w-[640px] max-w-full max-h-[85vh] overflow-y-auto p-6 space-y-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3">
          <h2 id="game-archive-title" className="text-lg font-bold">{t('games.compress')} · {game.name}</h2>
          <button onClick={close} disabled={busy || choosing} className="btn btn-ghost disabled:opacity-40" aria-label={t('common.close')}><X size={18} /></button>
        </div>
        <div className="text-xs text-text-secondary space-y-1 break-all">
          <p>{t('games.installDir')} · {size === undefined ? t('disk.computing') : fmtBytes(size)}</p>
          <p className="text-text-primary select-text">{source}</p>
        </div>
        {!result && <>
          <div className="space-y-1.5">
            <span className="block text-xs font-medium text-text-secondary">{t('games.archiveDestination')}</span>
            <div className="flex gap-2">
              <input className="input flex-1 min-w-0 text-xs" value={path} onChange={(e) => setPath(e.target.value)} disabled={busy || choosing} />
              <button className="btn btn-ghost text-xs" onClick={browse} disabled={busy || choosing}>{t('common.browse')}</button>
            </div>
          </div>
          <div className="space-y-1.5">
            <span className="block text-xs font-medium text-text-secondary">{t('games.archiveLevel')}</span>
            <div className="flex gap-2">
              {([[1, 'games.archiveFast'], [5, 'games.archiveBalanced'], [9, 'games.archiveMaximum']] as const).map(([lv, key]) => (
                <button
                  key={lv}
                  type="button"
                  disabled={busy}
                  className={['chip', 'disabled:opacity-40', level === lv && 'active'].filter(Boolean).join(' ')}
                  onClick={() => setLevel(lv)}
                >
                  {t(key)}
                </button>
              ))}
            </div>
          </div>
        </>}
        {busy && progress && <div className="space-y-2 text-sm" role="status">
          <p className="flex items-center gap-2"><Loader2 size={15} className="animate-spin" />{t(`games.archivePhase.${progress.phase}`)} · {Math.round(Math.max(0, Math.min(100, progress.percent || 0)))}%</p>
          <p className="text-xs text-text-secondary">{t('games.archiveBusy')}</p>
        </div>}
        {result && <div className="rounded-xl border border-border-glass p-4 space-y-2 text-sm break-all select-text">
          <p className={result.warning ? 'text-amber-400 font-semibold' : 'text-emerald-400 font-semibold'}>{t(result.warning ? 'games.archiveLeftover' : 'games.archiveComplete')}</p>
          <p>{result.archivePath}</p>
          <p>{t('games.archiveResultSize', { size: fmtBytes(result.archiveSize), original: fmtBytes(result.originalSize) })}</p>
          {!result.warning && <p>{t('games.archiveReleased', { size: fmtBytes(Math.max(0, result.originalSize - result.archiveSize)) })}</p>}
          {result.warning && <p className="text-amber-400 whitespace-pre-wrap">{t('games.archiveLeftoverWarning')}<br />{result.warning}</p>}
        </div>}
        {error && <p role="alert" className="text-sm text-red-400 whitespace-pre-wrap break-all select-text">{error}</p>}
        <div className="flex justify-end gap-3">
          {busy ? <button className="btn btn-ghost text-sm disabled:opacity-40" onClick={cancel} disabled={cancelling || progress?.phase === 'cleaning'}>{t(cancelling ? 'disk.cancelling' : 'common.cancel')}</button>
            : <>
              <button className="btn btn-ghost text-sm" onClick={close} disabled={choosing}>{t('common.close')}</button>
              {!result && <button className="btn btn-accent text-sm disabled:opacity-40" onClick={start} disabled={!path.trim() || choosing}>{t('games.archiveStart')}</button>}
            </>}
        </div>
      </div>
    </div>, document.body,
  );
}
