import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { createPortal } from 'react-dom';
import { convertFileSrc } from '@tauri-apps/api/core';
import { EyeOff, Play, Clock, Gamepad2 } from 'lucide-react';
import type { Game } from '../types';
import { useInputMode } from '../gamepad';

interface Props {
  game: Game;
  onClick?: () => void; // 点击卡片不打开详情（详情仅右键菜单「查看详情」进入）
  onLaunch: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onPointerDown?: (e: React.PointerEvent) => void;
  dragging?: boolean;
  animationDelay?: number;
  previewDisabled?: boolean; // 拖拽排序期间禁用悬停预览
  focused?: boolean; // 手柄焦点：等效 hover，显示启动按钮 + 高亮
}

// 悬停预览卡固定宽度（翻转判断也要用它）
const PREVIEW_WIDTH = 400;

function formatTime(seconds: number): string {
  if (seconds === 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`; // 不足 1 分钟显示秒数，避免看着像 0m
}

export default function GameCard({ game, onClick, onLaunch, onContextMenu, onPointerDown, dragging, animationDelay = 0, previewDisabled = false, focused = false }: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  // bottom 记录被悬停卡片的底边：预览卡放不下时改为底部对齐卡片，而不是贴窗口底部。
  // 预览分两个来源：鼠标 hover（mousePos）与手柄焦点（focusPos），当前显示哪个由输入模式决定 ——
  // 两种控制互斥、实时切换，切走的那个来源位置保留但不显示，切换瞬间不残留对方封面
  const [mousePos, setMousePos] = useState<{ x: number; y: number; bottom: number } | null>(null);
  const [focusPos, setFocusPos] = useState<{ x: number; y: number; bottom: number } | null>(null);
  const mode = useInputMode();
  const preview = mode === 'gamepad' ? focusPos : mousePos;

  // 计算预览卡位置：水平贴卡片右侧（12px 间距），右侧放不下则翻转到左侧；垂直对齐卡片顶部。
  // 宽度取实测值（悬停封面按原比例显示，宽幅图会把预览卡撑宽），首帧还没渲染时退回常量
  const computePreviewPos = useCallback(() => {
    const el = cardRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const width = previewRef.current?.offsetWidth || PREVIEW_WIDTH;
    const x = r.right + 12 + width + 8 <= vw
      ? r.right + 12
      : r.left - 12 - width;
    return { x, y: r.top, bottom: r.bottom };
  }, []);

  // 把重算出的位置写回当前模式的来源（鼠标 hover / 手柄焦点）
  const applyPos = useCallback(() => {
    const p = computePreviewPos();
    if (!p) return;
    if (mode === 'gamepad') setFocusPos(p); else setMousePos(p);
  }, [mode, computePreviewPos]);

  // 用实际尺寸把预览卡夹在视口内（四周各留 8px 边距）：
  // 垂直放不下时底部对齐被悬停卡片的底边（预览始终贴着卡片，不飘到窗口底部形成横条）；
  // 水平方向长名把卡片向右撑宽、超出右缘时整体左移，名称始终完整可见（不截断）
  useLayoutEffect(() => {
    if (!preview || !previewRef.current) return;
    const el = previewRef.current;
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight;
    // 垂直：先贴卡片顶部，放不下则底部对齐卡片底边，最后夹进视口
    let y = preview.y;
    if (y + rect.height > vh - 8) y = preview.bottom - rect.height;
    y = Math.max(8, Math.min(y, vh - 8 - rect.height));
    // 水平：夹在视口内
    const x = Math.max(8, Math.min(preview.x, window.innerWidth - 8 - rect.width));
    if (x !== preview.x || y !== preview.y) {
      const next = { ...preview, x, y };
      if (mode === 'gamepad') setFocusPos(next); else setMousePos(next);
    }
  }, [preview, mode]);

  // 预览可见期间跟随滚动 / 窗口尺寸变化重新定位（滚动容器在 window 内部，用捕获监听）
  useEffect(() => {
    if (!preview) return;
    window.addEventListener('scroll', applyPos, true);
    window.addEventListener('resize', applyPos);
    return () => {
      window.removeEventListener('scroll', applyPos, true);
      window.removeEventListener('resize', applyPos);
    };
  }, [preview, applyPos]);

  // 拖拽结束恢复悬停时清空残留预览：拖拽期间卡片被实时重排移动/重挂载，mouseleave 可能不触发，
  // 残留的 preview 状态会导致松手时多个游戏同时弹窗（配合 GameGrid 拖拽中 pointer-events: none 双保险）
  useEffect(() => {
    if (!previewDisabled) { setMousePos(null); setFocusPos(null); }
  }, [previewDisabled]);

  // 手柄聚焦等效鼠标悬停：聚焦时写 focusPos（mousePos 不动，互不干扰），失焦/拖拽中清掉。
  // mouse 模式下 focused 恒为 false（GameGrid 已按输入模式门控），这里自然不弹手柄封面
  useEffect(() => {
    if (focused && !previewDisabled) {
      const p = computePreviewPos();
      if (p) setFocusPos(p);
    } else {
      setFocusPos(null);
    }
  }, [focused, previewDisabled, computePreviewPos]);

  // 拖拽中（自身拖动或 GameGrid 整体拖拽）不显示预览
  const showPreview = preview && !dragging && !previewDisabled;

  return (
    <>
      <div
        ref={cardRef}
        onClick={onClick}
        onContextMenu={onContextMenu}
        onPointerDown={onPointerDown}
        onMouseEnter={() => { const p = computePreviewPos(); if (p) setMousePos(p); }}
        onMouseLeave={() => setMousePos(null)}
        className={clsx('game-card', dragging && 'dragging', focused && 'gamepad-focus')}
        style={{
          animationDelay: dragging ? undefined : `${animationDelay}ms`,
        }}
      >
        {/* Cover image */}
        <div className="relative overflow-hidden">
          {game.cover_path ? (
            <img
              src={convertFileSrc(game.cover_path, 'covers')}
              alt={game.name}
              className="game-card-cover"
              loading="lazy"
            />
          ) : (
            <div
              className="game-card-cover flex items-center justify-center game-cover-fallback"
              style={{ aspectRatio: '2/3' }}
            >
              <Gamepad2 size={48} className="text-text-tertiary" />
            </div>
          )}

          {/* Full overlay with launch button */}
          <div className="game-card-overlay">
            <div className="game-card-launch">
              <button
                onClick={onLaunch}
                className="btn btn-accent gap-2 py-3 px-6 text-sm"
              >
                <Play size={16} fill="currentColor" />
                启动游戏
              </button>
            </div>
          </div>

          {/* Top badges */}
          <div className="absolute top-3 left-3 flex gap-1.5 z-10">
            {game.hidden && (
              <span className="w-7 h-7 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center text-text-secondary">
                <EyeOff size={13} />
              </span>
            )}
          </div>

        </div>
      </div>

      {/* 悬停预览卡：右侧小卡（名称 + 横屏封面 + 时长），portal 到 body，fixed 定位。
          名称不截断：过长时窗口向右扩展（左边缘不变）；横屏封面固定在 400px 内容区内不动 */}
      {showPreview && createPortal(
        <div
          ref={previewRef}
          className="game-preview-card"
          style={{ left: preview.x, top: preview.y }}
        >
          <p className="text-xl font-bold whitespace-nowrap leading-tight">{game.name}</p>
          {/* 内容区宽度跟随封面本身（不随名称变宽），下限为 PREVIEW_WIDTH */}
          <div className="game-preview-content">
            {game.banner_path ? (
              <img
                src={convertFileSrc(game.banner_path, 'covers')}
                alt={game.name}
                className="game-preview-banner"
                loading="lazy"
                // 宽度由原图比例决定，加载完成才知道 → 重算一次位置，避免左右贴边判断用了旧宽度
                onLoad={applyPos}
              />
            ) : (
              <div className="game-preview-banner game-preview-placeholder">
                <Gamepad2 size={28} className="text-text-tertiary" />
                <span className="text-[11px] text-text-tertiary">暂无横屏封面</span>
              </div>
            )}
            <div className="flex items-center gap-1.5 text-sm text-text-secondary mt-3">
              <Clock size={14} />
              {game.total_seconds > 0 ? formatTime(game.total_seconds) : '未游玩'}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
