import { useState } from 'react';
import { useAppStore } from '../store';
import { X } from 'lucide-react';

interface Props {
  onClose: () => void;
}

export default function AddGameModal({ onClose }: Props) {
  const { createGame, loadGames } = useAppStore();
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState('PC');
  const [exePath, setExePath] = useState('');
  const [installDir, setInstallDir] = useState('');
  const [launchArgs, setLaunchArgs] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('请输入游戏名称'); return; }
    setLoading(true);
    setError('');
    try {
      await createGame({
        name: name.trim(),
        platform,
        install_dir: installDir.trim(),
        exe_path: exePath.trim(),
        launch_args: launchArgs.trim(),
        env_vars: '{}',
        work_dir: installDir.trim(),
        cover_path: '',
        banner_path: '',
        bg_path: '',
        rating: 0,
        notes: notes.trim(),
        tags: '[]',
        favorite: false,
        hidden: false,
      });
      await loadGames();
      onClose();
    } catch (err: any) {
      setError(err.message || '添加失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg mx-4 bg-[var(--color-surface-2)] rounded-2xl shadow-2xl overflow-hidden animate-fade-in" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
          <h2 className="text-lg font-bold">添加游戏</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-3)] text-[var(--color-text-secondary)]">
            <X size={18} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
          {error && (
            <div className="p-3 rounded-lg bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/20 text-[var(--color-danger)] text-sm">
              {error}
            </div>
          )}

          <label className="block">
            <span className="text-sm font-medium text-[var(--color-text-secondary)]">游戏名称 *</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full mt-1 px-3 py-2 rounded-lg bg-[var(--color-surface-3)] border border-[var(--color-border)] text-sm focus:outline-none focus:border-[var(--color-accent)]"
              placeholder="输入游戏名称"
              autoFocus
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-[var(--color-text-secondary)]">平台</span>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              className="w-full mt-1 px-3 py-2 rounded-lg bg-[var(--color-surface-3)] border border-[var(--color-border)] text-sm focus:outline-none focus:border-[var(--color-accent)]"
            >
              <option value="PC">PC</option>
              <option value="Steam">Steam</option>
              <option value="Epic">Epic</option>
              <option value="GOG">GOG</option>
              <option value="PlayStation">PlayStation</option>
              <option value="Xbox">Xbox</option>
              <option value="Nintendo">Nintendo</option>
              <option value="Mobile">Mobile</option>
            </select>
          </label>

          <label className="block">
            <span className="text-sm font-medium text-[var(--color-text-secondary)]">可执行文件路径</span>
            <input
              value={exePath}
              onChange={(e) => setExePath(e.target.value)}
              className="w-full mt-1 px-3 py-2 rounded-lg bg-[var(--color-surface-3)] border border-[var(--color-border)] text-sm focus:outline-none focus:border-[var(--color-accent)]"
              placeholder="C:\Games\MyGame\game.exe"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-[var(--color-text-secondary)]">安装目录</span>
            <input
              value={installDir}
              onChange={(e) => setInstallDir(e.target.value)}
              className="w-full mt-1 px-3 py-2 rounded-lg bg-[var(--color-surface-3)] border border-[var(--color-border)] text-sm focus:outline-none focus:border-[var(--color-accent)]"
              placeholder="C:\Games\MyGame"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-[var(--color-text-secondary)]">启动参数</span>
            <input
              value={launchArgs}
              onChange={(e) => setLaunchArgs(e.target.value)}
              className="w-full mt-1 px-3 py-2 rounded-lg bg-[var(--color-surface-3)] border border-[var(--color-border)] text-sm focus:outline-none focus:border-[var(--color-accent)]"
              placeholder="-noeditor -skipintro"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-[var(--color-text-secondary)]">备注</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="w-full mt-1 px-3 py-2 rounded-lg bg-[var(--color-surface-3)] border border-[var(--color-border)] text-sm focus:outline-none focus:border-[var(--color-accent)] resize-none"
              placeholder="可选备注..."
            />
          </label>

          {/* Footer */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-5 py-2.5 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)] transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-5 py-2.5 rounded-lg bg-[var(--color-accent)] text-white text-sm font-medium hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-50"
            >
              {loading ? '添加中...' : '添加游戏'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
