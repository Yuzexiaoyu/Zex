import StatsView from '../views/StatsView';

// 用透明的常驻合成层保存首屏，避免 visibility:hidden 在切入时才首次绘制内容。
// inert 同时关闭隐藏页面的焦点和交互，不影响布局、图片解码与后台预渲染。
export default function StatsSurface({ active }: { active: boolean }) {
  return (
    <div
      className="absolute inset-0 stats-surface"
      data-stats-hidden={active ? undefined : ''}
      inert={!active}
      aria-hidden={!active}
    >
      <StatsView active={active} />
    </div>
  );
}
