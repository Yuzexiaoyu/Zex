import { useState, useEffect, useCallback } from 'react';
import * as api from '../api';
import type { ProfileConfig, ProfileTargetInfo } from '../api';
import { X, Minus, Plus, Power, Download, Loader2, AlertTriangle, Gauge, Globe, Gamepad2 } from 'lucide-react';
import { message } from '@tauri-apps/plugin-dialog';
import { useModalGamepad } from '../gamepad';
import { useT } from '../i18n';

interface Props {
  onClose: () => void;
  /** 打开时选中哪个配置对象（game_id）。不传 = 全局 */
  initialTarget?: string;
}

// OSD 帧数颜色预设（RTSS BaseColor 的 0x00RRGGBB 值，高位 00 = 不透明）
const RTSS_COLORS = [
  { value: '00FF8000', labelKey: 'settings.rtssColorOrange' }, // RTSS 出厂默认色
  { value: '00FFFF00', labelKey: 'settings.rtssColorYellow' },
  { value: '0000FFFF', labelKey: 'settings.rtssColorCyan' },
  { value: '00FFFFFF', labelKey: 'settings.rtssColorWhite' },
  { value: '00FF0000', labelKey: 'settings.rtssColorRed' },
] as const;

// OSD 四角位置（后端 position 1..4，写盘时换算成 PositionX/Y 的正负坐标）
const OSD_POSITIONS = [
  { value: 1, labelKey: 'settings.rtssPosTopLeft' },
  { value: 2, labelKey: 'settings.rtssPosTopRight' },
  { value: 3, labelKey: 'settings.rtssPosBottomLeft' },
  { value: 4, labelKey: 'settings.rtssPosBottomRight' },
] as const;

// 限帧模式（RTSS SyncLimiter 0-3）。descKey 是各自的优劣说明，四种常驻全部列出
const FPS_MODES = [
  { value: 0, labelKey: 'settings.rtssModeAsync', descKey: 'settings.rtssModeAsyncDesc' },
  { value: 1, labelKey: 'settings.rtssModeFrontEdge', descKey: 'settings.rtssModeFrontEdgeDesc' },
  { value: 2, labelKey: 'settings.rtssModeBackEdge', descKey: 'settings.rtssModeBackEdgeDesc' },
  { value: 3, labelKey: 'settings.rtssModeReflex', descKey: 'settings.rtssModeReflexDesc' },
] as const;

// 应用检测级别（EnableHooking / HookDirectDraw / HookLoadLibrary 三键组合）
const DETECT_LEVELS = [
  { value: 0, labelKey: 'settings.rtssDetectNone' },
  { value: 1, labelKey: 'settings.rtssDetectLow' },
  { value: 2, labelKey: 'settings.rtssDetectMedium' },
  { value: 3, labelKey: 'settings.rtssDetectHigh' },
] as const;

/** 两份配置逐项相同。ProfileConfig 全是标量字段，逐键比较就够 */
function sameConfig(a: ProfileConfig, b: ProfileConfig) {
  return (Object.keys(a) as (keyof ProfileConfig)[]).every((k) => a[k] === b[k]);
}

// 下面这几个小组件必须放在模块作用域，不能写在组件体内：写在体内的话每次渲染
// 都是新的函数引用，React 视为不同类型 → 整棵子树卸载重建，帧率输入框会在
// 打第一个字符后立刻失焦
// 一行设置。grow shrink-0 是「动态填满」的关键：弹窗高度固定，列里多出来的竖向空间
// 由有 desc 的行平摊（内容居中），一屏永远刚好填满且不滚动；
// shrink-0 保证反过来内容超高时不会被压扁，退回滚动。
// 控件放不下时整组自己换到第二行去（仍然右对齐），而不是把左边的说明挤成一条竖线。
// 没有 desc 的行不参与分空间（只 shrink-0），给 48px 最小高度保证不挤、好点；
// 有提示的行才 grow，把剩余高度吃掉 —— 一行只有标签时行高紧凑但不过分扁
function Row({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div
      className={[
        'shrink-0 flex flex-wrap items-center justify-end gap-x-4 gap-y-1.5 px-5 border-t border-border-glass first:border-t-0',
        desc ? 'grow py-2.5' : 'min-h-12 py-1.5',
      ].join(' ')}
    >
      <div className="min-w-0 grow basis-40">
        <p className="text-sm font-medium leading-snug">{label}</p>
        {desc && <p className="text-xs text-text-secondary leading-snug">{desc}</p>}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5 shrink-0">{children}</div>
    </div>
  );
}

