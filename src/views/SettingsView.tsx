import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Sun, Moon, Monitor, MonitorPlay, FolderOpen, Download, Upload, ExternalLink as ExternalIcon, KeyRound, Trash2, Loader2, Minus, Plus, Cpu, AlertTriangle, Gamepad2, X, Power, Image as ImageIcon, Languages } from 'lucide-react';
import zexLogo from '../assets/zex-logo.png';
import { coverSrc } from '../utils/media';
import { clsx } from 'clsx';
import * as api from '../api';
import { message, save, open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useAppStore, MIN_GAME_COLUMNS, MAX_GAME_COLUMNS } from '../store';
import { useLang, useT, setLang, LANGUAGES } from '../i18n';
import { setGamepadEnabled, isGamepadEnabled, useGamepadGroup, useFocusIndex, useRightStickScrollIf, useFocusStore, useModalGamepad, getConnectedPads, onConnectedChange, useInputMode } from '../gamepad';
import type { ConnectedPad } from '../gamepad';

// ─────────────────────────────────────────────
// 三列布局：列 = 网格里的 3 个竖排，每列 3 张卡。结构仿 StatsView 的
// 「每列一个手柄组 + 左右键跳列」。
// 竖向留空是一套动态节奏：整页只有一个 --sr-py 在动（见下面的 useSettingsRhythm
// 与 index.css 的留空系统），行永远不参与拉伸；列内余量按各卡自然高比例分给卡片，
// 三列都铺到容器底沿。窗口矮到节奏收满还装不下，才退回列内滚动。
// ─────────────────────────────────────────────

/** 三种列（阅读顺序，与渲染顺序一致） */
type ColKey = 'appearance' | 'startup' | 'covers';

/** 一行设置。label/desc + children 是标准行（标签左控件右）；
 *  render 是自定义块行（引擎、API Key、补封面、播放器路径）。
 *  chips 是手柄左右切换的逻辑，children 是它的可见形态 —— 两处同步维护 */
interface SettingRow {
  label?: React.ReactNode;
  desc?: string;
  /** 左右键循环切换的一组 chip（手柄 horizontal 消费） */
  chips?: { active: () => boolean; set: () => void }[];
  /** 左右键增减（如游戏库列数） */
  onLeftRight?: (dir: 'left' | 'right') => void;
  onA?: () => void;
  /** 行尾控件 */
  children?: React.ReactNode;
  /** 自定义块行：代替标准标签布局 */
  render?: () => React.ReactNode;
}

interface SettingsCard {
  titleKey: string;
  rows: SettingRow[];
  /** 卡内非焦点尾巴（连接状态、说明行、关于内容），渲染在行列表末尾 */
  tail?: React.ReactNode;
}

// ── 动态留空 ──
// 整页竖向留空只有一个源头：--sr-py（行上下内边距），卡标题、卡间距、块行内部
// 间距都在 CSS 里按比例派生（见 index.css 的「留空系统」）。这里两段式：
//   ① 按「各列内容量 vs 可用高度」实测反解出全局 --sr-py（最挤那列说了算），
//      三列共用同一个值 —— 同一种行在任何卡、任何列里高度都相同；
//   ② 每列剩下的余量按各卡自然高比例分给 flex-grow（整列等比放大），列底沿贴住容器底。
// 行永远不参与拉伸。
const SR_PY_MIN = 9;
const SR_PY_MAX = 18;

/** 一列的实测：各卡自然高、卡间距占用、列可用高。
 *  不能用 scrollHeight：它至少等于容器高，内容没占满时永远量成「刚好装满」 */
function measureCol(col: Element) {
  const cards = Array.from(col.children) as HTMLElement[];
  const heights = cards.map((c) => c.getBoundingClientRect().height);
  const gap = parseFloat(getComputedStyle(col).rowGap) || 0;
  const need = heights.reduce((a, b) => a + b, 0) + gap * Math.max(0, cards.length - 1);
  return { cards, heights, need, avail: (col as HTMLElement).clientHeight };
}

/** ① 实测两次（下限/上限各一次）拿到「超出量 ↔ --sr-py」的两个点，线性反解出三列都
 *  刚好装得下的最大留空 —— 竖向留空对高度是仿射的（横向内边距不动 → 文字换行不受
 *  影响），两点定线即精确。装不下就收到下限，收到下限还装不下由列自己滚动。
 *  ② 再把每列剩下的余量按卡自然高比例分给 flex-grow，把列铺到底 */
function useSettingsRhythm(
  pageRef: React.RefObject<HTMLDivElement | null>,
  colsRef: React.RefObject<HTMLDivElement | null>,
  sig: string,
) {
  useLayoutEffect(() => {
    const page = pageRef.current;
    const cols = colsRef.current;
    if (!page || !cols) return;
    const setPy = (v: number) => page.style.setProperty('--sr-py', `${v}px`);

    let lastW = -1;
    let lastH = -1;
    const measure = () => {
      // 设置页在后台是 visibility:hidden（不是 display:none），所以启动时就量得到；
      // 真量不到（还没插进文档）就等 RO 再来
      if (cols.clientHeight <= 0 || cols.children.length === 0) return;
      lastW = cols.clientWidth;
      lastH = cols.clientHeight;
      const colEls = Array.from(cols.children) as HTMLElement[];
      // 量自然高之前先撤销上一轮的拉伸，否则量到的是「已经铺满」的假高度
      const cards = colEls.flatMap((c) => Array.from(c.children) as HTMLElement[]);
      cards.forEach((c) => { c.style.flexGrow = '0'; });

      // ① 全局节奏：可用高不能统一取容器高 —— 2 列/1 列降级时第三列换行，
      //    列高由 grid 行高决定（也随内容变），所以每列各自实测
      const overflowAt = (v: number) => {
        setPy(v);
        return colEls.map((c) => { const m = measureCol(c); return m.need - m.avail; });
      };
      const lo = overflowAt(SR_PY_MIN);
      const hi = overflowAt(SR_PY_MAX);
      let py = SR_PY_MAX;
      hi.forEach((over, i) => {
        if (over <= 0) return;                       // 上限也装得下，这列不设限
        if (lo[i] >= 0) { py = SR_PY_MIN; return; }  // 下限都装不下 → 收到底，剩下靠滚动
        py = Math.min(py, SR_PY_MIN + (SR_PY_MAX - SR_PY_MIN) * (-lo[i] / (over - lo[i])));
      });
      setPy(Math.round(Math.max(SR_PY_MIN, Math.min(SR_PY_MAX, py)) * 100) / 100);

      // ② 铺到底：余量按各卡自然高比例分配（grow 因子 = 自然高 → 整列等比放大）
      for (const col of colEls) {
        const m = measureCol(col);
        const slack = m.avail - m.need;
        m.cards.forEach((card, i) => {
          card.style.flexGrow = slack > 0.5 ? String(Math.max(1, Math.round(m.heights[i]))) : '0';
        });
      }
    };

    measure();
    // 容器尺寸变化就重量：窗口缩放、播放条出现/消失。回调里同步量完写完 —— RO 回调
    // 在绘制前执行，同一帧就是最终版式，不留「先渲一帧没拉伸的」空档。
    // 量的时候改的是子元素高度，容器自身高度由 flex 决定，不会反过来触发 RO 死循环
    const ro = new ResizeObserver(() => {
      if (cols.clientWidth === lastW && cols.clientHeight === lastH) return; // 尺寸没变不白干
      measure();
    });
    ro.observe(cols);
    return () => ro.disconnect();
  }, [pageRef, colsRef, sig]);
}

/** 一行设置。高度只由内容决定 —— 竖向留空全部来自 --sr-py，不 grow、不吸收
 *  列内剩余空间，所以同一种行在任何卡、任何列里都一样高 */
