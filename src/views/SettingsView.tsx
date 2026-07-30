import { useState } from 'react';
import { Settings as SettingsIcon, Sun, Moon, Monitor, Gamepad2, Tv, Download, Upload, ExternalLink } from 'lucide-react';
import { clsx } from 'clsx';
import * as api from '../api';
import { message } from '@tauri-apps/plugin-dialog';
import { save, open } from '@tauri-apps/plugin-dialog';

type ThemeMode = 'light' | 'dark' | 'system';
type UIMode = 'desktop' | 'ten-foot';

export default function SettingsView() {
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [uiMode, setUIMode] = useState<UIMode>('desktop');
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);

  const applyTheme = (t: ThemeMode) => {
    setTheme(t);
    document.documentElement.classList.toggle('dark', t === 'dark');
    document.documentElement.classList.toggle('light', t === 'light');
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const path = await save({
        title: '导出数据',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        defaultPath: 'zex-backup.json',
      });
      if (!path) { setExporting(false); return; }
      const data = await api.exportData();
      const { writeTextFile } = await import('@tauri-apps/plugin-fs');
      await writeTextFile(path, data);
      await message(`数据已导出到: ${path}`, { title: '导出成功', kind: 'info' });
    } catch (err: any) {
      await message(`导出失败: ${err.message}`, { title: '错误', kind: 'error' });
    } finally {
      setExporting(false);
    }
  };

  const handleImport = async () => {
    setImporting(true);
    try {
      const path = await open({
        title: '导入数据',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        multiple: false,
      });
      if (!path) { setImporting(false); return; }
      const { readTextFile } = await import('@tauri-apps/plugin-fs');
      const data = await readTextFile(path as string);
      await api.importData(data);
      await message('数据导入成功！', { title: '成功', kind: 'info' });
    } catch (err: any) {
      await message(`导入失败: ${err.message}`, { title: '错误', kind: 'error' });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-8 flex items-center gap-3">
        <SettingsIcon size={28} />
        设置
      </h1>

      {/* Appearance */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-4">外观</h2>
        <div className="rounded-2xl bg-[var(--color-surface-2)] border border-[var(--color-border)] overflow-hidden">
          {/* Theme */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
            <div>
              <p className="text-sm font-medium">主题</p>
              <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">选择应用的主题色调</p>
            </div>
            <div className="flex gap-2">
              {[
                { value: 'light' as ThemeMode, icon: Sun, label: '浅色' },
                { value: 'dark' as ThemeMode, icon: Moon, label: '深色' },
                { value: 'system' as ThemeMode, icon: Monitor, label: '跟随系统' },
              ].map(({ value, icon: Icon, label }) => (
                <button
                  key={value}
                  onClick={() => applyTheme(value)}
                  className={clsx(
                    'flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors',
                    theme === value
                      ? 'bg-[var(--color-accent)] text-white'
                      : 'bg-[var(--color-surface-3)] text-[var(--color-text-secondary)] hover:bg-[var(--color-accent)]/20',
                  )}
                >
                  <Icon size={16} />
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* UI Mode */}
          <div className="flex items-center justify-between px-5 py-4">
            <div>
              <p className="text-sm font-medium">界面模式</p>
              <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">10 英尺模式适合电视和遥控器使用</p>
            </div>
            <div className="flex gap-2">
              {[
                { value: 'desktop' as UIMode, icon: Gamepad2, label: '桌面模式' },
                { value: 'ten-foot' as UIMode, icon: Tv, label: '10 英尺模式' },
              ].map(({ value, icon: Icon, label }) => (
                <button
                  key={value}
                  onClick={() => setUIMode(value)}
                  className={clsx(
                    'flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors',
                    uiMode === value
                      ? 'bg-[var(--color-accent)] text-white'
                      : 'bg-[var(--color-surface-3)] text-[var(--color-text-secondary)] hover:bg-[var(--color-accent)]/20',
                  )}
                >
                  <Icon size={16} />
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Data */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-4">数据</h2>
        <div className="rounded-2xl bg-[var(--color-surface-2)] border border-[var(--color-border)] overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
            <div>
              <p className="text-sm font-medium">导出数据</p>
              <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">将所有游戏和影视数据导出为 JSON 文件</p>
            </div>
            <button
              onClick={handleExport}
              disabled={exporting}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-surface-3)] text-sm font-medium hover:bg-[var(--color-accent)]/20 hover:text-[var(--color-accent)] transition-colors disabled:opacity-50"
            >
              <Download size={16} />
              {exporting ? '导出中...' : '导出'}
            </button>
          </div>
          <div className="flex items-center justify-between px-5 py-4">
            <div>
              <p className="text-sm font-medium">导入数据</p>
              <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">从 JSON 备份文件恢复数据</p>
            </div>
            <button
              onClick={handleImport}
              disabled={importing}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-surface-3)] text-sm font-medium hover:bg-[var(--color-accent)]/20 hover:text-[var(--color-accent)] transition-colors disabled:opacity-50"
            >
              <Upload size={16} />
              {importing ? '导入中...' : '导入'}
            </button>
          </div>
        </div>
      </section>

      {/* About */}
      <section>
        <h2 className="text-sm font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-4">关于</h2>
        <div className="rounded-2xl bg-[var(--color-surface-2)] border border-[var(--color-border)] p-5">
          <div className="flex items-center gap-4 mb-4">
            <div className="w-14 h-14 rounded-2xl bg-[var(--color-accent)] flex items-center justify-center text-3xl font-bold text-white">
              Z
            </div>
            <div>
              <h3 className="font-bold text-lg">ZEX</h3>
              <p className="text-sm text-[var(--color-text-secondary)]">版本 0.1.0</p>
            </div>
          </div>
          <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
            ZEX 是一款轻量级的游戏与影视库管理工具，支持 Steam 库扫描、封面自动搜索、游玩时间追踪和影视剧集管理。
          </p>
          <a
            href="https://github.com/Yuzexiaoyu/Zex"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 mt-3 text-sm text-[var(--color-accent)] hover:underline"
          >
            <ExternalLink size={16} />
            GitHub 仓库
          </a>
        </div>
      </section>
    </div>
  );
}
