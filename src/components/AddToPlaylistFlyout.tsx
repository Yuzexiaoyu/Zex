import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ListMusic, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';
import { message } from '@tauri-apps/plugin-dialog';
import { useAppStore } from '../store';
import { useFocusIndex, useModalGamepad } from '../gamepad';
import { useT } from '../i18n';

interface Props {
  trackIds: string[];   // 要加入歌单的曲目（单曲右键 = [id]，多选右键 = 选中集）
  onClose: () => void;  // 添加完成后收起整个菜单
  /** 手柄强制展开（菜单里 A 激活「添加到歌单」时；鼠标走 hover 展开） */
  forcedOpen?: boolean;
  /** 手柄在二级菜单上按 B 时收起（焦点回一级菜单） */
  onForcedClose?: () => void;
  /** 一级菜单里「添加到歌单」行的手柄焦点高亮 */
  focused?: boolean;
}

// 添加到歌单：悬浮展开的二级菜单（往右展开、与一级菜单留一段间距），点歌单即添加、无弹窗；
// 二级菜单不含「新建歌单」；贴右缘放不下就翻到左侧
export default function AddToPlaylistFlyout({ trackIds, onClose, forcedOpen = false, onForcedClose, focused }: Props) {
  const t = useT();
  const playlists = useAppStore((s) => s.playlists);
  const addTracksToPlaylist = useAppStore((s) => s.addTracksToPlaylist);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [flip, setFlip] = useState(false);
  const closeTimer = useRef<number | null>(null);
  // hover 与手柄强制展开任一为真即显示（鼠标路径与手柄路径互不干扰）
  const isOpen = open || forcedOpen;

  // 二级菜单展开时测量：贴右缘放不下就翻到左侧（right-full）；间距 8 + 二级菜单宽 w-48(192)
  useLayoutEffect(() => {
    if (!isOpen) return;
    const el = wrapperRef.current;
    if (!el) return;
    setFlip(el.getBoundingClientRect().right + 8 + 192 > window.innerWidth - 8);
  }, [isOpen]);

  // 手柄完整操作：方向选歌单、A 添加、B 收起回一级菜单（B 在 hover 路径下等价收起二级菜单）
  const flyoutFocused = useFocusIndex('menu:playlist-flyout');
  useModalGamepad('menu:playlist-flyout', {
    enabled: isOpen,
    onClose: () => { setOpen(false); onForcedClose?.(); },
    count: playlists.length,
    cols: 1,
    scrollIntoView: (i) => document.querySelector(`[data-flyout-pl="${i}"]`)?.scrollIntoView({ block: 'nearest' }),
    activate: (i) => void add(playlists[i].id),
  });

  // 悬停离开不立即关：留 150ms 缓冲，鼠标跨过与一级菜单的间距进入二级菜单时先取消计时
  const openSub = () => {
    if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
    setOpen(true);
  };
  const closeSub = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 150);
  };
  useEffect(() => () => { if (closeTimer.current !== null) window.clearTimeout(closeTimer.current); }, []);

  // 添加成功/重复都不弹提示，失败才报错
  const add = async (plId: string) => {
    try {
      await addTracksToPlaylist(plId, trackIds);
    } catch (err) {
      void message(t('music.addToPlaylistFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' });
    }
    onClose();
  };

  return (
    <div
      ref={wrapperRef}
      className="relative"
      onClick={(e) => e.stopPropagation()} // 点这行/歌单列表都不触发 window click 收起菜单（添加完由 onClose 收）
      onMouseEnter={openSub}
      onMouseLeave={closeSub}
    >
      <button className={clsx('context-menu-item', focused && 'gamepad-focus')}>
        <ListMusic size={14} className="text-text-secondary" />
        {t('music.addToPlaylist')}
        <ChevronRight size={12} className="ml-auto text-text-tertiary" />
      </button>
      {isOpen && (
        <div className={`absolute top-0 ${flip ? 'right-full mr-2' : 'left-full ml-2'}`}>
          <div className="glass-card w-48 py-1.5 animate-scale-in">
            <div className="px-3 py-1.5 text-[11px] text-text-tertiary">
              {trackIds.length > 1 ? t('music.addToPlaylistCount', { n: trackIds.length }) : t('music.addToPlaylist')}
            </div>
            {playlists.length === 0 ? (
              <div className="px-3 py-2 text-xs text-text-tertiary">{t('music.noPlaylists')}</div>
            ) : (
              <div className="max-h-56 overflow-y-auto">
                {playlists.map((p, i) => (
                  <button
                    key={p.id}
                    data-flyout-pl={i}
                    onClick={() => void add(p.id)}
                    className={clsx('context-menu-item', flyoutFocused === i && 'gamepad-focus')}
                  >
                    <ListMusic size={14} className="text-text-secondary" />
                    <span className="truncate flex-1 min-w-0 text-left">{p.name}</span>
                    <span className="text-[11px] text-text-tertiary tabular-nums shrink-0">{p.track_ids.length}</span>
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
