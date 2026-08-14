import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { convertFileSrc } from '@tauri-apps/api/core';
import { message, open } from '@tauri-apps/plugin-dialog';
import { useAppStore } from '../store';
import type { Game } from '../types';
import { formatDuration } from '../utils/media';
import { useEscIntercept } from '../utils/escIntercept';
import { useFocusStore, useGamepadGroup, useFocusIndex, useRightStickScroll } from '../gamepad';
import {
  X, Play, Pencil, Trash2, Gamepad2, FolderOpen
} from 'lucide-react';

interface Props {
  gameId: string;
  onClose: () => void;
}

function formatDate(iso: string): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
}

// 详情弹出窗口：仅通过右键菜单「查看详情」进入（点击卡片不再打开）
// 设计概念：你在网格里右键的那张竖版封面，在这里"打开成实体卡盒"——
// 竖版封面卡与网格同源，是窗口唯一的图；其余全部退到玻璃上。
// 全窗口唯一的高饱和元素只有亮青色的「启动游戏」。
export default function GameDetail({ gameId, onClose }: Props) {
  const games = useAppStore((s) => s.games);
  const updateGame = useAppStore((s) => s.updateGame);
  const deleteGame = useAppStore((s) => s.deleteGame);
  const launchGame = useAppStore((s) => s.launchGame);
  const game = games.find((g) => g.id === gameId);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Game>>({});
  const [deleting, setDeleting] = useState(false);
  const [loading, setLoading] = useState(false);
  // 弹窗内信息滚动区（右摇杆滚动目标）
  const scrollRef = useRef<HTMLDivElement>(null);
  // 右摇杆滚动目标：详情弹窗打开时压栈、关闭恢复底层
  useRightStickScroll(scrollRef);

  useEffect(() => {
    if (game) {
      setForm({ ...game });
    }
  }, [gameId]);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 详情开着时由本页消费 Esc（先关详情），App 的全局「Esc=收托盘」让位
  useEscIntercept(true);

  // ─── 手柄焦点导航：层栈压入（栈底是游戏网格），B 弹栈关闭 ──
  // 纵向操作组：启动(0) → 编辑(1) → 删除(2) → 关闭(3)，与视觉位置自上而下一致
  const detailFocused = useFocusIndex('game-detail');
  useGamepadGroup('game-detail', {
    count: game ? 4 : 0,
    cols: 1,
    activate: (i) => {
      if (i === 0) void handleLaunch();
      else if (i === 1) setEditing((e) => !e);
      else if (i === 2) void handleDelete();
      else onClose();
    },
    exit: onClose,
  });
  useEffect(() => {
    useFocusStore.getState().push('game-detail');
    return () => {
      const s = useFocusStore.getState();
      const top = s.stack.length ? s.stack[s.stack.length - 1] : undefined;
      if (top?.group === 'game-detail') s.back();
    };
  }, []);

  if (!game) return null;

  // 浏览选择安装目录（整个游戏文件夹）
  const handleBrowseInstallDir = async () => {
    try {
      const selected = await open({ multiple: false, directory: true });
      if (selected && typeof selected === 'string') {
        setForm({ ...form, install_dir: selected });
      }
    } catch (err) {
      console.error('选择文件夹失败:', err);
    }
  };

  // 浏览选择启动程序（exe 文件）
  const handleBrowseExe = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: '可执行文件', extensions: ['exe'] }],
      });
      if (selected && typeof selected === 'string') {
        setForm({ ...form, exe_path: selected });
      }
    } catch (err) {
      console.error('选择启动程序失败:', err);
    }
  };

  const handleSave = async () => {
    // 与添加游戏同款校验：安装目录必须包含启动程序（防止把无关目录赋给游戏）
    const dir = (form.install_dir || '').trim();
    const exe = (form.exe_path || '').trim();
    if (dir && exe) {
      const dirNorm = dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const exeNorm = exe.replace(/\\/g, '/').toLowerCase();
      if (!exeNorm.startsWith(dirNorm + '/')) {
        await message('启动程序不在该安装目录内。安装目录应填写「包含启动程序在内的整个游戏文件夹」', { title: '无法保存', kind: 'warning' });
        return;
      }
    }
    setLoading(true);
    try {
      await updateGame(gameId, form);
      setEditing(false);
    } catch (err: any) {
      // 失败必须提示：无 catch 的话按钮复位但用户以为保存成功了，下次打开才发现没生效
      await message(`保存失败：${typeof err === 'string' ? err : (err?.message ?? String(err))}`, { title: '错误', kind: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`确定要删除 "${game.name}" 吗？`)) return;
    setDeleting(true);
    try {
      await deleteGame(gameId); // store 会清空 selectedGameId，窗口自动关闭
    } catch (err: any) {
      await message(`删除失败：${typeof err === 'string' ? err : (err?.message ?? String(err))}`, { title: '错误', kind: 'error' });
    } finally {
      setDeleting(false);
    }
  };

  const handleLaunch = async () => {
    try {
      await launchGame(gameId);
    } catch (err: any) {
      await message(`启动失败：${typeof err === 'string' ? err : (err?.message ?? String(err))}`, { title: '错误', kind: 'error' });
    }
  };

  const tags: string[] = JSON.parse(game.tags || '[]');
  const coverSrc = game.cover_path || game.banner_path;

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-6">
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in" onClick={onClose} />

      {/* 窗口：四周大留白，元素不贴边框 */}
      <div className="relative w-[720px] max-w-full max-h-[85vh] glass-modal shadow-2xl animate-scale-in flex flex-col overflow-hidden">
        <div className="p-7 flex flex-col min-h-0">

          {/* Close：悬浮在玻璃上，不贴任何元素 */}
          <button
            onClick={onClose}
            className={clsx('absolute top-7 right-7 z-30 w-9 h-9 rounded-xl glass-card flex items-center justify-center text-text-secondary hover:text-text-primary/80', detailFocused === 3 && 'gamepad-focus')}
          >
            <X size={16} />
          </button>

          {/* 主区：竖版封面卡（唯一图片）+ 标题列 */}
          <div className="relative flex gap-6">
            {/* 封面卡：与网格同源的竖版封面 */}
            <div className="w-40 shrink-0 self-start rounded-xl overflow-hidden shadow-2xl border border-border-glass bg-bg-surface">
              {coverSrc ? (
                <img
                  src={convertFileSrc(coverSrc, 'covers')}
                  alt={game.name}
                  className="w-full aspect-[2/3] object-cover"
                />
              ) : (
                <div className="w-full aspect-[2/3] flex items-center justify-center bg-gradient-to-br from-bg-surface to-bg-surface-active">
                  <Gamepad2 size={40} className="text-text-tertiary" />
                </div>
              )}
            </div>

            {/* 标题列：字重最高 → 状态文字次之 */}
            <div className="flex-1 min-w-0 pt-1.5">
              <h2 className="text-xl font-bold leading-snug text-text-primary line-clamp-2 mb-1.5">{game.name}</h2>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary tabular-nums">
                <span>{game.total_seconds > 0 ? `已玩 ${formatDuration(game.total_seconds)}` : '未游玩'}</span>
                <span className="text-text-tertiary">·</span>
                <span>添加于 {formatDate(game.created_at)}</span>
              </div>
            </div>
          </div>

          {/* 操作区：主按钮全窗口唯一高饱和 */}
          <div className="shrink-0 mt-6">
            <button
              onClick={handleLaunch}
              className={clsx('w-full btn btn-accent py-3 text-sm font-semibold mb-3', detailFocused === 0 && 'gamepad-focus')}
            >
              <Play size={16} fill="currentColor" />
              启动游戏
            </button>

            <button
              onClick={() => setEditing(!editing)}
              className={clsx('w-full btn btn-ghost py-2 text-sm mb-2', detailFocused === 1 && 'gamepad-focus')}
            >
              <Pencil size={14} />
              {editing ? '取消编辑' : '编辑信息'}
            </button>

            {/* Edit form */}
            {editing && (
              <div className="glass-card p-4 mb-2 space-y-3 animate-fade-up">
                <label className="block text-xs text-text-secondary">
                  安装目录
                  <div className="flex gap-1.5 mt-1">
                    <input
                      type="text"
                      value={form.install_dir || ''}
                      onChange={(e) => setForm({ ...form, install_dir: e.target.value })}
                      className="input text-sm flex-1 min-w-0"
                      placeholder="游戏整个文件夹（磁盘管理移动游戏的前提）"
                    />
                    <button
                      type="button"
                      onClick={handleBrowseInstallDir}
                      className="shrink-0 h-9 px-3 rounded-xl bg-[rgba(0,212,255,0.12)] border border-[rgba(0,212,255,0.25)] hover:bg-[rgba(0,212,255,0.22)] flex items-center gap-1.5 text-xs text-[#00d4ff] transition-all"
                      title="浏览选择安装目录"
                    >
                      <FolderOpen size={13} />
                      浏览
                    </button>
                  </div>
                </label>
                <label className="block text-xs text-text-secondary">
                  启动程序
                  <div className="flex gap-1.5 mt-1">
                    <input
                      type="text"
                      value={form.exe_path || ''}
                      onChange={(e) => setForm({ ...form, exe_path: e.target.value })}
                      className="input text-sm flex-1 min-w-0"
                      placeholder="如 D:\\Games\\MyGame\\game.exe"
                    />
                    <button
                      type="button"
                      onClick={handleBrowseExe}
                      className="shrink-0 h-9 px-3 rounded-xl bg-[rgba(0,212,255,0.12)] border border-[rgba(0,212,255,0.25)] hover:bg-[rgba(0,212,255,0.22)] flex items-center gap-1.5 text-xs text-[#00d4ff] transition-all"
                      title="浏览选择启动程序"
                    >
                      <FolderOpen size={13} />
                      浏览
                    </button>
                  </div>
                </label>
                <label className="block text-xs text-text-secondary">
                  启动参数
                  <input
                    type="text"
                    value={form.launch_args || ''}
                    onChange={(e) => setForm({ ...form, launch_args: e.target.value })}
                    className="input mt-1 text-sm"
                    placeholder="如 -applaunch 730"
                  />
                </label>
                <button
                  onClick={handleSave}
                  disabled={loading}
                  className="w-full btn btn-accent py-2.5 text-sm"
                >
                  {loading ? '保存中...' : '保存'}
                </button>
              </div>
            )}
          </div>

          {/* 滚动信息区：详情最弱最浅，删除纯文字标红在最底部 */}
          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto mt-5 pr-0.5">
            <div className="flex flex-col">

              <div className="space-y-2.5 mb-6">
                <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-3">详情</h3>

                {game.exe_path && (
                  <div className="grid grid-cols-[64px_1fr] gap-x-4 text-xs leading-relaxed">
                    <span className="text-text-tertiary">启动路径</span>
                    <span className="text-text-secondary/80 truncate" title={game.exe_path}>{game.exe_path}</span>
                  </div>
                )}

                {game.launch_args && (
                  <div className="grid grid-cols-[64px_1fr] gap-x-4 text-xs leading-relaxed">
                    <span className="text-text-tertiary">启动参数</span>
                    <span className="text-text-secondary/80 break-words">{game.launch_args}</span>
                  </div>
                )}

                {tags.length > 0 && (
                  <div className="flex items-start gap-x-4 text-xs">
                    <span className="text-text-tertiary w-16 shrink-0">标签</span>
                    <div className="flex flex-wrap gap-1.5">
                      {tags.map((tag) => (
                        <span key={tag} className="badge">{tag}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>


              <button
                onClick={handleDelete}
                disabled={deleting}
                className={clsx('w-full btn py-2 text-sm text-danger/70 hover:text-danger', detailFocused === 2 && 'gamepad-focus')}
              >
                <Trash2 size={14} />
                {deleting ? '删除中...' : '删除游戏'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