/** 选中项才有 active 态的一组按钮 */
function Chips<T>({ items, value, onPick }:
  { items: readonly { value: T; label: string }[]; value: T; onPick: (v: T) => void }) {
  return (
    <>
      {items.map((it) => (
        <button
          key={String(it.value)}
          className={['chip', value === it.value && 'active'].filter(Boolean).join(' ')}
          onClick={() => onPick(it.value)}
        >
          {it.label}
        </button>
      ))}
    </>
  );
}

/** 加减号步进（取值范围小的项用它；帧率上限那种要打具体数字的用输入框） */
function Stepper({ value, min, max, step, unit, onPick, width = 'w-12' }:
  { value: number; min: number; max: number; step: number; unit?: string; onPick: (v: number) => void; width?: string }) {
  return (
    <>
      <button className="chip" disabled={value <= min} onClick={() => onPick(Math.max(min, value - step))}>
        <Minus size={13} />
      </button>
      <span className={`text-sm font-semibold ${width} text-center`}>{value}{unit ? ` ${unit}` : ''}</span>
      <button className="chip" disabled={value >= max} onClick={() => onPick(Math.min(max, value + step))}>
        <Plus size={13} />
      </button>
    </>
  );
}

/** 开 / 关两个 chip。t 从外面传进来 —— 模块作用域里调不了 useT */
function Toggle({ value, t, onPick }:
  { value: boolean; t: (k: string) => string; onPick: (v: boolean) => void }) {
  return (
    <Chips
      items={[
        { value: false, label: t('common.off') },
        { value: true, label: t('common.on') },
      ]}
      value={value}
      onPick={onPick}
    />
  );
}

/** 左栏的一个配置对象。右边那个位子平时挂「单独设置」角标，选中时换成这个对象的恢复按钮
    —— 两者宽度相近且互斥，行高不会因为按钮出现而变 */
function TargetItem({ active, icon, label, badge, action, onClick }: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  badge?: string;
  action?: { label: string; run: () => void };
  onClick: () => void;
}) {
  return (
    <div
      className={[
        'flex items-center gap-1 pl-3 pr-2 rounded-lg border transition-all',
        active
          ? 'bg-[rgba(0,212,255,0.12)] border-[rgba(0,212,255,0.28)] text-[#00d4ff]'
          : 'border-transparent text-text-secondary hover:bg-bg-surface-active hover:text-text-primary',
      ].join(' ')}
    >
      <button
        onClick={onClick}
        title={label}
        className="flex-1 min-w-0 flex items-center gap-2.5 py-2 text-left text-inherit"
      >
        <span className="shrink-0 opacity-80">{icon}</span>
        <span className="flex-1 min-w-0 truncate text-sm">{label}</span>
      </button>
      {action ? (
        <button
          onClick={action.run}
          title={action.label}
          className="shrink-0 text-[11px] leading-none px-2 py-1.5 rounded-full bg-[rgba(0,212,255,0.16)] border border-[rgba(0,212,255,0.34)] text-[#00d4ff] hover:bg-[rgba(0,212,255,0.26)] transition-colors"
        >
          {action.label}
        </button>
      ) : badge ? (
        <span className="shrink-0 text-[10px] leading-none px-1.5 py-1 rounded-full bg-[rgba(0,212,255,0.14)] border border-[rgba(0,212,255,0.3)] text-[#00d4ff]">
          {badge}
        </span>
      ) : null}
    </div>
  );
}

