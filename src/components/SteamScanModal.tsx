import { useState, useEffect } from 'react';
import { X, Gamepad2, Check, Loader2 } from 'lucide-react';
import * as api from '../api';
import { clsx } from 'clsx';
import { useModalGamepad } from '../gamepad';

interface Props {
  onClose: () => void;
  onImported?: () => void;
}

/** Steam 端已玩分钟 → "497h37m" / "42m"（0 显示「未记录」） */
function formatPlaytime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m`;
  return '未记录';
}

export default function SteamScanModal({ onClose, onImported }: Props) {
  const [status, setStatus] = useState<'idle' | 'scanning' | 'selecting' | 'importing' | 'done'>('scanning');
  const [steamGames, setSteamGames] = useState<api.SteamGame[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState('');
  const [imported, setImported] = useState(0);
  const [processed, setProcessed] = useState(0); // 已提交给后端的游戏数（进度用）
  const [total, setTotal] = useState(0); // 本次导入的游戏总数
  // 导入后自动从 Steam CDN 补齐缺失封面（默认开：首次导入大库时最省事）
  const [fetchCovers, setFetchCovers] = useState(true);
  const [coverPhase, setCoverPhase] = useState<'idle' | 'fetching' | 'done'>('idle');
  const [coverProgress, setCoverProgress] = useState<{ done: number; total: number; ok: number; fail: number } | null>(null);
  const [coverMsg, setCoverMsg] = useState('');

  // 弹窗期间手柄按键不穿透到背后（B/Esc 关闭，扫描与勾选用鼠标）
  // 导入中/封面获取中禁止一切关闭（遮罩/叉/Esc/B）：进度显示和后续导入结果
  // 都挂在弹窗上，误关会让导入在后台无人可见地继续
  const busy = status === 'importing' || coverPhase === 'fetching';
  const guardedClose = () => { if (!busy) onClose(); };
  useModalGamepad('modal:steam-scan', { onClose: guardedClose });

  // 封面获取进度事件（设置页同款模式）：挂载即注册，避免错过开头的事件
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import('@tauri-apps/api/event').then(async ({ listen }) => {
      if (cancelled) return;
      unlisten = await listen<{ done: number; total: number; ok: number; fail: number }>(
        'cover-fetch-progress',
        (e) => setCoverProgress(e.payload),
      );
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const scan = async () => {
    setStatus('scanning');
    setError('');
    try {
      const games = await api.scanSteamLibrary();
      if (games.length === 0) {
        setError('未找到 Steam 游戏。请确保 Steam 已安装并至少运行过一次。');
        setStatus('idle');
        return;
      }
      // 已导入的置底、默认不勾选：未导入在前（默认全选，可直接全量导入），
      // 已导入在后（灰标展示，后端导入时会跳过它们）
      const sorted = [...games].sort(
        (a, b) => Number(a.already_imported) - Number(b.already_imported)
      );
      setSteamGames(sorted);
      setSelected(new Set(
        sorted
          .map((g, i) => (g.already_imported ? -1 : i))
          .filter((i) => i >= 0),
      ));
      setStatus('selecting');
    } catch (err: any) {
      setError(typeof err === 'string' ? err : (err?.message || '扫描失败'));
      setStatus('idle');
    }
  };

  // 打开即自动扫描，省掉确认步骤
  useEffect(() => { scan(); }, []);

  // 全选只作用于未导入的（已导入的禁用勾选，不参与）
  const toggleAll = () => {
    const unimported = steamGames.filter((g) => !g.already_imported).length;
    if (selected.size === unimported) {
      setSelected(new Set());
    } else {
      setSelected(new Set(
        steamGames
          .map((g, i) => (g.already_imported ? -1 : i))
          .filter((i) => i >= 0),
      ));
    }
  };

  const toggle = (i: number) => {
    if (steamGames[i].already_imported) return;
    const next = new Set(selected);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setSelected(next);
  };

  const importSelected = async () => {
    if (selected.size === 0) return;
    setStatus('importing');
    setProcessed(0);
    try {
      const toImport = selected.size === steamGames.length
        ? steamGames
        : steamGames.filter((_, i) => selected.has(i));
      setTotal(toImport.length);
      // 分批导入（每批 8 个，与后端并发上限一致）：逐批 invoke 并实时刷新进度，
      // 避免大库一次性等待全部封面下载完、界面像卡死
      const CHUNK = 8;
      let count = 0;
      for (let i = 0; i < toImport.length; i += CHUNK) {
        const importedGames = await api.importSteamGames(toImport.slice(i, i + CHUNK));
        count += importedGames.length;
        setImported(count);
        setProcessed(Math.min(i + CHUNK, toImport.length));
      }
      setStatus('done');
      onImported?.();
      // 勾选了「自动获取缺失封面」：导入后接着从 Steam CDN 补齐。
      // 处理全库缺封面的 Steam 游戏（复用设置页命令），没有缺失时任务数为 0、秒完成；
      // 封面下载独立 try/catch —— 失败只提示，不回退选择页（游戏已导入完成）
      if (fetchCovers) {
        setCoverPhase('fetching');
        setCoverProgress(null);
        setCoverMsg('');
        try {
          const res = await api.fetchAllSteamCovers();
          setCoverMsg(
            res.total === 0
              ? '所有 Steam 游戏都已配置封面'
              : `封面获取完成：共处理 ${res.total} 个游戏，成功 ${res.ok} 张，失败 ${res.fail} 张`,
          );
        } catch (err: any) {
          setCoverMsg(`封面获取失败：${typeof err === 'string' ? err : (err?.message ?? String(err))}`);
        } finally {
          setCoverPhase('done');
          // 封面是导入后异步写库的：onImported（loadGames）在导入完成时已刷过一次，
          // 这里再刷一次，否则新封面要切走再回来才能看到
          onImported?.();
        }
      }
    } catch (err: any) {
      setError(typeof err === 'string' ? err : (err?.message || '导入失败'));
      setStatus('selecting');
    }
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4" onClick={guardedClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in" />
      <div
        className="relative w-full max-w-2xl glass-modal shadow-2xl animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-border-glass">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-[rgba(0,212,255,0.12)] border border-[rgba(0,212,255,0.2)] flex items-center justify-center">
              <Gamepad2 size={18} className="text-[#00d4ff]" />
            </div>
            <h2 className="text-lg font-bold">扫描 Steam 库</h2>
          </div>
          <button
            onClick={guardedClose}
            disabled={busy}
            className="w-9 h-9 rounded-xl flex items-center justify-center text-text-secondary hover:text-white hover:bg-bg-surface-active transition-all disabled:opacity-40 disabled:hover:bg-transparent"
            title={busy ? '导入进行中，请等待完成' : '关闭'}
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-6">
          {error && (
            <div className="mb-4 p-3 rounded-xl bg-[#ef4444]/10 border border-[#ef4444]/20 text-[#ef4444] text-sm">
              {error}
            </div>
          )}

          {/* 扫描失败 / 未找到游戏：重试 */}
          {status === 'idle' && (
            <div className="text-center py-10">
              <div className="w-24 h-24 mx-auto mb-6 rounded-3xl bg-[rgba(239,68,68,0.06)] border border-[rgba(239,68,68,0.15)] flex items-center justify-center">
                <Gamepad2 size={40} className="text-[#ef4444]/40" />
              </div>
              <p className="text-text-secondary mb-6 text-sm">扫描失败，请检查 Steam 后重试</p>
              <button onClick={scan} className="btn btn-accent py-3 px-10 text-sm">
                重新扫描
              </button>
            </div>
          )}

          {/* Scanning */}
          {status === 'scanning' && (
            <div className="text-center py-10">
              <Loader2 size={48} className="mx-auto mb-4 text-[#00d4ff] animate-spin" />
              <p className="text-text-secondary">正在扫描 Steam 库...</p>
            </div>
          )}

          {/* Selecting */}
          {(status === 'selecting' || status === 'importing') && (
            <>
              <div className="flex items-center justify-between mb-4">
                <p className="text-sm text-text-secondary">
                  找到 <span className="text-white font-semibold">{steamGames.length}</span> 个游戏，
                  已选择 <span className="text-[#00d4ff] font-semibold">{selected.size}</span> 个
                  {steamGames.some((g) => g.already_imported) && (
                    <span className="text-text-tertiary">
                      （{steamGames.filter((g) => g.already_imported).length} 个已导入，置底不勾选）
                    </span>
                  )}
                </p>
                <button onClick={toggleAll} className="text-xs text-[#00d4ff]/70 hover:text-[#00d4ff] transition-colors">
                  {selected.size === steamGames.filter((g) => !g.already_imported).length && selected.size > 0 ? '取消全选' : '全选未导入'}
                </button>
              </div>

              {/* 导入中进度：逐批刷新，避免看起来像卡死 */}
              {status === 'importing' && total > 0 && (
                <div className="mb-4 p-3 rounded-xl bg-[rgba(0,212,255,0.06)] border border-[rgba(0,212,255,0.15)] text-sm text-text-secondary flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin text-[#00d4ff] shrink-0" />
                  正在下载封面并导入
                  <span className="text-[#00d4ff] font-semibold">{processed}</span>
                  / {total} 个（已导入 {imported}）
                </div>
              )}

              {/* 全部游戏都没读到 Steam 时长：提示但不阻塞导入 */}
              {steamGames.every((g) => g.playtime_minutes === 0) && (
                <div className="mb-3 p-2.5 rounded-xl bg-[rgba(234,179,8,0.07)] border border-[rgba(234,179,8,0.15)] text-xs text-[#eab308]/80">
                  未读取到 Steam 时长（localconfig.vdf 未找到或为空），导入后时长从 0 开始计时
                </div>
              )}

              <div className="max-h-72 overflow-y-auto space-y-1 mb-5 glass-card p-1">
                {steamGames.map((game, i) => (
                  <label
                    key={i}
                    className={clsx(
                      'flex items-center gap-3 px-4 py-3 rounded-xl transition-all',
                      game.already_imported
                        ? 'opacity-[45%] cursor-not-allowed'
                        : 'cursor-pointer',
                      !game.already_imported && selected.has(i) && 'bg-[rgba(0,212,255,0.06)]',
                      !game.already_imported && !selected.has(i) && 'hover:bg-bg-surface',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(i)}
                      disabled={game.already_imported}
                      onChange={() => toggle(i)}
                      className="w-4 h-4 rounded accent-[#00d4ff] disabled:opacity-50"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{String(game.name)}</p>
                      <p className="text-xs text-text-tertiary truncate">{String(game.install_dir)}</p>
                    </div>
                    <span className="badge text-[10px] shrink-0">{String(game.app_id)}</span>
                    {game.already_imported && (
                      <span className="badge text-[10px] shrink-0 bg-[rgba(148,163,184,0.15)] border-[rgba(148,163,184,0.2)] text-text-tertiary">
                        已导入
                      </span>
                    )}
                    {game.playtime_minutes > 0 ? (
                      <span className="text-xs text-[#00d4ff] whitespace-nowrap shrink-0">
                        Steam 已玩 {formatPlaytime(game.playtime_minutes)}
                      </span>
                    ) : (
                      <span className="text-xs text-text-tertiary whitespace-nowrap shrink-0">未记录</span>
                    )}
                  </label>
                ))}
              </div>

              <div className="flex justify-between items-center gap-3">
                <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={fetchCovers}
                    onChange={(e) => setFetchCovers(e.target.checked)}
                    className="w-3.5 h-3.5 rounded accent-[#00d4ff]"
                  />
                  导入后自动从 Steam CDN 获取缺失封面
                </label>
                <div className="flex gap-3 shrink-0">
                  <button onClick={guardedClose} disabled={busy} className="btn btn-ghost py-3 px-5 text-sm disabled:opacity-50">
                    取消
                  </button>
                  <button
                    onClick={importSelected}
                    disabled={selected.size === 0 || status === 'importing'}
                    className="btn btn-accent py-3 px-6 text-sm"
                  >
                    {status === 'importing' && <Loader2 size={14} className="animate-spin" />}
                    导入 {selected.size > 0 && `(${selected.size})`}
                  </button>
                </div>
              </div>
            </>
          )}

          {/* Done */}
          {status === 'done' && (
            <div className="text-center py-8">
              {coverPhase === 'fetching' ? (
                /* 封面补齐中：不显示「完成」确认，补齐完成才弹出 */
                <>
                  <div className="w-20 h-20 mx-auto mb-5 rounded-full bg-[rgba(0,212,255,0.1)] border border-[rgba(0,212,255,0.2)] flex items-center justify-center">
                    <Loader2 size={34} className="text-[#00d4ff] animate-spin" />
                  </div>
                  <p className="text-lg font-semibold mb-1">正在补齐缺失封面</p>
                  <p className="text-text-secondary mb-5 text-sm">
                    已导入 <span className="text-white font-semibold">{imported}</span> 个游戏，封面补齐后可关闭
                  </p>
                  <div className="mx-auto max-w-sm p-3 rounded-xl bg-[rgba(0,212,255,0.06)] border border-[rgba(0,212,255,0.15)] text-sm text-text-secondary flex items-center justify-center gap-2">
                    <Loader2 size={14} className="animate-spin text-[#00d4ff] shrink-0" />
                    正在从 Steam CDN 获取缺失封面
                    {coverProgress && (
                      <span className="text-[#00d4ff] font-semibold">
                        {coverProgress.done}/{coverProgress.total}
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="w-20 h-20 mx-auto mb-5 rounded-full bg-[rgba(16,185,129,0.1)] border border-[rgba(16,185,129,0.2)] flex items-center justify-center">
                    <Check size={36} className="text-emerald-400" />
                  </div>
                  <p className="text-lg font-semibold mb-2">导入成功！</p>
                  <p className="text-text-secondary mb-4 text-sm">
                    已导入 <span className="text-white font-semibold">{imported}</span> 个游戏到你的游戏库
                  </p>
                  {coverMsg && <p className="mb-4 text-sm text-text-secondary">{coverMsg}</p>}
                  <button onClick={onClose} className="btn btn-accent py-3 px-10 text-sm">
                    完成
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
