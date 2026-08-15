import { useState } from 'react';
import { X, Gamepad2, Clock } from 'lucide-react';
import { useModalGamepad } from '../gamepad';
import { setGameSeconds } from '../api';
import type { TopEntry } from '../types';
import { longDur } from './StatsCovers';

// 手工修正时长的上限（小时）：防止误输把字段撑爆
const MAX_HOURS = 99999;

interface Props {
  entry: TopEntry;
  onClose: () => void;
  onSaved: () => void; // 保存成功后回调（外层刷新统计）
}

// 输入框只放行数字（粘贴/手输都可能带出非数字字符，统一过滤）
function digits(v: string): string {
  return v.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
}

/** 统计页游戏行右键「调整时长」弹窗：小时/分钟输入，直接覆盖 games.total_seconds。
 *  弹窗骨架与样式对齐 AddSeriesModal（遮罩 + glass-modal + btn-accent 按钮组）；
 *  手柄走屏蔽模式 —— 与既有表单弹窗一致，仅保证按键不穿透、B/Esc 可关闭 */
export default function StatsAdjustModal({ entry, onClose, onSaved }: Props) {
  const [hours, setHours] = useState(() => String(Math.floor(entry.seconds / 3600)));
  const [minutes, setMinutes] = useState(() => String(Math.floor((entry.seconds % 3600) / 60)));
  const [saving, setSaving] = useState(false);

  useModalGamepad('modal:stats-adjust', { onClose });

  // 分钟输入超过 59 自动进位到小时（90 → 1 小时 30 分），而不是拦截或截断
  const handleMinutes = (raw: string) => {
    const m = Number(digits(raw) || 0);
    setMinutes(String(m % 60));
    if (m >= 60) setHours((h) => String(Number(h || 0) + Math.floor(m / 60)));
  };

  // 实时换算总时长（保存前预览）
  const previewSeconds = (Number(hours || 0) * 3600) + (Number(minutes || 0) * 60);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const h = Number(hours || 0);
    const m = Number(minutes || 0);
    if (h > MAX_HOURS) {
      alert(`请输入不超过 ${MAX_HOURS} 小时的时长`);
      return;
    }
    const seconds = h * 3600 + m * 60;
    setSaving(true);
    try {
      await setGameSeconds(entry.id, seconds);
      onSaved();
    } catch (err) {
      // 游戏在弹窗期间被删：后端 UPDATE 影响 0 行返回错误，提示并强制刷新
      alert(typeof err === 'string' ? err : '保存失败，请重试');
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in" />
      <div className="relative w-full max-w-md glass-modal shadow-2xl animate-scale-in">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-border-glass">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-[rgba(0,212,255,0.12)] border border-[rgba(0,212,255,0.2)] flex items-center justify-center shrink-0">
              <Gamepad2 size={18} className="text-[#00d4ff]" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-bold leading-tight">调整游戏时长</h2>
              <p className="text-xs text-text-secondary truncate" title={entry.name}>{entry.name}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-xl flex items-center justify-center text-text-secondary hover:text-white hover:bg-bg-surface-active transition-all shrink-0"
            title="关闭"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* 当前时长提示 */}
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <Clock size={14} className="text-[#00d4ff]" />
            当前时长：<span className="text-[#00d4ff] font-semibold">{longDur(entry.seconds)}</span>
          </div>

          {/* 小时 / 分钟 */}
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-xs text-text-secondary mb-1.5">小时</label>
              <input
                type="text"
                inputMode="numeric"
                value={hours}
                onChange={(e) => setHours(digits(e.target.value))}
                placeholder="0"
                autoFocus
                className="w-full px-4 py-3 rounded-xl text-sm bg-bg-surface border border-border-glass text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-[#00d4ff]/50 focus:bg-[rgba(0,212,255,0.04)] transition-all"
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs text-text-secondary mb-1.5">分钟</label>
              <input
                type="text"
                inputMode="numeric"
                value={minutes}
                onChange={(e) => handleMinutes(e.target.value)}
                placeholder="0"
                className="w-full px-4 py-3 rounded-xl text-sm bg-bg-surface border border-border-glass text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-[#00d4ff]/50 focus:bg-[rgba(0,212,255,0.04)] transition-all"
              />
            </div>
          </div>

          {/* 实时预览：输入即换算（如 90 分钟自动进位成 1 小时 30 分） */}
          <div className="flex items-center gap-2 text-sm">
            <span className="text-text-secondary">设置后：</span>
            <span className="text-[#00d4ff] font-semibold">
              {previewSeconds >= 3600
                ? `${Math.floor(previewSeconds / 3600)} 小时 ${Math.floor((previewSeconds % 3600) / 60)} 分`
                : `${Math.floor(previewSeconds / 60)} 分钟`}
            </span>
          </div>
          <p className="text-xs text-text-tertiary">手动修正累计时长，下次游玩后增量照常累加</p>

          {/* 按钮 */}
          <div className="flex gap-4 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="flex-1 btn btn-ghost py-3 px-6 text-sm"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 btn btn-accent py-3 px-6 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