/** 帧数显示（OSD）+ 锁帧设置面板。配置对象 = 全局 或 单个游戏，语义与 RTSS 一致 */
export default function FpsSettingsModal({ onClose, initialTarget }: Props) {
  const t = useT();
  // 弹窗期间手柄按键不穿透到背后视图（B/Esc 关闭，表单内容用鼠标操作）
  useModalGamepad('modal:fps-settings', { onClose });

  const [rtss, setRtss] = useState<{ installed: boolean; running: boolean }>({ installed: false, running: false });
  const [launchingRtss, setLaunchingRtss] = useState(false);

  const [targets, setTargets] = useState<ProfileTargetInfo[]>([]);
  const [targetId, setTargetId] = useState(initialTarget ?? api.RTSS_GLOBAL);
  const [cfg, setCfg] = useState<ProfileConfig | null>(null);
  // 出厂默认那一份。只用来判断当前值有没有被改过 —— 一致就不给「恢复默认」按钮
  const [defaults, setDefaults] = useState<ProfileConfig | null>(null);

  const current = targets.find((x) => x.id === targetId);
  const isGlobal = targetId === api.RTSS_GLOBAL;
  // 跟随全局 = 这个游戏还没有自己的 profile 文件。此时下面显示的是全局的值，只读
  const inherited = !isGlobal && current !== undefined && !current.has_own_profile;
  // 两边都读到了、且真有差异才算「改过」。默认状态下按钮没有意义，藏起来
  const changed = cfg !== null && defaults !== null && !sameConfig(cfg, defaults);

  const fail = useCallback(
    (err: unknown) => {
      const msg = typeof err === 'string' ? err : ((err as Error)?.message ?? String(err));
      void message(t('common.saveFailed', { msg }), { title: t('common.error'), kind: 'error' });
    },
    [t],
  );

  const reloadTargets = useCallback(async () => {
    try {
      setTargets(await api.rtssListTargets());
    } catch {
      /* RTSS 缺失时列表为空，状态行已经提示了 */
    }
  }, []);

  useEffect(() => {
    api.rtssStatus().then((s) => setRtss({ installed: s.installed, running: s.running })).catch(() => {});
    api.rtssDefaultProfile().then(setDefaults).catch(() => {});
    void reloadTargets();
  }, [reloadTargets]);

  // 切换配置对象就整份重读（profile 文件是唯一真相，没有本地缓存要同步）。
  // 只依赖 targetId：targets 刷新不该触发重读，否则刚落盘的改动会被这次异步读回来的
  // 旧值盖掉。真正需要重读的只有「恢复跟随全局」，那里显式读一次
  useEffect(() => {
    let alive = true;
    api
      .rtssReadProfile(targetId)
      .then((c) => { if (alive) setCfg(c); })
      .catch(() => { if (alive) setCfg(null); });
    return () => { alive = false; };
  }, [targetId]);

  /** 改一项就落盘一次。跟随全局的游戏在这一下自动转成单独设置 —— 写盘本身就是建 profile */
  const patch = (next: Partial<ProfileConfig>) => {
    if (!cfg) return;
    const becomesOwn = inherited;
    const merged = { ...cfg, ...next };
    setCfg(merged);
    api
      .rtssWriteProfile(targetId, merged)
      .then(() => (becomesOwn ? reloadTargets() : undefined))
      .catch(fail);
  };

  const backToGlobal = async () => {
    try {
      await api.rtssClearProfile(targetId);
      await reloadTargets();
      // profile 没了，显示的值要换回全局那份
      setCfg(await api.rtssReadProfile(targetId));
    } catch (e) {
      fail(e);
    }
  };

  /** 恢复默认：出厂那份配置当一次普通改动写下去（按钮只在有改动时才出现） */
  const resetDefaults = () => {
    if (defaults) patch(defaults);
  };

  const launchRtss = async () => {
    setLaunchingRtss(true);
    try {
      const s = await api.rtssLaunch();
      setRtss({ installed: s.installed, running: s.running });
      if (s.installed && !s.running) {
        void message(t('settings.rtssStartFailed', { msg: '' }), { title: t('common.error'), kind: 'error' });
      }
    } catch (e: any) {
      void message(t('settings.rtssStartFailed', { msg: typeof e === 'string' ? e : (e?.message ?? String(e)) }), {
        title: t('common.error'),
        kind: 'error',
      });
    } finally {
      setLaunchingRtss(false);
    }
  };

  // 帧率上限用手动输入：步进 10 的话 165 这种数很难点到。
  // 输入过程中允许空串和越界（否则打不出多位数），失焦时才钳制回合法值
  const [limitDraft, setLimitDraft] = useState('');
  useEffect(() => { setLimitDraft(cfg ? String(cfg.framerate_limit) : ''); }, [cfg?.framerate_limit, targetId]);
  const commitLimit = () => {
    const n = Math.min(1000, Math.max(1, Number(limitDraft) || 0));
    setLimitDraft(String(n));
    if (cfg && n !== cfg.framerate_limit) patch({ framerate_limit: n });
  };

  const games = targets.filter((x) => x.id !== api.RTSS_GLOBAL);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      {/* 高度写死：右两列靠行的 grow 平摊竖向空间来填满，没有确定高度就没东西可分。
          min() 是给 2K/4K 屏封顶，否则 88vh 会把每行拉得过高 */}
      <div
        className="glass-modal solid-modal w-[1280px] max-w-[95vw] h-[min(88vh,920px)] flex flex-col shadow-2xl animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-glass bg-[rgba(0,212,255,0.05)] shrink-0">
          <div className="flex items-center gap-3">
            <span className="w-9 h-9 rounded-xl bg-[rgba(0,212,255,0.12)] border border-[rgba(0,212,255,0.22)] flex items-center justify-center shrink-0">
              <Gauge size={17} className="text-[#00d4ff]" />
            </span>
            <div>
              <p className="text-sm font-semibold text-text-primary">{t('settings.rtssModalTitle')}</p>
              <p className="mt-0.5 text-xs text-text-secondary">{t('settings.rtssModalDesc')}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-xl flex items-center justify-center text-text-secondary hover:text-white hover:bg-bg-surface-active transition-all shrink-0"
            title={t('common.close')}
          >
            <X size={18} />
          </button>
        </div>

        {/* min-h-0：不加的话 flex 子项的最小高度是内容高度，右栏撑破弹窗而不是内部滚动 */}
        <div className="flex-1 flex min-h-0">
          {/* 左栏：配置对象。每项自带自己的恢复按钮（全局=恢复默认，游戏=恢复跟随全局），
              设置区那边就不用再留一条提示栏，两列设置能多占一屏的高度 */}
          <aside className="w-[272px] shrink-0 border-r border-border-glass flex flex-col min-h-0">
            <p className="px-5 pt-4 pb-2 text-xs font-semibold text-text-tertiary uppercase tracking-widest">
              {t('settings.rtssTarget')}
            </p>
            <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-0.5">
              <TargetItem
                active={isGlobal}
                icon={<Globe size={15} />}
                label={t('settings.rtssTargetGlobal')}
                action={isGlobal && changed ? { label: t('settings.rtssResetDefaults'), run: resetDefaults } : undefined}
                onClick={() => setTargetId(api.RTSS_GLOBAL)}
              />
              {games.length > 0 && (
                <p className="px-3 pt-4 pb-1.5 text-[11px] font-semibold text-text-tertiary uppercase tracking-widest">
                  {t('settings.rtssTargetGames')}
                </p>
              )}
              {games.map((x) => (
                <TargetItem
                  key={x.id}
                  active={x.id === targetId}
                  icon={<Gamepad2 size={15} />}
                  label={x.name}
                  badge={x.has_own_profile ? t('settings.rtssOwnProfile') : undefined}
                  action={
                    x.id === targetId && x.has_own_profile
                      ? { label: t('settings.rtssBackToGlobal'), run: () => void backToGlobal() }
                      : undefined
                  }
                  onClick={() => setTargetId(x.id)}
                />
              ))}
            </div>

            {/* 栏底：RTSS 运行状态（属于整个 RTSS，不属于某个配置对象） */}
            <div className="shrink-0 border-t border-border-glass px-5 py-3">
              <p className="text-[11px] text-text-tertiary mb-1.5">{t('settings.rtssStatus')}</p>
              {rtss.installed ? (
                <button
                  className="btn btn-glass gap-2 text-sm w-full"
                  onClick={() => void launchRtss()}
                  disabled={launchingRtss}
                >
                  {launchingRtss ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
                  {rtss.running ? t('settings.rtssRunning') : t('settings.rtssLaunchBtn')}
                </button>
              ) : (
                <>
                  <p className="mb-2 flex items-start gap-2 text-xs text-[#ffc94d] leading-snug">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                    {t('settings.rtssNotInstalled')}
                  </p>
                  <button
                    className="btn btn-glass gap-2 text-sm w-full"
                    onClick={() => void api.rtssOpenDownloadPage().catch(() => {})}
                  >
                    <Download size={14} />
                    {t('settings.rtssDownloadPage')}
                  </button>
                </>
              )}
            </div>
          </aside>

          {/* 右侧两列：中栏帧数显示、右栏锁帧 + 兼容性。两列都是竖向 flex，行用 grow 把
              剩余高度平摊掉 —— 内容自动填满一屏，不留空白也不滚动。
              overflow-y-auto 只是极矮屏幕的兜底 */}
          {cfg && (
            <div className="flex-1 min-w-0 flex min-h-0">
              {/* 中栏：帧数显示（OSD） */}
              <div className="flex-1 min-w-0 flex flex-col overflow-y-auto">
                <Row label={t('settings.rtssOsd')}>
                  <Toggle t={t} value={cfg.enabled} onPick={(v) => patch({ enabled: v })} />
                </Row>
                <Row label={t('settings.rtssOsdPosition')}>
                  <Chips
                    items={OSD_POSITIONS.map((p) => ({ value: p.value, label: t(p.labelKey) }))}
                    value={cfg.position}
                    onPick={(v) => patch({ position: v })}
                  />
                </Row>
                <Row label={t('settings.rtssOsdZoom')}>
                  <Stepper value={cfg.zoom} min={1} max={8} step={1} unit="倍" width="w-10" onPick={(v) => patch({ zoom: v })} />
                </Row>
                <Row label={t('settings.rtssOsdColor')}>
                  {RTSS_COLORS.map((c) => (
                    <button
                      key={c.value}
                      className={['chip', cfg.color === c.value && 'active'].filter(Boolean).join(' ')}
                      onClick={() => patch({ color: c.value })}
                    >
                      <span className="inline-block w-3 h-3 rounded-full mr-1.5 align-middle" style={{ backgroundColor: `#${c.value.slice(2)}` }} />
                      {t(c.labelKey)}
                    </button>
                  ))}
                </Row>
                <Row label={t('settings.rtssOsdFill')} desc={t('settings.rtssOsdFillDesc')}>
                  <Chips
                    items={[
                      { value: 0, label: t('settings.rtssFillOff') },
                      { value: 1, label: t('settings.rtssFillLight') },
                      { value: 2, label: t('settings.rtssFillHeavy') },
                    ]}
                    value={cfg.fill}
                    onPick={(v) => patch({ fill: v })}
                  />
                </Row>
                <Row label={t('settings.rtssOsdRefresh')} desc={t('settings.rtssOsdRefreshDesc')}>
                  <Stepper value={cfg.refresh_period} min={100} max={1000} step={100} unit="ms" width="w-14" onPick={(v) => patch({ refresh_period: v })} />
                </Row>
                <Row label={t('settings.rtssOsdPrecision')}>
                  <Chips
                    items={[
                      { value: true, label: t('settings.rtssPrecisionInt') },
                      { value: false, label: t('settings.rtssPrecisionDecimal') },
                    ]}
                    value={cfg.integer_framerate}
                    onPick={(v) => patch({ integer_framerate: v })}
                  />
                </Row>
                <Row label={t('settings.rtssOsdSpace')} desc={t('settings.rtssOsdSpaceDesc')}>
                  <Chips
                    items={[
                      { value: 0, label: t('settings.rtssSpaceViewport') },
                      { value: 1, label: t('settings.rtssSpaceFramebuffer') },
                    ]}
                    value={cfg.coordinate_space}
                    onPick={(v) => patch({ coordinate_space: v })}
                  />
                </Row>
                <Row label={t('settings.rtssOsdGraph')} desc={t('settings.rtssOsdGraphDesc')}>
                  <Toggle t={t} value={cfg.graph_enabled} onPick={(v) => patch({ graph_enabled: v })} />
                </Row>
                {cfg.graph_enabled && (
                  <>
                    <Row label={t('settings.rtssOsdGraphStyle')} desc={t('settings.rtssOsdGraphStyleDesc')}>
                      <Chips
                        items={[
                          { value: 0, label: t('settings.rtssGraphLine') },
                          { value: 1, label: t('settings.rtssGraphBar') },
                        ]}
                        value={cfg.graph_style}
                        onPick={(v) => patch({ graph_style: v })}
                      />
                    </Row>
                    <Row label={t('settings.rtssOsdGraphWidth')} desc={t('settings.rtssOsdGraphWidthDesc')}>
                      <Stepper value={cfg.graph_width} min={8} max={48} step={4} width="w-10" onPick={(v) => patch({ graph_width: v })} />
                    </Row>
                    <Row label={t('settings.rtssOsdGraphMax')} desc={t('settings.rtssOsdGraphMaxDesc')}>
                      <Stepper value={cfg.graph_max} min={10} max={200} step={10} unit="ms" width="w-14" onPick={(v) => patch({ graph_max: v })} />
                    </Row>
                  </>
                )}
              </div>

              {/* 右栏：锁帧 + 兼容性 */}
              <div className="flex-1 min-w-0 flex flex-col overflow-y-auto border-l border-border-glass">
                <Row label={t('settings.rtssFramerate')} desc={t('settings.rtssFramerateDesc')}>
                  <Toggle t={t} value={cfg.framerate_enabled} onPick={(v) => patch({ framerate_enabled: v })} />
                </Row>
                <Row label={t('settings.rtssFramerateLimit')}>
                  <input
                    className="input input-num text-sm"
                    type="text"
                    inputMode="numeric"
                    value={limitDraft}
                    onChange={(e) => setLimitDraft(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    onBlur={commitLimit}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  />
                </Row>
                <Row label={t('settings.rtssFramerateMode')}>
                  <Chips
                    items={FPS_MODES.map((m) => ({ value: m.value, label: t(m.labelKey) }))}
                    value={cfg.framerate_mode}
                    onPick={(v) => patch({ framerate_mode: v })}
                  />
                </Row>
                {/* 四种限帧模式的说明常驻全部摆出，选中的那条模式名高亮 */}
                <div className="shrink-0 px-5 pb-2">
                  <div className="rounded-lg border border-border-glass bg-[rgba(255,255,255,0.03)] px-3 py-2 space-y-1.5">
                    {FPS_MODES.map((m) => (
                      <p key={m.value} className="text-xs leading-snug text-text-secondary">
                        <span
                          className={[
                            'font-medium',
                            m.value === cfg.framerate_mode ? 'text-[#00d4ff]' : 'text-text-primary',
                          ].join(' ')}
                        >
                          {t(m.labelKey)}
                        </span>
                        <span className="text-text-tertiary px-1.5">—</span>
                        {t(m.descKey)}
                      </p>
                    ))}
                  </div>
                </div>
                <Row label={t('settings.rtssWait')} desc={t('settings.rtssWaitDesc')}>
                  <Chips
                    items={[
                      { value: true, label: t('settings.rtssWaitPassive') },
                      { value: false, label: t('settings.rtssWaitActive') },
                    ]}
                    value={cfg.passive_wait}
                    onPick={(v) => patch({ passive_wait: v })}
                  />
                </Row>
                <Row label={t('settings.rtssReflexMarker')} desc={t('settings.rtssReflexMarkerDesc')}>
                  <Toggle t={t} value={cfg.reflex_marker} onPick={(v) => patch({ reflex_marker: v })} />
                </Row>
                {cfg.framerate_mode === 3 && (
                  <Row label={t('settings.rtssReflexSleep')} desc={t('settings.rtssReflexSleepDesc')}>
                    <Chips
                      items={[
                        { value: 0, label: t('settings.rtssSleepAuto') },
                        { value: 1, label: t('settings.rtssSleepBefore') },
                        { value: 2, label: t('settings.rtssSleepAfter') },
                      ]}
                      value={cfg.reflex_sleep}
                      onPick={(v) => patch({ reflex_sleep: v })}
                    />
                  </Row>
                )}

                {/* 兼容性四行挂在锁帧下面共用右栏。必须和上面的行同级，
                    套一层 div 的话它们分不到这一列的剩余高度 */}
                <Row label={t('settings.rtssDetection')} desc={t('settings.rtssDetectionDesc')}>
                  <Chips
                    items={DETECT_LEVELS.map((d) => ({ value: d.value, label: t(d.labelKey) }))}
                    value={cfg.detection_level}
                    onPick={(v) => patch({ detection_level: v })}
                  />
                </Row>
                <Row label={t('settings.rtssDynamicOffset')} desc={t('settings.rtssDynamicOffsetDesc')}>
                  <Toggle t={t} value={cfg.dynamic_offset} onPick={(v) => patch({ dynamic_offset: v })} />
                </Row>
                <Row label={t('settings.rtssDetours')} desc={t('settings.rtssDetoursDesc')}>
                  <Toggle t={t} value={cfg.use_detours} onPick={(v) => patch({ use_detours: v })} />
                </Row>
                <Row label={t('settings.rtssInjectionDelay')} desc={t('settings.rtssInjectionDelayDesc')}>
                  <Stepper value={cfg.injection_delay} min={0} max={60000} step={5000} unit="ms" width="w-16" onPick={(v) => patch({ injection_delay: v })} />
                </Row>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
