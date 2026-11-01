import { memo } from 'react';
import MusicView from '../views/MusicView';

// 后台保留首屏布局、图片节点和已绘制内容，实际切入时才播放行入场。
export default memo(function MusicSurface({ active }: { active: boolean }) {
  return (
    <div className="absolute inset-0 music-surface"
      data-music-hidden={active ? undefined : ''} inert={!active} aria-hidden={!active}>
      <MusicView active={active} />
    </div>
  );
});