function SettingRow({ row, focused, index }: { row: SettingRow; focused: boolean; index: number }) {
  return (
    <div
      className={clsx('set-row', row.render && 'set-row-block', focused && 'settings-row-focus')}
      data-settings-row={index}
    >
      {row.render ? row.render() : (
        <>
          <div className="set-row-text">
            <p className="set-row-label">{row.label}</p>
            {row.desc && <p className="set-row-desc">{row.desc}</p>}
          </div>
          <div className="set-row-ctl">{row.children}</div>
        </>
      )}
    </div>
  );
}

// 每列上次手柄焦点（模块级：跨列跳转回来恢复，与 StatsView 的 colIdx 同款）
const colIdx: Record<ColKey, number> = { appearance: 0, startup: 0, covers: 0 };
const COL_ORDER: ColKey[] = ['appearance', 'startup', 'covers'];

/** 关于页外链：Tauri 会拦截 <a target="_blank"> 的新窗口导航（点击无反应），
 *  改走 opener 插件用系统默认浏览器打开（capability 已授权 opener:default，
 *  与后端 RTSS 官方页同款模式） */
function AboutLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        openUrl(href).catch((err: any) => console.error('openUrl failed:', err));
      }}
      className="inline-flex items-center gap-2 text-sm text-[#00d4ff]/70 hover:text-[#00d4ff] transition-colors"
    >
      <ExternalIcon size={14} />
      {label}
    </a>
  );
}

/** 一列设置：列容器 + 手柄组 + 右摇杆绑定 + 卡列表。
 *  行编号 = 卡片行数前缀和（与数组同源，条件行只影响本列局部编号，无全局偏移） */
function SettingsColumn({ colKey, cards, allCards, blurGuards }: {
  colKey: ColKey;
  cards: SettingsCard[];
  allCards: Record<ColKey, SettingsCard[]>;
  /** 焦点行移走时要强制 blur 的输入框（手柄 A 聚焦后移走，键盘不能继续打进旧输入框） */
  blurGuards?: { index: number; ref: React.RefObject<HTMLInputElement | null> }[];
}) {
  const t = useT();
  const group = `settings:col:${colKey}`;
  const focusedIndex = useFocusIndex(group);
  const rows = cards.flatMap((c) => c.rows);
  const colRef = useRef<HTMLDivElement>(null);
  // 右摇杆只滚当前焦点列：本列是焦点栈顶时注册为滚动目标，跨列后自动撤销
  const isTopGroup = useFocusStore((s) => s.stack[s.stack.length - 1]?.group === group);
  useRightStickScrollIf(colRef, isTopGroup);

  // 跳到相邻列，焦点落在该列上次的位置
  const jumpCol = (dir: 1 | -1) => {
    const n = (COL_ORDER.indexOf(colKey) + dir + COL_ORDER.length) % COL_ORDER.length;
    const nk = COL_ORDER[n];
    const targetRows = allCards[nk].flatMap((c) => c.rows);
    useFocusStore.getState().switchTo(`settings:col:${nk}`, Math.min(colIdx[nk], targetRows.length - 1));
  };

  useGamepadGroup(group, {
    count: rows.length,
    cols: 1,
    scrollIntoView: (i) => {
      colIdx[colKey] = i;
      colRef.current?.querySelector(`[data-settings-row="${i}"]`)?.scrollIntoView({ block: 'nearest' });
    },
    activate: (i) => rows[i]?.onA?.(),
    horizontal: (dir, i) => {
      const row = rows[i];
      if (!row) return false;
      if (row.chips?.length) {
        const cur = row.chips.findIndex((c) => c.active());
        if (cur < 0) return false;
        const next = (cur + (dir === 'right' ? 1 : -1) + row.chips.length) % row.chips.length;
        row.chips[next].set();
        return true;
      }
      if (row.onLeftRight) { row.onLeftRight(dir); return true; }
      // 没有行内可切换的东西：左右 = 跳列
      jumpCol(dir === 'right' ? 1 : -1);
      return true;
    },
    leave: (dir) => {
      // 列顶再上 → 回顶部导航
      if (dir === 'up') useFocusStore.getState().switchTo('nav');
    },
  });

  // 焦点行移走时强制 blur 输入框（守卫只在「焦点还在该输入框上」时动手）。
  // 只在手柄模式下生效：鼠标模式没有焦点行语义（focusedIndex 恒 -1），守卫
  // 条件恒成立；而 blurGuards 是每次渲染新建的数组，effect 每次渲染后都跑
  // → 正在输入的框被强制 blur（打一个字母就失焦）。鼠标模式直接拦掉
  const mode = useInputMode();
  useEffect(() => {
    if (mode !== 'gamepad') return;
    blurGuards?.forEach((g) => {
      if (g.index !== focusedIndex) {
        const el = g.ref.current;
        if (el && document.activeElement === el) el.blur();
      }
    });
  }, [focusedIndex, blurGuards, mode]);

  // 卡内行编号 = 卡片行数前缀和（渲染前算好，JSX 与数组同一实例，天然一致）
  const starts: number[] = [];
  let acc = 0;
  for (const c of cards) { starts.push(acc); acc += c.rows.length; }

  return (
    <section ref={colRef} className="settings-col" data-settings-col={colKey}>
      {cards.map((card, ci) => (
        <div key={card.titleKey} className="glass-card set-card">
          <div className="set-card-title">{t(card.titleKey)}</div>
          <div className="set-card-body">
            {card.rows.map((row, j) => (
              <SettingRow key={j} row={row} focused={focusedIndex === starts[ci] + j} index={starts[ci] + j} />
            ))}
            {card.tail}
          </div>
        </div>
      ))}
    </section>
  );
}

