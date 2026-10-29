import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FolderInput, FolderClosed, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';
import { message } from '@tauri-apps/plugin-dialog';
import { useAppStore } from '../store';
import { useFocusIndex, useModalGamepad } from '../gamepad';
import { useT } from '../i18n';

interface Props {
  gameIds: string[];     // 要放进文件夹的游戏（单卡右键 = [id]）
  /** 当前所在文件夹（钻入态里右键）：列表里跳过它，不显示「放进自己已经在的文件夹」 */
  currentFolderId?: string | null;
  onClose: () => void;   // 放进去之后收起整个菜单
  /** 手柄强制展开（一级菜单里 A 激活本行时；鼠标走 hover 展开） */
  forcedOpen?: boolean;
  /** 手柄在二级菜单上按 B 时收起（焦点回一级菜单） */
  onForcedClose?: () => void;
  /** 一级菜单里本行的手柄焦点高亮 */
  focused?: boolean;
}

// 加入文件夹：悬浮展开的二级菜单（与 AddToPlaylistFlyout 同款交互 —— 往右展开、
// 留 8px 间距、贴右缘翻到左侧、离开留 150ms 缓冲）。点一下就放进去、无弹窗。
// 「新建文件夹」是一级菜单项，这里只列已有文件夹
export default function MoveToFolderFlyout({
  gameIds, currentFolderId, onClose, forcedOpen = false, onForcedClose, focused,
}: Props) {
  const t = useT();
  const folders = useAppStore((s) => s.gameFolders);
  const setGamesFolder = useAppStore((s) => s.setGamesFolder);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [flip, setFlip] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const isOpen = open || forcedOpen;

  const list = folders.filter((f) => f.id !== currentFolderId);

  // 展开时测量：贴右缘放不下就翻到左侧（间距 8 + 二级菜单宽 w-48(192)）
  useLayoutEffect(() => {
    if (!isOpen) return;
    const el = wrapperRef.current;
    if (!el) return;
    setFlip(el.getBoundingClientRect().right + 8 + 192 > window.innerWidth - 8);
  }, [isOpen]);

  // 手柄：方向选文件夹、A 放入、B 收起回一级菜单
  const flyoutFocused = useFocusIndex('menu:folder-flyout');
  useModalGamepad('menu:folder-flyout', {
    enabled: isOpen,
    onClose: () => { setOpen(false); onForcedClose?.(); },
    count: list.length,
    cols: 1,
    scrollIntoView: (i) => document.querySelector(`[data-flyout-folder="${i}"]`)?.scrollIntoView({ block: 'nearest' }),
    activate: (i) => void move(list[i]?.id),
  });

  const openSub = () => {
    if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
    setOpen(true);
  };
  const closeSub = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 150);
  };
  useEffect(() => () => { if (closeTimer.current !== null) window.clearTimeout(closeTimer.current); }, []);

  const move = async (folderId?: string) => {
    if (!folderId) return;
    try {
      await setGamesFolder(gameIds, folderId);
    } catch (err) {
      void message(t('games.folderMoveFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' });
    }
    onClose();
  };

  return (
    <div
      ref={wrapperRef}
      className="relative"
      onClick={(e) => e.stopPropagation()} // 点本行/文件夹列表都不触发 window click 收菜单（放完由 onClose 收）
      onMouseEnter={openSub}
      onMouseLeave={closeSub}
    >
      <button className={clsx('context-menu-item', focused && 'gamepad-focus')}>
        <FolderInput size={14} className="text-text-secondary" />
        {t('games.addToFolder')}
        <ChevronRight size={12} className="ml-auto text-text-tertiary" />
      </button>
      {isOpen && (
        <div className={`absolute top-0 ${flip ? 'right-full mr-2' : 'left-full ml-2'}`}>
          <div className="glass-card w-48 py-1.5 animate-scale-in">
            <div className="px-3 py-1.5 text-[11px] text-text-tertiary">{t('games.addToFolder')}</div>
            {list.length === 0 ? (
              <div className="px-3 py-2 text-xs text-text-tertiary">{t('games.noFolders')}</div>
            ) : (
              <div className="max-h-56 overflow-y-auto">
                {list.map((f, i) => (
                  <button
                    key={f.id}
                    data-flyout-folder={i}
                    onClick={() => void move(f.id)}
                    className={clsx('context-menu-item', flyoutFocused === i && 'gamepad-focus')}
                  >
                    <FolderClosed size={14} className="text-text-secondary" />
                    <span className="truncate flex-1 min-w-0 text-left">{f.name}</span>
                    <span className="text-[11px] text-text-tertiary tabular-nums shrink-0">{f.game_ids.length}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
