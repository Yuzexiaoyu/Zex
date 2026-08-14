import { useState } from 'react';
import { X, Folder, Film, Clapperboard } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { createSeries, createSeason, createEpisode, scanVideoFolder } from '../api';
import type { ScannedEpisode } from '../api';
import { useModalGamepad } from '../gamepad';

interface AddSeriesModalProps {
  onClose: () => void;
  onSuccess: () => void;
}

type AddMode = 'folder' | 'movie';

const VIDEO_EXTS = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'ts', 'rmvb'];

// 从视频文件名猜片名：去扩展名 → 分隔符转空格 → 截断到年份/压制标记之前
function guessTitleFromFile(filePath: string): string {
  const base = (filePath.split(/[/\\]/).pop() || '').replace(/\.[^.]+$/, '');
  const spaced = base.replace(/[._]+/g, ' ').trim();
  const cut = spaced.split(/\s+(?:(?:19|20)\d{2}|1080p|720p|2160p|4K|BluRay|WEB-?DL|HDR|x26[45])\b/i)[0];
  return (cut || spaced).trim();
}

const inputClass = 'w-full px-4 py-3 rounded-xl text-sm bg-bg-surface border border-border-glass text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-[#00d4ff]/50 focus:bg-[rgba(0,212,255,0.04)] transition-all';

