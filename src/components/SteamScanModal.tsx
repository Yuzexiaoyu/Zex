import { useState } from 'react';
import { X, Gamepad2, Check, Loader2 } from 'lucide-react';
import * as api from '../api';

interface Props {
  onClose: () => void;
}

export default function SteamScanModal({ onClose }: Props) {
  const [status, setStatus] = useState<'idle' | 'scanning' | 'selecting' | 'importing' | 'done'>('idle');
  const [steamGames, setSteamGames] = useState<api.SteamGame[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState('');
  const [imported, setImported] = useState(0);

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
      setSteamGames(games);
      setSelected(new Set(games.map((_, i) => i)));
      setStatus('selecting');
    } catch (err: any) {
      setError(err.message || '扫描失败');
      setStatus('idle');
    }
  };

  const toggleAll = () => {
    if (selected.size === steamGames.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(steamGames.map((_, i) => i)));
    }
  };

  const toggle = (i: number) => {
    const next = new Set(selected);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setSelected(next);
  };

  const importSelected = async () => {
    if (selected.size === 0) return;
    setStatus('importing');
    try {
      const toImport = selected.size === steamGames.length
        ? steamGames
        : steamGames.filter((_, i) => selected.has(i));
      await api.importSteamGames(toImport);
      setImported(toImport.length);
      setStatus('done');
    } catch (err: any) {
      setError(err.message || '导入失败');
      setStatus('selecting');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-2xl mx-4 bg-[var(--color-surface-2)] rounded-2xl shadow-2xl overflow-hidden animate-fade-in" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Gamepad2 size={20} />
            扫描 Steam 库
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-3)] text-[var(--color-text-secondary)]">
            <X size={18} />
          </button>
        </div>

        <div className="p-6">
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/20 text-[var(--color-danger)] text-sm">
              {error}
            </div>
          )}

          {/* Idle: Scan button */}
          {status === 'idle' && (
            <div className="text-center py-8">
              <div className="text-6xl mb-4 opacity-50">🎮</div>
              <p className="text-[var(--color-text-secondary)] mb-6">
                从 Steam 库自动扫描已安装的游戏
              </p>
              <button
                onClick={scan}
                className="px-8 py-3 rounded-xl bg-[var(--color-accent)] text-white font-semibold hover:bg-[var(--color-accent-hover)] transition-colors"
              >
                开始扫描
              </button>
            </div>
          )}

          {/* Scanning */}
          {status === 'scanning' && (
            <div className="text-center py-8">
              <Loader2 size={48} className="mx-auto mb-4 text-[var(--color-accent)] animate-spin" />
              <p className="text-[var(--color-text-secondary)]">正在扫描 Steam 库...</p>
            </div>
          )}

          {/* Selecting */}
          {(status === 'selecting' || status === 'importing') && (
            <>
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm text-[var(--color-text-secondary)]">
                  找到 <span className="text-white font-semibold">{steamGames.length}</span> 个游戏，已选择 <span className="text-[var(--color-accent)] font-semibold">{selected.size}</span> 个
                </p>
                <button
                  onClick={toggleAll}
                  className="text-xs text-[var(--color-accent)] hover:underline"
                >
                  {selected.size === steamGames.length ? '取消全选' : '全选'}
                </button>
              </div>

              <div className="max-h-72 overflow-y-auto space-y-1 mb-4">
                {steamGames.map((game, i) => (
                  <label
                    key={i}
                    className="flex items-center gap-3 p-2 rounded-lg hover:bg-[var(--color-surface-3)] cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(i)}
                      onChange={() => toggle(i)}
                      className="w-4 h-4 accent-[var(--color-accent)]"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{String(game.name)}</p>
                      <p className="text-xs text-[var(--color-text-secondary)] truncate">{String(game.install_dir)}</p>
                    </div>
                    <span className="badge text-[10px] shrink-0">{String(game.app_id)}</span>
                  </label>
                ))}
              </div>

              <div className="flex justify-end gap-3">
                <button
                  onClick={onClose}
                  className="px-5 py-2.5 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]"
                >
                  取消
                </button>
                <button
                  onClick={importSelected}
                  disabled={selected.size === 0 || status === 'importing'}
                  className="px-5 py-2.5 rounded-lg bg-[var(--color-accent)] text-white text-sm font-semibold hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-50 flex items-center gap-2"
                >
                  {status === 'importing' && <Loader2 size={14} className="animate-spin" />}
                  导入 {selected.size > 0 && `(${selected.size})`}
                </button>
              </div>
            </>
          )}

          {/* Done */}
          {status === 'done' && (
            <div className="text-center py-8">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-[var(--color-success)]/20 flex items-center justify-center">
                <Check size={32} className="text-[var(--color-success)]" />
              </div>
              <p className="text-lg font-semibold mb-2">导入成功！</p>
              <p className="text-[var(--color-text-secondary)] mb-6">已导入 <span className="text-white font-semibold">{imported}</span> 个游戏到你的游戏库</p>
              <button
                onClick={onClose}
                className="px-8 py-3 rounded-xl bg-[var(--color-accent)] text-white font-semibold hover:bg-[var(--color-accent-hover)] transition-colors"
              >
                完成
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
