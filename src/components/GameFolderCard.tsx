import { useMemo } from 'react';
import { clsx } from 'clsx';
import { FolderClosed, FolderDown, Clock, Gamepad2 } from 'lucide-react';
import CoverImg from './CoverImg';
import { coverSrc, formatDuration } from '../utils/media';
import { useFolderAccent } from '../utils/dominantColor';
import type { Game, GameFolder } from '../types';
import { useT } from '../i18n';

interface Props {
  folder: GameFolder;
  games: Game[];
  /** 这一格的实测宽度（GameGrid 量容器算出）。窄到一定程度换紧凑排版 */
  cellWidth: number;
  /** 这个文件夹的内容浮层正开着（卡片留一圈招牌色描边，指出浮层是从哪儿弹出来的） */
  open?: boolean;
  onContextMenu?: (e: React.MouseEvent) => void;
  onPointerDown?: (e: React.PointerEvent) => void;
  dragging?: boolean;
  /** 有游戏正被拖到这张卡上 → 高亮为落点 */
  dropActive?: boolean;
  animationDelay?: number;
  focused?: boolean; // 手柄焦点：等效 hover
}

// 拼图墙摆满几格。超过这个数就留一格给 "+N" —— 与其把第 5、6 张压成一条边，
// 不如把「还有更多」这件事直接摆出来
const TILE_MAX = 4;

// 文件夹卡：与封面卡同尺寸（2:3）占一格。
//
// 主视觉是一面**拼图墙**：文件夹里的前几张封面像照片墙一样铺满整张卡，
// 1 张铺满 / 2 张并排居中 / 3 张左中一张右中两张 / 4 张两行两列；再多就把右下格换成 "+N"。
// 于是「里面有哪些游戏」不用点开就能看清 —— 这是文件夹卡要传达的第一件事。
//
// 底色取首作封面的「招牌色」（utils/dominantColor.ts），封面本身再模糊一层垫在
// 拼图的缝隙后面当氛围色，于是每张文件夹卡都是它自己的一套配色。
//
// 悬停不放「打开文件夹」按钮：拼图墙铺满整张卡且压在更上层（z-index），按钮只会被封面盖住；
// 悬停反馈改由卡片上浮 + 招牌色描边 + 拼图格缝散开来给，封面始终看得全。
//
// 点击（打开文件夹弹窗）不在卡片上挂 onClick：拖拽松手那一下浏览器也会补一个 click，
// 会把刚拖完的文件夹又开一遍 —— 点击统一由 GameGrid 的指针路径判定（位移没超过阈值 = 点击）
export default function GameFolderCard({
  folder, games, cellWidth, open = false, onContextMenu, onPointerDown,
  dragging, dropActive, animationDelay = 0, focused = false,
}: Props) {
  const t = useT();

  // 窄卡（列数拉到两位数）：拼图缩到看不清，只留两张
  const compact = cellWidth > 0 && cellWidth < 168;
  const maxTiles = compact ? 2 : TILE_MAX;

  // 超过 4 个游戏：摆 3 张封面，第 4 格换成 "+N"（N = 没摆下的那些）
  const overflow = !compact && games.length > maxTiles ? games.length - (maxTiles - 1) : 0;
  const tiles = useMemo(
    () => (overflow > 0 ? games.slice(0, maxTiles - 1) : games.slice(0, maxTiles)),
    [games, overflow, maxTiles],
  );
  const washPath = tiles[0]?.cover_path ?? '';
  const accent = useFolderAccent(washPath);
  const totalSeconds = useMemo(() => games.reduce((sum, g) => sum + (g.total_seconds || 0), 0), [games]);
  const tileCount = tiles.length + (overflow > 0 ? 1 : 0);

  return (
    <div
      data-folder-card={folder.id}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
      className={clsx(
        'folder-card',
        compact && 'compact',
        open && 'open',
        dragging && 'dragging',
        dropActive && 'drop-active',
        focused && 'gamepad-focus',
      )}
      style={{
        animationDelay: dragging ? undefined : `${animationDelay}ms`,
        // 招牌色：CSS 里所有 hsl(var(--fc) / x) 都从这一个变量派生
        ['--fc' as string]: accent,
      } as React.CSSProperties}
    >
      {/* 底纹：首作封面大幅模糊，垫在拼图后面当氛围色（从格缝里透出来）。
          自定义封面铺满整张卡，底纹被完全盖住，不必加载 */}
      {!folder.cover_path && washPath && (
        <CoverImg src={coverSrc(washPath)} alt="" className="folder-card-wash" aria-hidden="true" />
      )}
      <div className="folder-card-scrim" />

      {/* 自定义封面 / 拼图墙 / 落点 / 空态 */}
      {dropActive ? (
        <div className="folder-card-drop">
          <FolderDown size={26} />
          <span>{t('games.folderDropHint', { name: folder.name })}</span>
        </div>
      ) : folder.cover_path ? (
        <CoverImg src={coverSrc(folder.cover_path)} alt="" className="folder-card-cover" />
      ) : games.length === 0 ? (
        <div className="folder-card-empty">
          <FolderClosed size={30} />
          <span>{t('games.folderEmptyHint')}</span>
        </div>
      ) : (
        <div className="folder-card-mosaic" data-count={tileCount}>
          {tiles.map((game) => (
            <div key={game.id} className="folder-card-tile">
              {game.cover_path ? (
                <CoverImg src={coverSrc(game.cover_path)} alt={game.name} className="folder-card-face" />
              ) : (
                <span className="folder-card-face folder-card-face-blank" aria-label={game.name}>
                  <Gamepad2 size={18} />
                </span>
              )}
            </div>
          ))}
          {overflow > 0 && (
            <div className="folder-card-tile folder-card-tile-count">
              <span>{`+${overflow}`}</span>
            </div>
          )}
        </div>
      )}

      {/* 底部信息块 */}
      <div className="folder-card-meta">
        <span className="folder-card-eyebrow">{t('games.folderEyebrow')}</span>
        <div className="folder-card-title">
          <FolderClosed size={14} className="folder-card-glyph" />
          <span className="folder-card-name">{folder.name}</span>
        </div>
        <div className="folder-card-foot">
          <Clock size={11} />
          {totalSeconds > 0
            ? t('games.folderSummary', { n: games.length, time: formatDuration(totalSeconds) })
            : t('games.folderCountOnly', { n: games.length })}
        </div>
      </div>
    </div>
  );
}