export default function AddSeriesModal({ onClose, onSuccess }: AddSeriesModalProps) {
  const [mode, setMode] = useState<AddMode>('folder');
  const [name, setName] = useState('');
  const [overview, setOverview] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [filePath, setFilePath] = useState('');   // 电影模式：单个视频文件
  const [scannedEpisodes, setScannedEpisodes] = useState<ScannedEpisode[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // 弹窗期间手柄按键不穿透到背后（B/Esc 关闭，表单与扫描用鼠标；嵌套的 TMDB
  // 消歧弹窗会压栈在本组之上，Esc 由钩子的栈顶检查逐层关闭）
  useModalGamepad('modal:add-series', { onClose });

  const handleSelectFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });

      if (selected && typeof selected === 'string') {
        setFolderPath(selected);
        setIsScanning(true);
        try {
          const result = await scanVideoFolder(selected);
          setScannedEpisodes(result.episodes);

          // 自动从文件夹名提取剧集名
          const folderName = selected.split(/[/\\]/).pop() || '';
          if (!name && folderName) {
            setName(folderName);
          }
        } catch (err) {
          console.error('扫描文件夹失败:', err);
          alert('扫描文件夹失败，请检查文件夹路径');
        } finally {
          setIsScanning(false);
        }
      }
    } catch (err) {
      console.error('选择文件夹失败:', err);
    }
  };

  // 电影：选单个视频文件，片名从文件名猜一个（用户可改）
  const handleSelectFile = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: '视频文件', extensions: VIDEO_EXTS }],
      });
      if (selected && typeof selected === 'string') {
        setFilePath(selected);
        if (!name) setName(guessTitleFromFile(selected));
      }
    } catch (err) {
      console.error('选择文件失败:', err);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      alert('请输入影视名称');
      return;
    }

    if (mode === 'movie' && !filePath) {
      alert('请选择视频文件');
      return;
    }

    setIsSubmitting(true);
    try {
      // 1. 创建剧集（后端需要完整的 Series 对象）
      const seriesData = {
        id: '',  // 后端会生成
        title: name.trim(),
        aliases: '',
        overview: overview.trim() || '',
        poster_path: '',
        bg_path: '',
        first_air_date: '',
        status: mode === 'movie' ? '' : '连载中',
        tmdb_id: 0,
        tvdb_id: 0,
        tags: '',
        favorite: false,
        media_type: mode === 'movie' ? 'movie' : 'tv',
        created_at: '',  // 后端会生成
        updated_at: '',  // 后端会生成
      };

      const series = await createSeries(seriesData as any);

      // 电影：一季一集承载本地文件与观看状态，界面上不显示季/集结构
      if (mode === 'movie') {
        const season = await createSeason({
          id: '',
          series_id: series.id,
          season_number: 1,
          name: '正片',
          overview: '',
          poster_path: '',
          first_air_date: '',
        } as any);
        await createEpisode({
          id: '',
          series_id: series.id,
          season_id: season.id,
          episode_number: 1,
          title: name.trim(),
          overview: '',
          still_path: '',
          air_date: '',
          runtime_minutes: 0,
          local_path: filePath,
          watched_ms: 0,
          last_watched_at: '',
          watched: false,
        } as any);
        onSuccess();
        onClose();
        return;
      }

      // 2. 如果是文件夹模式且有扫描结果，自动创建季和集
      if (mode === 'folder' && scannedEpisodes.length > 0) {
        // 按季号分组
        const seasonMap = new Map<number, ScannedEpisode[]>();
        scannedEpisodes.forEach(ep => {
          if (!seasonMap.has(ep.season_number)) {
            seasonMap.set(ep.season_number, []);
          }
          seasonMap.get(ep.season_number)!.push(ep);
        });

        // 创建每一季
        for (const [seasonNum, episodes] of seasonMap.entries()) {
          const seasonData = {
            id: '',
            series_id: series.id,
            season_number: seasonNum,
            name: `第 ${seasonNum} 季`,
            overview: '',
            poster_path: '',
            first_air_date: '',
            created_at: '',
            updated_at: '',
          };
          const season = await createSeason(seasonData as any);

          // 创建每一集
          for (const ep of episodes) {
            const episodeData = {
              id: '',
              series_id: series.id,
              season_id: season.id,
              episode_number: ep.episode_number,
              title: ep.file_name.replace(/\.[^./\\]+$/, ''), // 去掉文件名扩展名（.mp4/.mkv）
              overview: '',
              still_path: '',
              air_date: '',
              runtime_minutes: 0,
              local_path: ep.file_path,
              watched_ms: 0,
              last_watched_at: '',
              watched: false,
              created_at: '',
              updated_at: '',
            };
            await createEpisode(episodeData as any);
          }
        }
      }

      onSuccess();
      onClose();
    } catch (err) {
      console.error('添加影视失败:', err);
      alert('添加失败，请重试');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in" />
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto glass-modal shadow-2xl animate-scale-in">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-border-glass sticky top-0 glass-modal" style={{ background: 'inherit' }}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-[rgba(0,212,255,0.12)] border border-[rgba(0,212,255,0.2)] flex items-center justify-center">
              <Film size={18} className="text-[#00d4ff]" />
            </div>
            <h2 className="text-lg font-bold">添加影视</h2>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-xl flex items-center justify-center text-text-secondary hover:text-white hover:bg-bg-surface-active transition-all"
            title="关闭"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {/* 模式选择 */}
          <div className="flex gap-3">
            {([
              { key: 'folder' as const, icon: Folder, label: '剧集文件夹' },
              { key: 'movie' as const, icon: Clapperboard, label: '单个视频（电影）' },
            ]).map(({ key, icon: Icon, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => setMode(key)}
                className={`flex-1 py-3 px-3 rounded-xl border transition-all flex items-center justify-center gap-2 text-sm font-medium ${
                  mode === key
                    ? 'bg-[rgba(0,212,255,0.12)] border-[#00d4ff]/40 text-[#00d4ff]'
                    : 'bg-bg-surface border-border-glass text-text-secondary hover:border-border-glass-hover hover:text-text-primary'
                }`}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* 文件夹扫描模式 */}
            {mode === 'folder' && (
              <div>
                <label className="block text-xs text-text-secondary mb-1.5">
                  选择视频文件夹 *
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={folderPath}
                    readOnly
                    placeholder="点击右侧按钮选择文件夹"
                    className={inputClass}
                  />
                  <button
                    type="button"
                    onClick={handleSelectFolder}
                    disabled={isScanning}
                    className="flex-shrink-0 px-4 py-3 rounded-xl bg-[rgba(0,212,255,0.12)] border border-[rgba(0,212,255,0.2)] hover:bg-[rgba(0,212,255,0.2)] flex items-center justify-center gap-2 text-sm text-[#00d4ff] transition-all disabled:opacity-50"
                  >
                    {isScanning ? '扫描中...' : (<><Folder size={16} /> 选择</>)}
                  </button>
                </div>
                {scannedEpisodes.length > 0 && (
                  <p className="mt-2 text-xs text-[#00d4ff]">
                    ✓ 已扫描到 {scannedEpisodes.length} 个视频文件
                  </p>
                )}
              </div>
            )}

            {/* 电影模式：选单个视频文件 */}
            {mode === 'movie' && (
              <div>
                <label className="block text-xs text-text-secondary mb-1.5">
                  选择视频文件 *
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={filePath}
                    readOnly
                    placeholder="点击右侧按钮选择 mp4 / mkv 等视频文件"
                    className={inputClass}
                  />
                  <button
                    type="button"
                    onClick={handleSelectFile}
                    className="flex-shrink-0 px-4 py-3 rounded-xl bg-[rgba(0,212,255,0.12)] border border-[rgba(0,212,255,0.2)] hover:bg-[rgba(0,212,255,0.2)] flex items-center justify-center gap-2 text-sm text-[#00d4ff] transition-all"
                  >
                    <Clapperboard size={16} />
                    选择
                  </button>
                </div>
                <p className="mt-2 text-xs text-text-tertiary">
                  添加后右键「获取元数据」会按电影库检索 TMDB，拿到海报、简介、时长与上映日期
                </p>
              </div>
            )}

            {/* 基本信息 */}
            <div>
              <label className="block text-xs text-text-secondary mb-1.5">
                {mode === 'movie' ? '电影名称 *' : '影视名称 *'}
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={mode === 'movie' ? '例如：奥德赛' : '例如：我的解放日记'}
                required
                className={inputClass}
              />
            </div>

            <div>
              <label className="block text-xs text-text-secondary mb-1.5">
                简介
              </label>
              <textarea
                value={overview}
                onChange={(e) => setOverview(e.target.value)}
                placeholder="简单描述这部影视作品..."
                rows={4}
                className={`${inputClass} resize-none`}
              />
            </div>

            {/* 按钮 */}
            <div className="flex gap-4 pt-2">
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="flex-1 btn btn-ghost py-3 px-6 text-sm"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={isSubmitting || (mode === 'folder' && !folderPath) || (mode === 'movie' && !filePath)}
                className="flex-1 btn btn-accent py-3 px-6 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? '添加中...' : '添加影视'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