export default function SettingsView() {
  // 语言：订阅 i18n 状态（chips 激活态 + 切换即时生效）
  const lang = useLang();
  const t = useT();
  // 逐字段订阅：设置页整页较重，不该跟着音乐进度等无关字段重画
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const loadGames = useAppStore((s) => s.loadGames);
  const loadSeries = useAppStore((s) => s.loadSeries);
  const loadTracks = useAppStore((s) => s.loadTracks);
  const loadPlaylists = useAppStore((s) => s.loadPlaylists);
  const gameColumns = useAppStore((s) => s.gameColumns);
  const setGameColumns = useAppStore((s) => s.setGameColumns);
  // 品牌（软件标识）：名称 onBlur 落库；封面选图后落库；恢复默认清空
  const brandCover = useAppStore((s) => s.brandCover);
  const saveBrandName = useAppStore((s) => s.saveBrandName);
  const saveBrandCover = useAppStore((s) => s.saveBrandCover);
  const resetBrandCover = useAppStore((s) => s.resetBrandCover);
  const [brandNameInput, setBrandNameInput] = useState(() => useAppStore.getState().brandName);
  const hiddenLibraries = useAppStore((s) => s.hiddenLibraries);
  const setLibraryHidden = useAppStore((s) => s.setLibraryHidden);
  const columnsPct = ((gameColumns - MIN_GAME_COLUMNS) / (MAX_GAME_COLUMNS - MIN_GAME_COLUMNS)) * 100;
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [sgdbKey, setSgdbKey] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [tmdbKey, setTmdbKey] = useState('');
  const [savingTmdbKey, setSavingTmdbKey] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false); // 清除确认弹窗（自绘：是右否左）
  const [playerPath, setPlayerPath] = useState('');
  const [playerFullscreen, setPlayerFullscreen] = useState(true);
  // 内置播放引擎（mpv）
  const [engine, setEngine] = useState<'mpv' | 'external'>('mpv');
  const [hwdec, setHwdec] = useState(true);
  const [hdr, setHdr] = useState(true);
  const [mpvOk, setMpvOk] = useState(true);
  // 播放音乐时默认显示歌词（默认关，只有显式存过 "1" 才开）
  const [lyricsAutoShow, setLyricsAutoShow] = useState(false);
  // 肃正协议：跨端进度同步开关 + 核心目录（NAS 上的路径，UNC 或映射盘）。桌面默认关。
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [syncDir, setSyncDir] = useState('');
  const [fetchingCovers, setFetchingCovers] = useState(false);
  const [fetchProgress, setFetchProgress] = useState<{ done: number; total: number; ok: number; fail: number } | null>(null);
  const [fetchResult, setFetchResult] = useState<string | null>(null); // 完成结果（内联显示，不弹窗）
  // Steam 游玩数据导入（库外时长写进统计存档）
  const [importingPt, setImportingPt] = useState(false);
  const [ptProgress, setPtProgress] = useState<{ done: number; total: number; added: number } | null>(null);
  const [ptResult, setPtResult] = useState<string | null>(null);
  const [ptFailed, setPtFailed] = useState(false);
  const [fetchFailed, setFetchFailed] = useState(false); // 失败标红（结果文案已词条化，不能再用前缀判断）
  // 手柄支持：开关 + 连接状态（品牌/数量，随插拔实时刷新）
  const [gamepadEnabled, setGamepadEnabledState] = useState(isGamepadEnabled());
  const [pads, setPads] = useState<ConnectedPad[]>(getConnectedPads());
  // 西瓜键唤起开关（默认关）：开=按 Guide 从托盘唤起 ZEX + 注册表关掉 Game Bar 抢键
  const [guideBtn, setGuideBtn] = useState(false);
  // PS logo 键唤起开关（默认关）：开=按 DualSense 的 PS 键从托盘唤起 ZEX（HID 直读，独立开关）
  const [psBtn, setPsBtn] = useState(false);
  // 开机自启（读注册表为权威）+ 自启方式（库中行为设置，仅自启开启时有效）
  const [autostart, setAutostartState] = useState(false);
  const [autostartShow, setAutostartShow] = useState(false);
  // 设置读取门闩：所有异步读回之前不渲染 —— 否则开关会先按默认值（关/开）闪一帧，
  // 再跳到真实状态。本地读取毫秒级，首帧短暂空白不可感知
  const [loaded, setLoaded] = useState(false);
  // 输入框 ref（手柄 A 聚焦/失焦二段式）
  const sgdbRef = useRef<HTMLInputElement>(null);
  const tmdbRef = useRef<HTMLInputElement>(null);
  const brandNameRef = useRef<HTMLInputElement>(null);
  const playerPathRef = useRef<HTMLInputElement>(null);
  const syncDirRef = useRef<HTMLInputElement>(null);
  const loadStats = useAppStore((s) => s.loadStats);

  // 动态留空：整页竖向节奏跟着「各列内容量 vs 可用高度」走（见 useSettingsRhythm）。
  // sig 里列齐所有会改变列高的东西：语言（文案换行行数）、条件行、分支行、状态行
  const pageRef = useRef<HTMLDivElement>(null);
  const colsRef = useRef<HTMLDivElement>(null);
  useSettingsRhythm(pageRef, colsRef, [
    lang,
    loaded,
    autostart,
    engine,
    mpvOk,
    pads.length,
    hiddenLibraries.join(','),
    fetchResult ?? '',
    fetchingCovers && fetchProgress ? '1' : '',
  ].join('|'));

  // 清除确认弹窗：手柄完整操作（左右选 否/是，A 确认，B/Esc 关闭），弹窗期间
  // 手柄按键不再穿透到背后设置行（此前 A 键会直接触发弹窗底下的「清除」）
  const clearFocused = useFocusIndex('modal:clear-confirm');
  useModalGamepad('modal:clear-confirm', {
    enabled: showClearConfirm,
    onClose: () => setShowClearConfirm(false),
    count: 2,
    cols: 2,
    initialIndex: 0, // 默认聚焦「否」：危险操作默认不确认
    activate: (i) => {
      if (i === 1) void doClearAll();
      else setShowClearConfirm(false);
    },
  });

  useEffect(() => {
    let alive = true;
    // 全部读完才放行渲染（见 loaded 注释）。失败也算完成（保持默认值）
    Promise.allSettled([
      api.getSetting('steamgriddb_api_key').then((v) => setSgdbKey(v || '')),
      api.getSetting('tmdb_api_key').then((v) => setTmdbKey(v || '')),
      api.getSetting('player_path').then((v) => setPlayerPath(v || '')),
      // 未设置时默认全屏，只有显式存过 "0" 才是关
      api.getSetting('player_fullscreen').then((v) => setPlayerFullscreen(v !== '0')),
      api.getSetting('player_engine').then((v) => setEngine(v === 'external' ? 'external' : 'mpv')),
      api.getSetting('mpv_hwdec').then((v) => setHwdec(v !== 'no')),
      api.getSetting('mpv_hdr').then((v) => setHdr(v !== '0')),
      // 手柄开关：默认开，只有显式存过 "0" 才关（与播放设置同款约定）
      api.getSetting('gamepad_enabled').then((v) => {
        const on = v !== '0';
        setGamepadEnabled(on);
        setGamepadEnabledState(on);
      }),
      // 西瓜键唤起：默认关，只有显式存过 "1" 才开
      api.getSetting('guide_button_enabled').then((v) => setGuideBtn(v === '1')),
      // PS logo 键唤起：默认关，只有显式存过 "1" 才开
      api.getSetting('ps_button_enabled').then((v) => setPsBtn(v === '1')),
      // 开机自启：读注册表为权威（外部清理/备份恢复后库里旧值不作数）；
      // 自启方式读库（仅自启开启时有效，未存过默认驻留托盘）
      api.isAutostartEnabled().then(setAutostartState),
      api.getSetting('autostart_show_window').then((v) => setAutostartShow(v === '1')),
      api.mpvAvailable().then(setMpvOk),
      // 播放音乐时默认显示歌词：默认关，只有显式存过 "1" 才开
      api.getSetting('lyrics_auto_show').then((v) => setLyricsAutoShow(v === '1')),
      api.getSetting('sync_enabled').then((v) => setSyncEnabled(v === '1')),
      api.getSetting('sync_dir').then((v) => setSyncDir(v || '')),
    ]).then(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, []);

  // 手柄开关即时保存（写库 + 同步给 Gamepad 服务）
  const switchGamepad = (v: boolean) => {
    setGamepadEnabledState(v);
    setGamepadEnabled(v);
    void api.setSetting('gamepad_enabled', v ? '1' : '0').catch((err: any) => {
      void message(t('common.saveFailed', { msg: err.message }), { title: t('common.error'), kind: 'error' });
    });
  };

  // 西瓜键唤起开关：即时保存（后端写库 + 注册表同步）。注册表失败时设置已生效于 ZEX，
  // 但 Game Bar 仍可能抢键，提示但不清除
  const switchGuideBtn = (v: boolean) => {
    setGuideBtn(v);
    void api.setGuideButtonEnabled(v).then((regOk) => {
      if (!regOk) {
        void message(t('settings.guideRegFail'), { title: t('common.warning'), kind: 'warning' });
      }
    }).catch((err: any) => {
      setGuideBtn(!v); // 保存失败回滚
      void message(t('common.saveFailed', { msg: err.message }), { title: t('common.error'), kind: 'error' });
    });
  };

  // PS logo 键唤起开关：即时保存（写库 + 更新运行时标志，无注册表联动）
  const switchPsBtn = (v: boolean) => {
    setPsBtn(v);
    void api.setPsButtonEnabled(v).catch((err: any) => {
      setPsBtn(!v); // 保存失败回滚
      void message(t('common.saveFailed', { msg: err.message }), { title: t('common.error'), kind: 'error' });
    });
  };

  // 开机自启开关：即时保存（后端写库 + 注册表 Run 键）。注册表失败 = 自启实际没生效：
  // 回滚 UI + 按开/关方向给对应提示（与西瓜键的「设置已生效」语义不同，自启成败在注册表）
  const switchAutostart = (v: boolean) => {
    setAutostartState(v);
    void api.setAutostart(v, autostartShow).then((regOk) => {
      if (!regOk) {
        setAutostartState(!v);
        void message(
          v ? t('settings.autostartRegOnFail') : t('settings.autostartRegOffFail'),
          { title: t('common.warning'), kind: 'warning' },
        );
      }
    }).catch((err: any) => {
      setAutostartState(!v);
      void message(t('common.saveFailed', { msg: err.message }), { title: t('common.error'), kind: 'error' });
    });
  };

  // 自启方式：驻留托盘 / 直接显示（仅自启开启时可切换，后端重写 Run 值带 --show-window）
  const switchAutostartShow = (v: boolean) => {
    setAutostartShow(v);
    void api.setAutostart(true, v).then((regOk) => {
      if (!regOk) {
        setAutostartShow(!v);
        void message(t('settings.autostartShowRegFail'), { title: t('common.warning'), kind: 'warning' });
      }
    }).catch((err: any) => {
      setAutostartShow(!v);
      void message(t('common.saveFailed', { msg: err.message }), { title: t('common.error'), kind: 'error' });
    });
  };

  // 手柄连接状态实时刷新（后端 XInput + DualSense 两通道连接/断开都会 emit）
  useEffect(() => {
    const unsub = onConnectedChange(() => setPads(getConnectedPads()));
    return unsub;
  }, []);

  // 监听「获取缺失封面」的进度事件（挂载时注册一次，避免错过开头的事件）
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import('@tauri-apps/api/event').then(async ({ listen }) => {
      if (cancelled) return;
      unlisten = await listen<{ done: number; total: number; ok: number; fail: number }>(
        'cover-fetch-progress',
        (e) => setFetchProgress(e.payload),
      );
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // 监听「导入 Steam 游玩数据」的进度事件（同样挂载时注册一次，别错过开头）
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import('@tauri-apps/api/event').then(async ({ listen }) => {
      if (cancelled) return;
      unlisten = await listen<{ done: number; total: number; added: number }>(
        'steam-playtime-progress',
        (e) => setPtProgress(e.payload),
      );
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const handleFetchAllCovers = async () => {
    setFetchingCovers(true);
    setFetchProgress(null);
    setFetchResult(null);
    setFetchFailed(false);
    try {
      const res = await api.fetchAllSteamCovers();
      await loadGames();
      setFetchResult(
        res.total === 0
          ? t('settings.fetchAllDone')
          : t('settings.fetchResult', { total: res.total, ok: res.ok, fail: res.fail }),
      );
    } catch (err: any) {
      setFetchResult(t('settings.fetchFailed', { msg: err.message }));
      setFetchFailed(true);
    } finally {
      setFetchingCovers(false);
    }
  };

  const handleImportSteamPlaytime = async () => {
    setImportingPt(true);
    setPtProgress(null);
    setPtResult(null);
    setPtFailed(false);
    try {
      const res = await api.importSteamPlaytime();
      await loadStats(); // 统计页立刻反映（库外时长写的是统计存档）
      setPtResult(t('settings.steamPtResult', {
        total: res.total,
        updated: res.updated,
        added: res.added,
        skipped: res.skipped,
        hours: Math.round(res.seconds / 360) / 10,
      }));
    } catch (err: any) {
      setPtResult(t('settings.steamPtFailed', { msg: err.message }));
      setPtFailed(true);
    } finally {
      setImportingPt(false);
    }
  };

  const handleSaveSgdbKey = async () => {
    setSavingKey(true);
    try {
      await api.setSetting('steamgriddb_api_key', sgdbKey.trim());
      await message(t('settings.sgdbSaved'), { title: t('common.success'), kind: 'info' });
    } catch (err: any) {
      await message(t('common.saveFailed', { msg: err.message }), { title: t('common.error'), kind: 'error' });
    } finally {
      setSavingKey(false);
    }
  };

  const handleSaveTmdbKey = async () => {
    setSavingTmdbKey(true);
    try {
      await api.setSetting('tmdb_api_key', tmdbKey.trim());
      await message(t('settings.tmdbSaved'), { title: t('common.success'), kind: 'info' });
    } catch (err: any) {
      await message(t('common.saveFailed', { msg: err.message }), { title: t('common.error'), kind: 'error' });
    } finally {
      setSavingTmdbKey(false);
    }
  };

  const handleBrowsePlayer = async () => {
    const picked = await open({
      title: t('settings.pickPlayerTitle'),
      multiple: false,
      directory: false,
      filters: [{ name: t('settings.filterProgram'), extensions: ['exe'] }],
    });
    if (typeof picked === 'string') setPlayerPath(picked);
  };

  // 播放设置即时保存：每次改动直接落库，不设保存按钮
  const savePlayerSetting = (key: string, value: string) => {
    void api.setSetting(key, value).catch((err: any) => {
      void message(t('common.saveFailed', { msg: err.message }), { title: t('common.error'), kind: 'error' });
    });
  };

  const switchEngine = (v: 'mpv' | 'external') => {
    setEngine(v);
    savePlayerSetting('player_engine', v);
  };

  const switchHwdec = (v: boolean) => {
    setHwdec(v);
    savePlayerSetting('mpv_hwdec', v ? 'auto' : 'no');
  };

  const switchHdr = (v: boolean) => {
    setHdr(v);
    savePlayerSetting('mpv_hdr', v ? '1' : '0');
  };

  // 播放音乐时默认显示歌词：即时保存（与 hwdec/hdr 同款）
  const switchLyricsAutoShow = (v: boolean) => {
    setLyricsAutoShow(v);
    savePlayerSetting('lyrics_auto_show', v ? '1' : '0');
  };

  // 肃正协议：开关 / 核心目录即时保存；开→立即对账，关→删掉核心文件（路径保留、一直显示）
  const switchSyncEnabled = (v: boolean) => {
    setSyncEnabled(v);
    void api.setSetting('sync_enabled', v ? '1' : '0')
      .then(() => (v ? api.triggerSync() : api.syncPurge()))
      .catch(() => {});
  };
  const saveSyncDir = () => {
    void api.setSetting('sync_dir', syncDir.trim()).then(() => api.triggerSync()).catch(() => {});
  };
  const handleBrowseSyncDir = async () => {
    const picked = await open({ directory: true });
    if (typeof picked === 'string') {
      setSyncDir(picked);
      void api.setSetting('sync_dir', picked).then(() => api.triggerSync()).catch(() => {});
    }
  };

  const switchFullscreen = (v: boolean) => {
    setPlayerFullscreen(v);
    savePlayerSetting('player_fullscreen', v ? '1' : '0');
  };

  const savePlayerPath = () => savePlayerSetting('player_path', playerPath.trim());

  // 品牌封面：选本地图片 → 后端复制进 covers 目录 → 存路径（空 = 内置 logo）
  const handlePickBrandCover = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: t('settings.filterImage'), extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      });
      if (typeof selected !== 'string') return;
      const stored = await api.setBrandCover(selected);
      await saveBrandCover(stored);
    } catch (err) {
      alert(typeof err === 'string' ? err : t('settings.coverPickFail'));
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const path = await save({
        title: t('settings.exportDialogTitle'),
        filters: [{ name: 'JSON', extensions: ['json'] }],
        defaultPath: 'zex-backup.json',
      });
      if (!path) { setExporting(false); return; }
      const data = await api.exportData();
      const { writeTextFile } = await import('@tauri-apps/plugin-fs');
      await writeTextFile(path, data);
      await message(t('settings.exported', { path }), { title: t('common.success'), kind: 'info' });
    } catch (err: any) {
      await message(t('settings.exportFailed', { msg: err.message }), { title: t('common.error'), kind: 'error' });
    } finally {
      setExporting(false);
    }
  };

  const handleImport = async () => {
    setImporting(true);
    try {
      const path = await open({
        title: t('settings.importDialogTitle'),
        filters: [{ name: 'JSON', extensions: ['json'] }],
        multiple: false,
      });
      if (!path) { setImporting(false); return; }
      const { readTextFile } = await import('@tauri-apps/plugin-fs');
      const data = await readTextFile(path as string);
      await api.importData(data);
      // 导入会整库替换：四大库 + 歌单全部重拉，避免界面残留导入前的旧数据
      await Promise.all([loadGames(), loadSeries(), loadTracks(), loadPlaylists()]);
      await message(t('settings.imported'), { title: t('common.success'), kind: 'info' });
    } catch (err: any) {
      await message(t('settings.importFailed', { msg: err.message }), { title: t('common.error'), kind: 'error' });
    } finally {
      setImporting(false);
    }
  };

  const handleClearAllData = async () => {
    setShowClearConfirm(true);
  };

  // 确认后的真正清除逻辑（自绘弹窗「是」触发）
  const doClearAll = async () => {
    setShowClearConfirm(false);
    setClearing(true);
    try {
      // 先停掉正在播放的音乐（清 UI 播放条 + 让 mpv 退出，桌面歌词随 mpv-closed 自关）。
      // 不停的话播放条会一直显示一首库里已不存在的曲目（进度事件还在推）。
      // mpv 空闲时 mpv_quit 也安全（send_to_session 失败被吞，恒 Ok）
      await useAppStore.getState().stopMusic();
      await api.clearAllData();
      await Promise.all([loadGames(), loadSeries(), loadTracks(), loadPlaylists()]);
      await message(t('settings.cleared'), { title: t('common.success'), kind: 'info' });
    } catch (err: any) {
      await message(t('settings.clearFailed', { msg: err.message }), { title: t('common.error'), kind: 'error' });
    } finally {
      setClearing(false);
    }
  };

  // ── 行数据（组件内构建：闭包引用 state/handlers）。每行 chips 管手柄左右、
  //    children 管可见形态 —— 两处同步维护（现有模式）。条件行只影响本列局部编号 ──
  const themeRows = [
    { value: 'light' as const, icon: Sun, label: 'settings.themeLight' },
    { value: 'dark' as const, icon: Moon, label: 'settings.themeDark' },
    { value: 'system' as const, icon: Monitor, label: 'settings.themeSystem' },
  ];

  // 隐藏库：三个主库最多 2 个；统计页不占名额，可独立隐藏
  const tryHide = (id: 'games' | 'series' | 'music' | 'stats') => {
    if (id !== 'stats' && !hiddenLibraries.includes(id) && hiddenLibraries.filter((x) => x !== 'stats').length >= 2) {
      void message(t('settings.hideLimit'), { title: t('common.tip'), kind: 'info' });
      return;
    }
    setLibraryHidden(id, true);
  };

  // 每行：chips = [隐藏, 显示]，手柄左右切换（激活态「显示」在右）
  const libRow = (id: 'games' | 'series' | 'music' | 'stats') => ({
    chips: [
      { active: () => hiddenLibraries.includes(id), set: () => tryHide(id) },
      { active: () => !hiddenLibraries.includes(id), set: () => setLibraryHidden(id, false) },
    ],
  });

  /** 开 / 关 chips 的可见形态（手柄逻辑在各行的 chips 里同步维护） */
  const onOffChips = (on: boolean, set: (v: boolean) => void) => (
    <div className="flex items-center gap-1.5">
      <button className={clsx('chip', !on && 'active')} onClick={() => set(false)}>{t('common.off')}</button>
      <button className={clsx('chip', on && 'active')} onClick={() => set(true)}>{t('common.on')}</button>
    </div>
  );

  /** 输入行手柄二段式：A = 聚焦输入框，再按 A = 失焦（onBlur 里落库） */
  const focusToggle = (ref: React.RefObject<HTMLInputElement | null>) => () => {
    const el = ref.current;
    if (!el) return;
    if (document.activeElement === el) el.blur();
    else el.focus();
  };

  /** SGDB / TMDB 输入行：再按 A = 失焦并保存（手柄没有点「保存」按钮的途径） */
  const sgdbFocus = () => {
    const el = sgdbRef.current;
    if (!el) return;
    if (document.activeElement === el) { el.blur(); void handleSaveSgdbKey(); }
    else el.focus();
  };
  const tmdbFocus = () => {
    const el = tmdbRef.current;
    if (!el) return;
    if (document.activeElement === el) { el.blur(); void handleSaveTmdbKey(); }
    else el.focus();
  };

  // 各库隐藏行共用
  const libItems = [
    { id: 'games' as const, name: 'nav.games' },
    { id: 'series' as const, name: 'nav.series' },
    { id: 'music' as const, name: 'nav.music' },
    { id: 'stats' as const, name: 'nav.stats' },
  ];

  // 三列的行数据。列 1 = 外观 → 启动 → 播放；列 2 = 封面 → 手柄 → 软件标识；
  // 列 3 = 库 → 数据 → 关于。列内行编号 = 数组顺序，条件行只影响本列局部编号。
  // 播放卡 mpv / external 分支都是 4 行（编号稳定）；启动卡 autostart 开启时多 1 行
  const columnCards: Record<ColKey, SettingsCard[]> = {
    appearance: [
      {
        titleKey: 'settings.appearance',
        rows: [
          {
            label: t('settings.theme'),
            chips: themeRows.map((r) => ({ active: () => theme === r.value, set: () => setTheme(r.value) })),
            children: (
              <div className="flex gap-2">
                {themeRows.map(({ value, icon: Icon, label }) => (
                  <button
                    key={value}
                    onClick={() => setTheme(value)}
                    className={clsx(
                      'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-all',
                      theme === value
                        ? 'bg-[rgba(0,212,255,0.12)] border border-[rgba(0,212,255,0.3)] text-[#00d4ff]'
                        : 'bg-bg-surface border border-transparent text-text-secondary hover:text-text-primary hover:bg-bg-surface-hover',
                    )}
                  >
                    <Icon size={14} />
                    {t(label)}
                  </button>
                ))}
              </div>
            ),
          },
          {
            label: t('settings.language'),
            chips: LANGUAGES.map((l) => ({ active: () => lang === l.code, set: () => setLang(l.code) })),
            children: (
              <div className="flex gap-2">
                {LANGUAGES.map(({ code, label }) => (
                  <button
                    key={code}
                    onClick={() => setLang(code)}
                    className={clsx(
                      'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-all',
                      lang === code
                        ? 'bg-[rgba(0,212,255,0.12)] border border-[rgba(0,212,255,0.3)] text-[#00d4ff]'
                        : 'bg-bg-surface border border-transparent text-text-secondary hover:text-text-primary hover:bg-bg-surface-hover',
                    )}
                  >
                    <Languages size={14} />
                    {label}
                  </button>
                ))}
              </div>
            ),
          },
          {
            label: t('settings.gameColumnsTitle'),
            onLeftRight: (dir) => setGameColumns(gameColumns + (dir === 'right' ? 1 : -1)),
            children: (
              <div className="flex items-center gap-4 shrink-0">
                <div className="grid-size-row w-[180px]">
                  <button
                    className="grid-size-btn"
                    disabled={gameColumns <= MIN_GAME_COLUMNS}
                    onClick={() => setGameColumns(gameColumns - 1)}
                    title={t('settings.colMinus')}
                  >
                    <Minus size={13} />
                  </button>
                  <input
                    type="range"
                    className="grid-size-range"
                    min={MIN_GAME_COLUMNS}
                    max={MAX_GAME_COLUMNS}
                    step={1}
                    value={gameColumns}
                    onChange={(e) => setGameColumns(Number(e.target.value))}
                    style={{
                      // 已选区间填成青色，剩余为轨道底色
                      background: `linear-gradient(to right, var(--color-accent) 0%, var(--color-accent) ${columnsPct}%, var(--color-bg-surface-active) ${columnsPct}%, var(--color-bg-surface-active) 100%)`,
                    }}
                  />
                  <button
                    className="grid-size-btn"
                    disabled={gameColumns >= MAX_GAME_COLUMNS}
                    onClick={() => setGameColumns(gameColumns + 1)}
                    title={t('settings.colPlus')}
                  >
                    <Plus size={13} />
                  </button>
                </div>
                <span className="grid-size-value">{gameColumns}</span>
              </div>
            ),
          },
        ],
      },
      {
        titleKey: 'settings.sectionStartup',
        rows: [
          {
            label: <span className="flex items-center gap-2"><Power size={14} className="text-text-tertiary" />{t('settings.autostart')}</span>,
            desc: t('settings.autostartDesc'),
            chips: [
              { active: () => !autostart, set: () => switchAutostart(false) },
              { active: () => autostart, set: () => switchAutostart(true) },
            ],
            children: onOffChips(autostart, switchAutostart),
          },
          // 条件行：只在自启开启时进数组 —— 编号局部自对齐，无全局偏移
          ...(autostart
            ? [{
                label: t('settings.autostartMethod'),
                chips: [
                  { active: () => !autostartShow, set: () => switchAutostartShow(false) },
                  { active: () => autostartShow, set: () => switchAutostartShow(true) },
                ],
                children: (
                  <div className="flex items-center gap-1.5">
                    <button className={clsx('chip', !autostartShow && 'active')} onClick={() => switchAutostartShow(false)}>{t('settings.autostartTray')}</button>
                    <button className={clsx('chip', autostartShow && 'active')} onClick={() => switchAutostartShow(true)}>{t('settings.autostartShow')}</button>
                  </div>
                ),
              }]
            : []),
        ],
      },
      {
        titleKey: 'settings.sectionPlayback',
        rows: [
          // 引擎块（自定义行；mpv 缺失警告挂在块内，只增高不产生编号偏移）
          {
            chips: [
              { active: () => engine === 'mpv', set: () => switchEngine('mpv') },
              { active: () => engine === 'external', set: () => switchEngine('external') },
            ],
            render: () => (
              <div>
                <div className="set-blk-head">
                  <MonitorPlay size={15} className="text-[#00d4ff]" />
                  <p className="set-blk-title">{t('settings.engine')}</p>
                </div>
                <p className="set-blk-desc">{t('settings.engineDesc')}</p>
                <div className="set-blk-ctl flex items-center gap-1.5">
                  <button className={clsx('chip', engine === 'mpv' && 'active')} onClick={() => switchEngine('mpv')}>
                    {t('settings.engineMpv')}
                  </button>
                  <button className={clsx('chip', engine === 'external' && 'active')} onClick={() => switchEngine('external')}>
                    {t('settings.engineExternal')}
                  </button>
                </div>
                {!mpvOk && (
                  <p className="set-blk-note flex items-start gap-2 text-[#ffc94d]">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                    {t('settings.mpvMissingPre')}{' '}
                    <code className="px-1 rounded bg-bg-surface-active">bash scripts/fetch-mpv.sh</code>
                    {' '}{t('settings.mpvMissingPost')}
                  </p>
                )}
              </div>
            ),
          },
          // 播放引擎分支：mpv 2 行 / external 2 行，行数恒定（编号不漂移）
          ...(engine === 'mpv'
            ? [
                {
                  label: <span className="flex items-center gap-2"><Cpu size={14} className="text-text-tertiary" />{t('settings.hwdec')}</span>,
                  desc: t('settings.hwdecDesc'),
                  chips: [
                    { active: () => !hwdec, set: () => switchHwdec(false) },
                    { active: () => hwdec, set: () => switchHwdec(true) },
                  ],
                  children: onOffChips(hwdec, switchHwdec),
                },
                {
                  label: t('settings.hdr'),
                  desc: t('settings.hdrDesc'),
                  chips: [
                    { active: () => !hdr, set: () => switchHdr(false) },
                    { active: () => hdr, set: () => switchHdr(true) },
                  ],
                  children: onOffChips(hdr, switchHdr),
                },
              ]
            : [
                {
                  onA: focusToggle(playerPathRef),
                  render: () => (
                    <div>
                      <p className="set-blk-title">{t('settings.playerPath')}</p>
                      <div className="set-blk-ctl flex gap-2">
                        <input
                          ref={playerPathRef}
                          value={playerPath}
                          onChange={(e) => setPlayerPath(e.target.value)}
                          onBlur={savePlayerPath}
                          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                          placeholder={t('settings.playerPathPlaceholder')}
                          className="input flex-1 text-sm"
                        />
                        <button onClick={handleBrowsePlayer} className="btn btn-glass gap-2 text-sm px-4 shrink-0">
                          <FolderOpen size={14} />
                          {t('settings.browse')}
                        </button>
                      </div>
                    </div>
                  ),
                },
                {
                  label: t('settings.fullscreen'),
                  desc: t('settings.fullscreenDesc'),
                  chips: [
                    { active: () => playerFullscreen, set: () => switchFullscreen(true) },
                    { active: () => !playerFullscreen, set: () => switchFullscreen(false) },
                  ],
                  children: (
                    <div className="flex items-center gap-1.5">
                      <button className={clsx('chip', playerFullscreen && 'active')} onClick={() => switchFullscreen(true)}>
                        {t('settings.fullscreenOn')}
                      </button>
                      <button className={clsx('chip', !playerFullscreen && 'active')} onClick={() => switchFullscreen(false)}>
                        {t('settings.windowed')}
                      </button>
                    </div>
                  ),
                },
              ]),
          {
            label: t('settings.lyricsAutoShow'),
            desc: t('settings.lyricsAutoShowDesc'),
            chips: [
              { active: () => !lyricsAutoShow, set: () => switchLyricsAutoShow(false) },
              { active: () => lyricsAutoShow, set: () => switchLyricsAutoShow(true) },
            ],
            children: onOffChips(lyricsAutoShow, switchLyricsAutoShow),
          },
        ],
      },
    ],
    startup: [
      {
        titleKey: 'settings.sectionCovers',
        rows: [
          {
            onA: sgdbFocus,
            render: () => (
              <div>
                <div className="set-blk-head">
                  <KeyRound size={15} className="text-[#00d4ff]" />
                  <p className="set-blk-title">SteamGridDB API Key</p>
                </div>
                <p className="set-blk-desc">{t('settings.sgdbDesc')}</p>
                <div className="set-blk-ctl flex gap-2">
                  <input
                    ref={sgdbRef}
                    value={sgdbKey}
                    onChange={(e) => setSgdbKey(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    placeholder={t('settings.sgdbPlaceholder')}
                    className="input flex-1 text-sm"
                  />
                  <button
                    onClick={handleSaveSgdbKey}
                    disabled={savingKey}
                    className="btn btn-accent text-sm px-5"
                  >
                    {savingKey ? t('common.saving') : t('common.save')}
                  </button>
                </div>
              </div>
            ),
          },
          {
            onA: tmdbFocus,
            render: () => (
              <div>
                <div className="set-blk-head">
                  <KeyRound size={15} className="text-[#00d4ff]" />
                  <p className="set-blk-title">TMDB API Key</p>
                </div>
                <p className="set-blk-desc">{t('settings.tmdbDesc')}</p>
                <div className="set-blk-ctl flex gap-2">
                  <input
                    ref={tmdbRef}
                    value={tmdbKey}
                    onChange={(e) => setTmdbKey(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    placeholder={t('settings.tmdbPlaceholder')}
                    className="input flex-1 text-sm"
                  />
                  <button
                    onClick={handleSaveTmdbKey}
                    disabled={savingTmdbKey}
                    className="btn btn-accent text-sm px-5"
                  >
                    {savingTmdbKey ? t('common.saving') : t('common.save')}
                  </button>
                </div>
              </div>
            ),
          },
          {
            onA: () => void handleFetchAllCovers(),
            render: () => (
              <div>
                <div className="flex items-center justify-between gap-4">
                  <div className="set-row-text">
                    <p className="set-row-label">{t('settings.fetchCovers')}</p>
                    <p className="set-row-desc">{t('settings.fetchCoversDesc')}</p>
                  </div>
                  <button
                    onClick={() => void handleFetchAllCovers()}
                    disabled={fetchingCovers}
                    className="btn btn-glass gap-2 text-sm shrink-0"
                  >
                    {fetchingCovers && <Loader2 size={14} className="animate-spin" />}
                    {fetchingCovers ? t('settings.fetching') : t('settings.fetchCoversBtn')}
                  </button>
                </div>
                {fetchingCovers && fetchProgress && fetchProgress.total > 0 && (
                  <div className="set-blk-ctl">
                    {/* 进度条：每完成一个游戏走一格，宽度过渡让跳动平滑 */}
                    <div className="h-1.5 rounded-full bg-bg-surface-active overflow-hidden">
                      <div
                        className="h-full rounded-full bg-[#00d4ff] transition-all duration-300"
                        style={{ width: `${Math.round((fetchProgress.done / fetchProgress.total) * 100)}%` }}
                      />
                    </div>
                    <p className="set-blk-note text-text-secondary">
                      {t('settings.fetchProgress', {
                        done: fetchProgress.done,
                        total: fetchProgress.total,
                        ok: fetchProgress.ok,
                        fail: fetchProgress.fail,
                      })}
                    </p>
                  </div>
                )}

                {/* 完成结果：内联显示，不弹窗 */}
                {fetchResult && (
                  <p className={clsx('set-blk-note', fetchFailed ? 'text-danger' : 'text-text-secondary')}>
                    {fetchResult}
                  </p>
                )}
              </div>
            ),
          },
        ],
      },
      {
        titleKey: 'settings.sectionGamepad',
        rows: [
          {
            label: <span className="flex items-center gap-2"><Gamepad2 size={14} className="text-text-tertiary" />{t('settings.gamepadSupport')}</span>,
            desc: t('settings.gamepadSupportDesc'),
            chips: [
              { active: () => !gamepadEnabled, set: () => switchGamepad(false) },
              { active: () => gamepadEnabled, set: () => switchGamepad(true) },
            ],
            children: onOffChips(gamepadEnabled, switchGamepad),
          },
          {
            label: <span className="flex items-center gap-2"><Gamepad2 size={14} className="text-text-tertiary" />{t('settings.guideBtn')}</span>,
            desc: t('settings.guideBtnDesc'),
            chips: [
              { active: () => !guideBtn, set: () => switchGuideBtn(false) },
              { active: () => guideBtn, set: () => switchGuideBtn(true) },
            ],
            children: onOffChips(guideBtn, switchGuideBtn),
          },
          {
            label: <span className="flex items-center gap-2"><Gamepad2 size={14} className="text-text-tertiary" />{t('settings.psBtn')}</span>,
            desc: t('settings.psBtnDesc'),
            chips: [
              { active: () => !psBtn, set: () => switchPsBtn(false) },
              { active: () => psBtn, set: () => switchPsBtn(true) },
            ],
            children: onOffChips(psBtn, switchPsBtn),
          },
        ],
        // 连接状态（只读，随插拔实时刷新）：与行同一套内边距，不吃剩余空间
        tail: (
          <div className="set-tail set-tail-flex">
            <Gamepad2 size={14} className={pads.length > 0 ? 'text-[#00d4ff]' : 'text-text-tertiary'} />
            {pads.length > 0 ? (
              <span className="text-text-secondary">{t('settings.padsConnected', { list: pads.map((p) => p.name).join(t('settings.padsJoinSep')) })}</span>
            ) : (
              <span className="text-text-tertiary">{t('settings.padsNone')}</span>
            )}
          </div>
        ),
      },
      {
        titleKey: 'settings.sectionBrand',
        rows: [
          {
            label: t('settings.brandName'),
            desc: t('settings.brandNameDesc'),
            onA: focusToggle(brandNameRef),
            children: (
              <input
                ref={brandNameRef}
                type="text"
                value={brandNameInput}
                onChange={(e) => setBrandNameInput(e.target.value)}
                onBlur={() => void saveBrandName(brandNameInput)}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                placeholder="ZEX"
                maxLength={30}
                className="input flex-1 text-sm shrink-0 max-w-[260px]"
              />
            ),
          },
          {
            label: t('settings.brandCover'),
            desc: t('settings.brandCoverDesc'),
            onA: () => void handlePickBrandCover(),
            children: (
              <div className="flex items-center gap-3 shrink-0">
                <img
                  src={brandCover ? coverSrc(brandCover) : zexLogo}
                  alt={t('settings.brandCoverAlt')}
                  draggable={false}
                  className="w-10 h-10 object-contain rounded-lg bg-bg-surface border border-border-glass"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).src = zexLogo; }}
                />
                <button onClick={handlePickBrandCover} className="btn btn-glass gap-2 text-sm px-4">
                  <ImageIcon size={14} />
                  {t('settings.changeCover')}
                </button>
                {brandCover && (
                  <button onClick={() => void resetBrandCover()} className="btn btn-glass text-sm px-4 text-text-secondary">
                    {t('settings.resetDefault')}
                  </button>
                )}
              </div>
            ),
          },
        ],
      },
    ],
    covers: [
      {
        titleKey: 'settings.sectionLibs',
        rows: libItems.map((lib) => ({
          label: t(lib.name),
          chips: libRow(lib.id).chips,
          children: (
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                className={clsx('chip', hiddenLibraries.includes(lib.id) && 'active')}
                onClick={() => tryHide(lib.id)}
              >
                {t('settings.hide')}
              </button>
              <button
                className={clsx('chip', !hiddenLibraries.includes(lib.id) && 'active')}
                onClick={() => setLibraryHidden(lib.id, false)}
              >
                {t('settings.show')}
              </button>
            </div>
          ),
        })),
        tail: (
          <div className="set-tail text-text-tertiary">
            {t('settings.libsNote')}
            <br />
            {hiddenLibraries.includes('series') && hiddenLibraries.includes('music')
              ? t('settings.libsMpvOff')
              : t('settings.libsMpvNote')}
          </div>
        ),
      },
      {
        titleKey: 'settings.sectionData',
        rows: [
          {
            label: t('settings.exportData'),
            onA: () => void handleExport(),
            children: (
              <button onClick={() => void handleExport()} disabled={exporting} className="btn btn-glass gap-2 text-sm">
                <Download size={15} />
                {exporting ? t('settings.exporting') : t('settings.exportBtn')}
              </button>
            ),
          },
          {
            label: t('settings.importData'),
            onA: () => void handleImport(),
            children: (
              <button onClick={() => void handleImport()} disabled={importing} className="btn btn-glass gap-2 text-sm">
                <Upload size={15} />
                {importing ? t('settings.importing') : t('settings.importBtn')}
              </button>
            ),
          },
          {
            // Steam 游玩数据：库外的写进统计存档（统计页可见），库内已有的按较大值校准
            onA: () => void handleImportSteamPlaytime(),
            render: () => (
              <div>
                <div className="flex items-center justify-between gap-4">
                  <div className="set-row-text">
                    <p className="set-row-label">{t('settings.importSteamPlaytime')}</p>
                    <p className="set-row-desc">{t('settings.importSteamPlaytimeDesc')}</p>
                  </div>
                  <button
                    onClick={() => void handleImportSteamPlaytime()}
                    disabled={importingPt}
                    className="btn btn-glass gap-2 text-sm shrink-0"
                  >
                    {importingPt && <Loader2 size={14} className="animate-spin" />}
                    {importingPt ? t('settings.importing') : t('settings.importBtn')}
                  </button>
                </div>
                {importingPt && ptProgress && ptProgress.total > 0 && (
                  <div className="set-blk-ctl">
                    <div className="h-1.5 rounded-full bg-bg-surface-active overflow-hidden">
                      <div
                        className="h-full rounded-full bg-[#00d4ff] transition-all duration-300"
                        style={{ width: `${Math.round((ptProgress.done / ptProgress.total) * 100)}%` }}
                      />
                    </div>
                    <p className="set-blk-note text-text-secondary">
                      {t('settings.steamPtProgress', { done: ptProgress.done, total: ptProgress.total, added: ptProgress.added })}
                    </p>
                  </div>
                )}
                {ptResult && (
                  <p className={clsx('set-blk-note', ptFailed ? 'text-danger' : 'text-text-secondary')}>{ptResult}</p>
                )}
              </div>
            ),
          },
          {
            label: <span className="text-danger">{t('settings.clearData')}</span>,
            desc: t('settings.clearDesc'),
            onA: () => handleClearAllData(),
            children: (
              <button onClick={() => handleClearAllData()} disabled={clearing} className="btn btn-danger gap-2 text-sm">
                <Trash2 size={15} />
                {clearing ? t('settings.clearing') : t('settings.clearBtn')}
              </button>
            ),
          },
        ],
      },
      {
        titleKey: 'settings.sync',
        rows: [
          {
            label: t('settings.syncEnabled'),
            desc: t('settings.syncHint'),
            chips: [
              { active: () => syncEnabled, set: () => switchSyncEnabled(true) },
              { active: () => !syncEnabled, set: () => switchSyncEnabled(false) },
            ],
            children: onOffChips(syncEnabled, switchSyncEnabled),
          },
          {
            onA: focusToggle(syncDirRef),
            render: () => (
              <div>
                <p className="set-blk-title">{t('settings.syncLocation')}</p>
                <p className="set-blk-desc">{t('settings.syncDirHintDesktop')}</p>
                <div className="set-blk-ctl flex gap-2">
                  <input
                    ref={syncDirRef}
                    value={syncDir}
                    onChange={(e) => setSyncDir(e.target.value)}
                    onBlur={saveSyncDir}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    placeholder={t('settings.syncDirPlaceholderDesktop')}
                    className="input flex-1 text-sm"
                  />
                  <button onClick={() => void handleBrowseSyncDir()} className="btn btn-glass gap-2 text-sm px-4 shrink-0">
                    <FolderOpen size={14} />
                    {t('settings.browse')}
                  </button>
                </div>
              </div>
            ),
          },
        ],
      },
      {
        titleKey: 'settings.sectionAbout',
        rows: [],
        tail: (
          <div className="set-about">
            <div className="flex items-center gap-3">
              <img
                src={zexLogo}
                alt="ZEX"
                draggable={false}
                className="w-12 h-12 object-contain"
                style={{ filter: 'drop-shadow(0 0 8px rgba(0,212,255,0.35))' }}
              />
              <div>
                <h3 className="font-bold text-base">ZEX</h3>
                <p className="text-sm text-text-secondary">{t('settings.version', { v: '0.1.0' })}</p>
              </div>
            </div>
            <p className="text-sm text-text-secondary leading-relaxed">
              {t('settings.aboutText')}
            </p>
            <div className="flex flex-col gap-1.5">
              <AboutLink href="https://github.com/Yuzexiaoyu/Zex" label={t('settings.github')} />
              <AboutLink href="https://space.bilibili.com/515360845" label={t('settings.bilibili')} />
              <AboutLink href="https://www.youtube.com/@Yuzexiaoyu" label={t('settings.youtube')} />
            </div>
          </div>
        ),
      },
    ],
  };

  // 输入行 blur 守卫：index 按列内卡序动态计算 —— 启动卡的 autostart 条件行会让
  // 列 1 后续卡的行编号 ±1，不能写死。列 1：外观(0) → 启动(1) → 播放(2)，
  // playerPath 是播放卡第 1 行；列 2：封面(0) → 手柄(1) → 品牌(2)，
  // SGDB/TMDB 是封面卡第 0/1 行，brandName 是品牌卡第 0 行
  const rowIndexIn = (col: ColKey, card: number, row: number) => {
    let acc = 0;
    for (let i = 0; i < card; i++) acc += columnCards[col][i].rows.length;
    return acc + row;
  };
  const appearanceGuards = [
    { index: rowIndexIn('appearance', 2, 1), ref: playerPathRef },
  ];
  const startupGuards = [
    { index: rowIndexIn('startup', 0, 0), ref: sgdbRef },
    { index: rowIndexIn('startup', 0, 1), ref: tmdbRef },
    { index: rowIndexIn('startup', 2, 0), ref: brandNameRef },
  ];

  // 所有设置读回前渲染骨架占位 —— 直接 return null 会露出深色背景（黑闪一帧）。
  // 玻璃卡结构先立起来，灰条呼吸动画示意加载中，读回后整页换成真实内容
  if (!loaded) {
    return (
      <div className="h-full settings-page">
        <div className="settings-cols">
          {[0, 1, 2].map((col) => (
            <div key={col} className="settings-col">
              {[0, 1, 2].map((card) => (
                // 骨架也铺满（真实内容由 JS 逐卡设 grow，这里给个 1 就够）
                <div key={card} className="glass-card set-card px-5 py-4" style={{ flexGrow: 1 }}>
                  <div className="stats-skeleton-pulse h-3 w-20 rounded bg-bg-surface-active mb-3" />
                  {[0, 1, 2].map((row) => (
                    <div
                      key={row}
                      className="stats-skeleton-pulse h-4 rounded bg-bg-surface-active my-2"
                      style={{ width: `${95 - row * 15}%` }}
                    />
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
    <div ref={pageRef} className="h-full settings-page">
      <div ref={colsRef} className="settings-cols">
        <SettingsColumn colKey="appearance" cards={columnCards.appearance} allCards={columnCards} blurGuards={appearanceGuards} />
        <SettingsColumn colKey="startup" cards={columnCards.startup} allCards={columnCards} blurGuards={startupGuards} />
        <SettingsColumn colKey="covers" cards={columnCards.covers} allCards={columnCards} />
      </div>
    </div>

    {/* 清除所有数据确认弹窗（自绘：按钮「否」左、「是」右） */}
    {showClearConfirm && (
      <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in" onClick={() => setShowClearConfirm(false)} />
        <div className="relative w-full max-w-sm glass-modal shadow-2xl animate-scale-in">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border-glass">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-[rgba(239,68,68,0.12)] border border-[rgba(239,68,68,0.2)] flex items-center justify-center">
                <AlertTriangle size={16} className="text-[#ef4444]" />
              </div>
              <h3 className="text-base font-semibold">{t('settings.clearData')}</h3>
            </div>
            <button onClick={() => setShowClearConfirm(false)} className="w-8 h-8 rounded-lg flex items-center justify-center text-text-tertiary hover:bg-bg-surface-active">
              <X size={16} />
            </button>
          </div>
          <div className="px-5 py-4">
            <p className="text-sm text-text-secondary leading-relaxed">
              {t('settings.clearConfirmBody')}
            </p>
            <div className="flex justify-end gap-2 pt-4">
              <button onClick={() => setShowClearConfirm(false)} className={clsx('btn btn-ghost', clearFocused === 0 && 'gamepad-focus')}>{t('common.no')}</button>
              <button onClick={() => void doClearAll()} className={clsx('btn btn-danger', clearFocused === 1 && 'gamepad-focus')}>{t('common.yes')}</button>
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
