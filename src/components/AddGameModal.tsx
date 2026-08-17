import { useState } from 'react';
import { useAppStore } from '../store';
import * as api from '../api';
import { X, Plus, FolderOpen, Terminal, Layers, Gamepad2, Sparkles, AlertCircle, Folder } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { useModalGamepad } from '../gamepad';
import { useT } from '../i18n';

interface Props {
  onClose: () => void;
}

export default function AddGameModal({ onClose }: Props) {
  const t = useT();
  const createGame = useAppStore((s) => s.createGame);
  const loadGames = useAppStore((s) => s.loadGames);
  const [name, setName] = useState('');
  const [exePath, setExePath] = useState('');
  const [installDir, setInstallDir] = useState('');
  const [launchArgs, setLaunchArgs] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // 弹窗期间手柄按键不穿透到背后视图（B/Esc 关闭，表单内容用鼠标操作）
  useModalGamepad('modal:add-game', { onClose });

  // 选择 exe：自动向上探测游戏安装根目录填入 install_dir（商业游戏 exe 常在
  // bin\x64 等子目录，直接填 exe 父目录会让磁盘管理移动时漏掉游戏主体）
  const handleSelectExe = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{
          name: t('games.exeFilter'),
          extensions: ['exe']
        }]
      });

      if (selected && typeof selected === 'string') {
        setExePath(selected);
        if (!name) {
          const fileName = selected.split('\\').pop()?.replace('.exe', '') || '';
          setName(fileName);
        }
        if (!installDir.trim()) {
          const root = await api.findGameRoot(selected).catch(() => '');
          if (root) setInstallDir(root);
        }
      }
    } catch (err) {
      console.error('选择文件失败:', err);
    }
  };

  // 选择安装目录（整个游戏文件夹）：自动递归找主 exe + 用文件夹名填游戏名
  const handleSelectFolder = async () => {
    try {
      const selected = await open({ multiple: false, directory: true });
      if (selected && typeof selected === 'string') {
        setInstallDir(selected);
        const folderName = selected.split(/[\\/]/).pop() || '';
        if (!name && folderName) setName(folderName);
        if (!exePath.trim() && folderName) {
          const exe = await api.findMainExe(selected, folderName).catch(() => '');
          if (exe) setExePath(exe);
        }
      }
    } catch (err) {
      console.error('选择文件夹失败:', err);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError(t('games.nameRequired')); return; }
    // 安装目录与启动程序必须关联：安装目录填成别的游戏的目录（如把 D:\Epic 赋给 DSX），
    // 磁盘管理移动时会把无关目录整个搬走+删掉 —— 前端先拦一道
    const exeTrim = exePath.trim();
    const installDirFinal = installDir.trim();
    if (installDirFinal && exeTrim) {
      const dirNorm = installDirFinal.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const exeNorm = exeTrim.replace(/\\/g, '/').toLowerCase();
      if (!exeNorm.startsWith(dirNorm + '/')) {
        setError(t('games.dirMismatch'));
        return;
      }
    }
    setLoading(true);
    setError('');
    try {
      console.log('Creating game with data:', {
        name: name.trim(),
        install_dir: installDirFinal,
        exe_path: exePath.trim(),
        launch_args: launchArgs.trim(),
        env_vars: '{}',
        work_dir: '',
        cover_path: '',
        banner_path: '',
        bg_path: '',
        play_count: 0,
        notes: '',
        tags: '[]',
        favorite: false,
        hidden: false,
      });

      await createGame({
        name: name.trim(),
        install_dir: installDirFinal,
        exe_path: exePath.trim(),
        launch_args: launchArgs.trim(),
        env_vars: '{}',
        work_dir: '',
        cover_path: '',
        banner_path: '',
        bg_path: '',
        play_count: 0,
        notes: '',
        tags: '[]',
        favorite: false,
        hidden: false,
      });

      console.log('Game created successfully');
      await loadGames();
      onClose();
    } catch (err: any) {
      console.error('Failed to create game:', err);
      setError(err.message || err.toString() || t('games.addFailed'));
    } finally {
      setLoading(false);
    }
  };

  const inputClass = 'w-full h-11 px-4 rounded-xl text-sm bg-bg-surface border border-border-glass text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-[#00d4ff]/60 focus:bg-[rgba(0,212,255,0.05)] transition-all';
  const labelClass = 'flex items-center gap-1.5 text-xs font-medium text-text-secondary mb-2';

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-5" onClick={onClose}>
      <div className="absolute inset-0 bg-black/75 backdrop-blur-md animate-fade-in" />

      <div
        className="relative w-[92vw] max-w-4xl overflow-hidden glass-modal shadow-2xl animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部氛围光 */}
        <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-br from-[#00d4ff]/18 via-[#0066ff]/10 to-transparent pointer-events-none" />

        {/* Header */}
        <div className="relative flex items-start justify-between px-7 py-6 border-b border-border-glass">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-2xl bg-[#00d4ff] text-black flex items-center justify-center shadow-lg glow-accent">
              <Gamepad2 size={22} />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h2 className="text-xl font-bold tracking-tight">{t('games.addGame')}</h2>
                <span className="badge badge-accent gap-1">
                  <Sparkles size={11} />
                  {t('games.manualEntry')}
                </span>
              </div>
              <p className="text-sm text-text-secondary leading-relaxed">
                {t('games.addGameDesc')}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-10 h-10 rounded-xl flex items-center justify-center text-text-secondary hover:text-white hover:bg-bg-surface-active transition-all"
            title={t('common.close')}
          >
            <X size={18} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="relative p-7 space-y-5 max-h-[72vh] overflow-y-auto">
          {error && (
            <div className="flex items-center gap-2.5 p-3.5 rounded-xl bg-[#ef4444]/10 border border-[#ef4444]/25 text-[#ef4444] text-sm">
              <AlertCircle size={16} className="shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="grid grid-cols-[1fr_220px] gap-5 max-md:grid-cols-1">
            <div className="space-y-5">
              <section className="glass-card p-4 hover:transform-none">
                <label className={labelClass}>
                  <Layers size={13} />
                  {t('games.name')} <span className="text-[#00d4ff]">*</span>
                </label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={inputClass}
                  placeholder={t('games.namePlaceholder')}
                  autoFocus
                />
              </section>

              <section className="glass-card p-4 hover:transform-none">
                <label className={labelClass}>
                  <FolderOpen size={13} />
                  {t('games.exePath')}
                </label>
                <div className="flex gap-2">
                  <input
                    value={exePath}
                    onChange={(e) => setExePath(e.target.value)}
                    className={inputClass}
                    placeholder={t('games.exePlaceholder')}
                  />
                  <button
                    type="button"
                    onClick={handleSelectExe}
                    className="shrink-0 h-11 px-4 rounded-xl bg-[rgba(0,212,255,0.12)] border border-[rgba(0,212,255,0.25)] hover:bg-[rgba(0,212,255,0.22)] flex items-center justify-center gap-2 text-sm text-[#00d4ff] transition-all"
                    title={t('games.pickExeTitle')}
                  >
                    <FolderOpen size={16} />
                    {t('common.browse')}
                  </button>
                </div>
                <p className="mt-2 text-xs text-text-tertiary">
                  {t('games.exePathHint')}
                </p>
              </section>

              <section className="glass-card p-4 hover:transform-none">
                <label className={labelClass}>
                  <Folder size={13} />
                  {t('games.installDir')}
                </label>
                <div className="flex gap-2">
                  <input
                    value={installDir}
                    onChange={(e) => setInstallDir(e.target.value)}
                    className={inputClass}
                    placeholder={t('games.installPlaceholder')}
                  />
                  <button
                    type="button"
                    onClick={handleSelectFolder}
                    className="shrink-0 h-11 px-4 rounded-xl bg-[rgba(0,212,255,0.12)] border border-[rgba(0,212,255,0.25)] hover:bg-[rgba(0,212,255,0.22)] flex items-center justify-center gap-2 text-sm text-[#00d4ff] transition-all"
                    title={t('games.pickDirTitle')}
                  >
                    <Folder size={16} />
                    {t('common.browse')}
                  </button>
                </div>
                <p className="mt-2 text-xs text-text-tertiary">
                  {t('games.installHint')}
                </p>
                {!installDir.trim() && (
                  <p className="mt-1.5 text-xs text-[#eab308]/80">
                    {t('games.installMissingWarn')}
                  </p>
                )}
              </section>

              <section className="glass-card p-4 hover:transform-none">
                <label className={labelClass}>
                  <Terminal size={13} />
                  {t('games.launchArgs')}
                </label>
                <input
                  value={launchArgs}
                  onChange={(e) => setLaunchArgs(e.target.value)}
                  className={inputClass}
                  placeholder={t('games.launchArgsPlaceholder')}
                />
              </section>
            </div>

            <aside className="glass-card p-4 flex flex-col justify-between min-h-[240px] hover:transform-none">
              <div>
                <div className="w-full aspect-[4/5] rounded-2xl bg-gradient-to-br from-[#00d4ff]/18 via-[#0066ff]/10 to-bg-surface border border-border-glass flex items-center justify-center mb-4 overflow-hidden">
                  <div className="w-16 h-16 rounded-2xl bg-[#00d4ff]/12 border border-[#00d4ff]/25 flex items-center justify-center glow-accent">
                    <Gamepad2 size={30} className="text-[#00d4ff]" />
                  </div>
                </div>
                <p className="text-sm font-semibold truncate">{name.trim() || t('games.newGame')}</p>
                <p className="mt-1 text-xs text-text-secondary break-all line-clamp-3">
                  {exePath.trim() || t('games.pathPreviewHint')}
                </p>
              </div>
              <div className="mt-4 pt-4 border-t border-border-glass space-y-2 text-xs text-text-secondary">
                <div className="flex items-center justify-between">
                  <span>{t('games.coverLabel')}</span>
                  <span className="text-text-tertiary">{t('games.setAfterAdd')}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>{t('games.tagsLabel')}</span>
                  <span className="text-text-tertiary">{t('games.editAfterAdd')}</span>
                </div>
              </div>
            </aside>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-3 pt-2">
            <p className="text-xs text-text-tertiary">{t('games.requiredHint')}</p>
            <div className="flex justify-end gap-3">
              <button type="button" onClick={onClose} className="btn btn-ghost py-3 px-5 text-sm">
                {t('common.cancel')}
              </button>
              <button type="submit" disabled={loading} className="btn btn-accent py-3 px-6 text-sm disabled:opacity-60 disabled:cursor-not-allowed">
                {loading ? t('games.adding') : (<><Plus size={15} />{t('games.addGame')}</>)}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
