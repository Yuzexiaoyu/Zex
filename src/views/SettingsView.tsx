import { useState, useEffect, useRef } from 'react';
import { Settings as SettingsIcon, Sun, Moon, Monitor, MonitorPlay, FolderOpen, Download, Upload, ExternalLink, KeyRound, Trash2, Loader2, Minus, Plus, Cpu, AlertTriangle, Gamepad2, X, Power, Image as ImageIcon, Languages } from 'lucide-react';
import zexLogo from '../assets/zex-logo.png';
import { coverSrc } from '../utils/media';
import { clsx } from 'clsx';
import * as api from '../api';
import { message, save, open } from '@tauri-apps/plugin-dialog';
import { useAppStore, MIN_GAME_COLUMNS, MAX_GAME_COLUMNS } from '../store';
import { useLang, useT, setLang, LANGUAGES } from '../i18n';
import { setGamepadEnabled, isGamepadEnabled, useGamepadGroup, useFocusIndex, useRightStickScroll, useModalGamepad, getConnectedPads, onConnectedChange } from '../gamepad';
import type { ConnectedPad } from '../gamepad';

// OSD 帧数颜色预设（RTSS BaseColor 的 0x00RRGGBB 值）
const RTSS_COLORS = [
  { value: '00FF8000', labelKey: 'settings.rtssColorGreen' },
  { value: '00FFFF00', labelKey: 'settings.rtssColorYellow' },
  { value: '0000FFFF', labelKey: 'settings.rtssColorCyan' },
  { value: '00FFFFFF', labelKey: 'settings.rtssColorWhite' },
  { value: '00FF0000', labelKey: 'settings.rtssColorRed' },
];

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
  // RTSS 帧数 OSD（全局默认；游戏级开关在游戏右键菜单）
  const [rtss, setRtss] = useState<{ installed: boolean; running: boolean }>({ installed: false, running: false });
  const [rtssEnabled, setRtssEnabled] = useState(false);
  const [rtssPosition, setRtssPosition] = useState(1);
  const [rtssZoom, setRtssZoom] = useState(2);
  const [rtssColor, setRtssColor] = useState('00FF8000');
  const [rtssGraph, setRtssGraph] = useState(false);
  const [rtssGraphMax, setRtssGraphMax] = useState(50);
  const [launchingRtss, setLaunchingRtss] = useState(false);
  // 播放音乐时默认显示歌词（默认关，只有显式存过 "1" 才开）
  const [lyricsAutoShow, setLyricsAutoShow] = useState(false);
  const [fetchingCovers, setFetchingCovers] = useState(false);
  const [fetchProgress, setFetchProgress] = useState<{ done: number; total: number; ok: number; fail: number } | null>(null);
  const [fetchResult, setFetchResult] = useState<string | null>(null); // 完成结果（内联显示，不弹窗）
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
  // 整页滚动容器（右摇杆滚动目标）
  const scrollRef = useRef<HTMLDivElement>(null);
  // 右摇杆滚动目标：设置页整页滚动
  useRightStickScroll(scrollRef);
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
    api.getSetting('steamgriddb_api_key').then((v) => setSgdbKey(v || '')).catch(() => {});
    api.getSetting('tmdb_api_key').then((v) => setTmdbKey(v || '')).catch(() => {});
    api.getSetting('player_path').then((v) => setPlayerPath(v || '')).catch(() => {});
    // 未设置时默认全屏，只有显式存过 "0" 才是关
    api.getSetting('player_fullscreen').then((v) => setPlayerFullscreen(v !== '0')).catch(() => {});
    api.getSetting('player_engine').then((v) => setEngine(v === 'external' ? 'external' : 'mpv')).catch(() => {});
    api.getSetting('mpv_hwdec').then((v) => setHwdec(v !== 'no')).catch(() => {});
    api.getSetting('mpv_hdr').then((v) => setHdr(v !== '0')).catch(() => {});
    // 手柄开关：默认开，只有显式存过 "0" 才关（与播放设置同款约定）
    api.getSetting('gamepad_enabled').then((v) => {
      const on = v !== '0';
      setGamepadEnabled(on);
      setGamepadEnabledState(on);
    }).catch(() => {});
    // 西瓜键唤起：默认关，只有显式存过 "1" 才开
    api.getSetting('guide_button_enabled').then((v) => setGuideBtn(v === '1')).catch(() => {});
    // PS logo 键唤起：默认关，只有显式存过 "1" 才开
    api.getSetting('ps_button_enabled').then((v) => setPsBtn(v === '1')).catch(() => {});
    // 开机自启：读注册表为权威（外部清理/备份恢复后库里旧值不作数）；
    // 自启方式读库（仅自启开启时有效，未存过默认驻留托盘）
    api.isAutostartEnabled().then(setAutostartState).catch(() => {});
    api.getSetting('autostart_show_window').then((v) => setAutostartShow(v === '1')).catch(() => {});
    api.mpvAvailable().then(setMpvOk).catch(() => {});
    // 播放音乐时默认显示歌词：默认关，只有显式存过 "1" 才开
    api.getSetting('lyrics_auto_show').then((v) => setLyricsAutoShow(v === '1')).catch(() => {});
    // RTSS 帧数 OSD 全局默认（游戏级在右键菜单读写该游戏 profile）
    api.rtssStatus().then((s) => setRtss({ installed: s.installed, running: s.running })).catch(() => {});
    api.getSetting('rtss_osd_enabled').then((v) => setRtssEnabled(v === '1')).catch(() => {});
    api.getSetting('rtss_osd_position').then((v) => setRtssPosition(Number(v) || 1)).catch(() => {});
    api.getSetting('rtss_osd_zoom').then((v) => setRtssZoom(Number(v) || 2)).catch(() => {});
    api.getSetting('rtss_osd_color').then((v) => setRtssColor(v || '00FF8000')).catch(() => {});
    api.getSetting('rtss_osd_graph').then((v) => setRtssGraph(v === '1')).catch(() => {});
    api.getSetting('rtss_osd_graph_max').then((v) => setRtssGraphMax(Number(v) || 50)).catch(() => {});
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

  // ── 手柄：设置页整体行导航 ──────────────────────
  // 上下键在设置项行之间移动，左右键在行内 chips 间切换，A 触发按钮行
  const themeRows = [
    { value: 'light' as const, icon: Sun, label: 'settings.themeLight' },
    { value: 'dark' as const, icon: Moon, label: 'settings.themeDark' },
    { value: 'system' as const, icon: Monitor, label: 'settings.themeSystem' },
  ];

  const focusedRow = useFocusIndex('settings:rows');

  // 自启方式行（编号 3）仅在开机自启开启时渲染 → 自启关闭时其后的所有行在
  // rows 数组中的索引会少 1。JSX 的 data-settings-row 编号据此偏移，保证
  // 数组索引 ↔ DOM 编号在两种状态下都一一对应（否则手柄焦点整体错位一格）
  const rowOffset = autostart ? 0 : -1;

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

  interface SettingRow {
    chips?: { active: () => boolean; set: () => void }[];
    onLeftRight?: (dir: 'left' | 'right') => void;
    onA?: () => void;
  }
  // 顺序与 JSX 的 data-settings-row 编号一致（自启方式条件行后的编号用 rowOffset 对齐）；
  // chips 的 set/onA 用箭头延迟调用，避免 TDZ
  const rows: SettingRow[] = [
    { chips: themeRows.map((t) => ({ active: () => theme === t.value, set: () => setTheme(t.value) })) },
    // 语言（row 1）：中文 / English 两个 chip，手柄左右循环切换
    { chips: LANGUAGES.map((l) => ({ active: () => lang === l.code, set: () => setLang(l.code) })) },
    { onLeftRight: (dir) => setGameColumns(gameColumns + (dir === 'right' ? 1 : -1)) },
    // 开机自启（2）+ 自启方式（3，仅自启开启时渲染，复用播放引擎的条件行模式）
    {
      chips: [
        { active: () => !autostart, set: () => switchAutostart(false) },
        { active: () => autostart, set: () => switchAutostart(true) },
      ],
    },
    ...(autostart
      ? [{
          chips: [
            { active: () => !autostartShow, set: () => switchAutostartShow(false) },
            { active: () => autostartShow, set: () => switchAutostartShow(true) },
          ],
        }]
      : []),
    {
      chips: [
        { active: () => engine === 'mpv', set: () => switchEngine('mpv') },
        { active: () => engine === 'external', set: () => switchEngine('external') },
      ],
    },
    ...(engine === 'mpv'
      ? [
          {
            chips: [
              { active: () => !hwdec, set: () => switchHwdec(false) },
              { active: () => hwdec, set: () => switchHwdec(true) },
            ],
          },
          {
            chips: [
              { active: () => !hdr, set: () => switchHdr(false) },
              { active: () => hdr, set: () => switchHdr(true) },
            ],
          },
        ]
      : [
          { onA: () => handleBrowsePlayer() },
          {
            chips: [
              { active: () => playerFullscreen, set: () => switchFullscreen(true) },
              { active: () => !playerFullscreen, set: () => switchFullscreen(false) },
            ],
          },
        ]),
    // 播放音乐时默认显示歌词（与影视引擎无关，恒渲染在播放区末尾）
    {
      chips: [
        { active: () => !lyricsAutoShow, set: () => switchLyricsAutoShow(false) },
        { active: () => lyricsAutoShow, set: () => switchLyricsAutoShow(true) },
      ],
    },
    {
      chips: [
        { active: () => !gamepadEnabled, set: () => switchGamepad(false) },
        { active: () => gamepadEnabled, set: () => switchGamepad(true) },
      ],
    },
    {
      chips: [
        { active: () => !guideBtn, set: () => switchGuideBtn(false) },
        { active: () => guideBtn, set: () => switchGuideBtn(true) },
      ],
    },
    {
      chips: [
        { active: () => !psBtn, set: () => switchPsBtn(false) },
        { active: () => psBtn, set: () => switchPsBtn(true) },
      ],
    },
    { onA: () => handleFetchAllCovers() },
    { onA: () => handleExport() },
    { onA: () => handleImport() },
    { onA: () => handleClearAllData() },
    libRow('games'),
    libRow('series'),
    libRow('music'),
    libRow('stats'),
    // RTSS 帧数 OSD（性能区；编号 20+ 与 JSX data-settings-row 对齐，手柄导航贯穿）
    {
      chips: [
        { active: () => !rtssEnabled, set: () => switchRtssEnabled(false) },
        { active: () => rtssEnabled, set: () => switchRtssEnabled(true) },
      ],
    },
    {
      chips: [1, 2, 3, 4].map((p) => ({
        active: () => rtssPosition === p,
        set: () => switchRtssPosition(p),
      })),
    },
    { onLeftRight: (dir) => switchRtssZoom(dir) },
    {
      chips: RTSS_COLORS.map((c) => ({
        active: () => rtssColor === c.value,
        set: () => switchRtssColor(c.value),
      })),
    },
    {
      chips: [
        { active: () => !rtssGraph, set: () => switchRtssGraph(false) },
        { active: () => rtssGraph, set: () => switchRtssGraph(true) },
      ],
    },
    { onLeftRight: (dir) => switchRtssGraphMax(dir) },
    // RTSS 状态行：已安装 → 启动/停止；缺失 → 打开下载页
    { onA: () => { if (rtss.installed) void launchRtss(); else void api.rtssOpenDownloadPage().catch(() => {}); } },
  ];

  useGamepadGroup('settings:rows', {
    count: rows.length,
    cols: 1,
    scrollIntoView: (i) => document.querySelector(`[data-settings-row="${i}"]`)?.scrollIntoView({ block: 'nearest' }),
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
      return false;
    },
  });

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

  // RTSS 帧数 OSD：全局默认设置（新游戏首次启用时的初始值；改的是 settings 表，
  // 不直接动游戏 profile —— 游戏级开关在右键菜单读写 <exe>.cfg）
  const saveRtssSetting = (key: string, value: string) => {
    void api.setSetting(key, value).catch((err: any) => {
      void message(t('common.saveFailed', { msg: err.message }), { title: t('common.error'), kind: 'error' });
    });
  };
  const switchRtssEnabled = (v: boolean) => {
    setRtssEnabled(v);
    saveRtssSetting('rtss_osd_enabled', v ? '1' : '0');
  };
  const switchRtssPosition = (v: number) => {
    setRtssPosition(v);
    saveRtssSetting('rtss_osd_position', String(v));
  };
  const switchRtssZoom = (dir: 'left' | 'right') => {
    const v = Math.min(8, Math.max(1, rtssZoom + (dir === 'right' ? 1 : -1)));
    setRtssZoom(v);
    saveRtssSetting('rtss_osd_zoom', String(v));
  };
  const switchRtssColor = (v: string) => {
    setRtssColor(v);
    saveRtssSetting('rtss_osd_color', v);
  };
  const switchRtssGraph = (v: boolean) => {
    setRtssGraph(v);
    saveRtssSetting('rtss_osd_graph', v ? '1' : '0');
  };
  const switchRtssGraphMax = (dir: 'left' | 'right') => {
    const v = Math.min(200, Math.max(10, rtssGraphMax + (dir === 'right' ? 10 : -10)));
    setRtssGraphMax(v);
    saveRtssSetting('rtss_osd_graph_max', String(v));
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
      await api.clearAllData();
      await Promise.all([loadGames(), loadSeries(), loadTracks(), loadPlaylists()]);
      await message(t('settings.cleared'), { title: t('common.success'), kind: 'info' });
    } catch (err: any) {
      await message(t('settings.clearFailed', { msg: err.message }), { title: t('common.error'), kind: 'error' });
    } finally {
      setClearing(false);
    }
  };

  return (
    <>
    <div ref={scrollRef} className="h-full overflow-y-auto">
      <div className="px-5 py-4 max-w-4xl mx-auto">
      <h1 className="text-xl font-bold mb-5 flex items-center gap-2">
        <SettingsIcon size={22} className="text-[#00d4ff]" />
        {t('settings.title')}
      </h1>

      {/* Appearance */}
      <section className="mb-6">
        <h2 className="text-sm font-semibold text-text-tertiary uppercase tracking-widest mb-3">{t('settings.appearance')}</h2>
        <div className="glass-card overflow-hidden">

          {/* Theme */}
          <div className={clsx('flex items-center justify-between px-5 py-3', focusedRow === 0 && 'settings-row-focus')} data-settings-row={0}>
            <div>
              <p className="text-sm font-medium mb-0.5">{t('settings.theme')}</p>
              <p className="text-xs text-text-secondary">{t('settings.themeDesc')}</p>
            </div>
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
          </div>

          {/* 语言（row 1）：chips 手柄左右可切，切换立即生效并落库 */}
          <div className={clsx('flex items-center justify-between px-5 py-3 border-t border-border-glass', focusedRow === 1 && 'settings-row-focus')} data-settings-row={1}>
            <div>
              <p className="text-sm font-medium mb-0.5">{t('settings.language')}</p>
              <p className="text-xs text-text-secondary">{t('settings.languageDesc')}</p>
            </div>
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
          </div>

          {/* 游戏库每行数量 */}
          <div className={clsx('flex items-center justify-between gap-4 px-6 py-5 border-t border-border-glass', focusedRow === 2 && 'settings-row-focus')} data-settings-row={2}>
            <div>
              <p className="text-sm font-medium mb-0.5">{t('settings.gameColumnsTitle')}</p>
              <p className="text-xs text-text-secondary">{t('settings.gameColumnsDesc')}</p>
            </div>
            <div className="flex items-center gap-5 shrink-0">
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
          </div>
        </div>
      </section>

      {/* 启动 */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-text-tertiary uppercase tracking-widest mb-4">{t('settings.sectionStartup')}</h2>
        <div className="glass-card overflow-hidden">
          <div className={clsx('flex items-center justify-between gap-6 px-6 py-5', focusedRow === 3 && 'settings-row-focus')} data-settings-row={3}>
            <div className="pr-4">
              <p className="text-sm font-medium mb-0.5 flex items-center gap-2">
                <Power size={14} className="text-text-tertiary" />
                {t('settings.autostart')}
              </p>
              <p className="text-xs text-text-secondary leading-relaxed">
                {t('settings.autostartDesc')}
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button className={clsx('chip', !autostart && 'active')} onClick={() => switchAutostart(false)}>{t('common.off')}</button>
              <button className={clsx('chip', autostart && 'active')} onClick={() => switchAutostart(true)}>{t('common.on')}</button>
            </div>
          </div>

          {autostart && (
            <div className={clsx('flex items-center justify-between gap-6 px-6 py-5 border-t border-border-glass', focusedRow === 4 && 'settings-row-focus')} data-settings-row={4}>
              <div className="pr-4">
                <p className="text-sm font-medium mb-0.5">{t('settings.autostartMethod')}</p>
                <p className="text-xs text-text-secondary leading-relaxed">
                  {autostartShow
                    ? t('settings.autostartShowDesc')
                    : t('settings.autostartTrayDesc')}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button className={clsx('chip', !autostartShow && 'active')} onClick={() => switchAutostartShow(false)}>{t('settings.autostartTray')}</button>
                <button className={clsx('chip', autostartShow && 'active')} onClick={() => switchAutostartShow(true)}>{t('settings.autostartShow')}</button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Player */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-text-tertiary uppercase tracking-widest mb-4">{t('settings.sectionPlayback')}</h2>
        <div className="glass-card overflow-hidden">
          <div className={clsx('px-5 pt-4 pb-3', focusedRow === 5 + rowOffset && 'settings-row-focus')} data-settings-row={5 + rowOffset}>
            <div className="flex items-center gap-2.5 mb-2">
              <MonitorPlay size={15} className="text-[#00d4ff]" />
              <p className="text-sm font-medium">{t('settings.engine')}</p>
            </div>
            <p className="text-xs text-text-secondary mb-2.5 leading-snug">
              {t('settings.engineDesc')}
            </p>
            <div className="flex items-center gap-1.5">
              <button className={clsx('chip', engine === 'mpv' && 'active')} onClick={() => switchEngine('mpv')}>
                {t('settings.engineMpv')}
              </button>
              <button className={clsx('chip', engine === 'external' && 'active')} onClick={() => switchEngine('external')}>
                {t('settings.engineExternal')}
              </button>
            </div>
            {!mpvOk && (
              <p className="mt-3 flex items-start gap-2 text-xs text-[#ffc94d] leading-snug">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                {t('settings.mpvMissingPre')}{' '}
                <code className="px-1 rounded bg-bg-surface-active">bash scripts/fetch-mpv.sh</code>
                {' '}{t('settings.mpvMissingPost')}
              </p>
            )}
          </div>

          {engine === 'mpv' ? (
            <>
              <div className={clsx('flex items-center justify-between px-6 py-5 border-t border-border-glass', focusedRow === 6 + rowOffset && 'settings-row-focus')} data-settings-row={6 + rowOffset}>
                <div className="pr-4">
                  <p className="text-sm font-medium mb-0.5 flex items-center gap-2">
                    <Cpu size={14} className="text-text-tertiary" />
                    {t('settings.hwdec')}
                  </p>
                  <p className="text-xs text-text-secondary leading-snug">
                    {t('settings.hwdecDesc')}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button className={clsx('chip', !hwdec && 'active')} onClick={() => switchHwdec(false)}>{t('common.off')}</button>
                  <button className={clsx('chip', hwdec && 'active')} onClick={() => switchHwdec(true)}>{t('common.on')}</button>
                </div>
              </div>

              <div className={clsx('flex items-center justify-between px-6 py-5 border-t border-border-glass', focusedRow === 7 + rowOffset && 'settings-row-focus')} data-settings-row={7 + rowOffset}>
                <div className="pr-4">
                  <p className="text-sm font-medium mb-0.5">{t('settings.hdr')}</p>
                  <p className="text-xs text-text-secondary leading-relaxed">
                    {t('settings.hdrDesc')}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button className={clsx('chip', !hdr && 'active')} onClick={() => switchHdr(false)}>{t('common.off')}</button>
                  <button className={clsx('chip', hdr && 'active')} onClick={() => switchHdr(true)}>{t('common.on')}</button>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className={clsx('px-6 py-5 border-t border-border-glass', focusedRow === 6 + rowOffset && 'settings-row-focus')} data-settings-row={6 + rowOffset}>
                <p className="text-sm font-medium mb-0.5">{t('settings.playerPath')}</p>
                <p className="text-xs text-text-secondary mb-2 leading-snug">
                  {t('settings.playerPathDesc')}
                </p>
                <div className="flex gap-2">
                  <input
                    value={playerPath}
                    onChange={(e) => setPlayerPath(e.target.value)}
                    onBlur={savePlayerPath}
                    placeholder={t('settings.playerPathPlaceholder')}
                    className="input flex-1 text-sm"
                  />
                  <button onClick={handleBrowsePlayer} className="btn btn-glass gap-2 text-sm px-4 shrink-0">
                    <FolderOpen size={14} />
                    {t('settings.browse')}
                  </button>
                </div>
              </div>

              <div className={clsx('flex items-center justify-between px-6 py-5 border-t border-border-glass', focusedRow === 7 + rowOffset && 'settings-row-focus')} data-settings-row={7 + rowOffset}>
                <div className="pr-4">
                  <p className="text-sm font-medium mb-0.5">{t('settings.fullscreen')}</p>
                  <p className="text-xs text-text-secondary leading-relaxed">
                    {t('settings.fullscreenDesc')}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button className={clsx('chip', playerFullscreen && 'active')} onClick={() => switchFullscreen(true)}>
                    {t('settings.fullscreenOn')}
                  </button>
                  <button className={clsx('chip', !playerFullscreen && 'active')} onClick={() => switchFullscreen(false)}>
                    {t('settings.windowed')}
                  </button>
                </div>
              </div>
            </>
          )}

          {/* 播放音乐时默认显示歌词（恒渲染：音乐播放走内置 mpv，与影视引擎无关） */}
          <div className={clsx('flex items-center justify-between gap-6 px-6 py-5 border-t border-border-glass', focusedRow === 8 + rowOffset && 'settings-row-focus')} data-settings-row={8 + rowOffset}>
            <div className="pr-4">
              <p className="text-sm font-medium mb-0.5">{t('settings.lyricsAutoShow')}</p>
              <p className="text-xs text-text-secondary leading-relaxed">
                {t('settings.lyricsAutoShowDesc')}
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button className={clsx('chip', !lyricsAutoShow && 'active')} onClick={() => switchLyricsAutoShow(false)}>{t('common.off')}</button>
              <button className={clsx('chip', lyricsAutoShow && 'active')} onClick={() => switchLyricsAutoShow(true)}>{t('common.on')}</button>
            </div>
          </div>
        </div>
      </section>

      {/* 手柄 */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-text-tertiary uppercase tracking-widest mb-4">{t('settings.sectionGamepad')}</h2>
        <div className="glass-card overflow-hidden">
          <div className={clsx('flex items-center justify-between gap-6 px-6 py-5', focusedRow === 9 + rowOffset && 'settings-row-focus')} data-settings-row={9 + rowOffset}>
            <div>
              <p className="text-sm font-medium flex items-center gap-2">
                <Gamepad2 size={14} className="text-text-tertiary" />
                {t('settings.gamepadSupport')}
              </p>
              <p className="text-xs text-text-secondary mt-0.5 leading-snug">
                {t('settings.gamepadSupportDesc')}
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button className={clsx('chip', !gamepadEnabled && 'active')} onClick={() => switchGamepad(false)}>{t('common.off')}</button>
              <button className={clsx('chip', gamepadEnabled && 'active')} onClick={() => switchGamepad(true)}>{t('common.on')}</button>
            </div>
          </div>

          {/* 西瓜键唤起开关（默认关）：开时写入注册表关掉 Game Bar 抢键 */}
          <div className={clsx('flex items-center justify-between gap-6 px-6 py-5 border-t border-border-glass', focusedRow === 10 + rowOffset && 'settings-row-focus')} data-settings-row={10 + rowOffset}>
            <div className="pr-4">
              <p className="text-sm font-medium mb-0.5 flex items-center gap-2">
                <Gamepad2 size={14} className="text-text-tertiary" />
                {t('settings.guideBtn')}
              </p>
              <p className="text-xs text-text-secondary leading-relaxed">
                {t('settings.guideBtnDesc')}
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button className={clsx('chip', !guideBtn && 'active')} onClick={() => switchGuideBtn(false)}>{t('common.off')}</button>
              <button className={clsx('chip', guideBtn && 'active')} onClick={() => switchGuideBtn(true)}>{t('common.on')}</button>
            </div>
          </div>

          {/* PS logo 键唤起开关（默认关）：HID 报文直读，独立开关，不涉及 Game Bar */}
          <div className={clsx('flex items-center justify-between gap-6 px-6 py-5 border-t border-border-glass', focusedRow === 11 + rowOffset && 'settings-row-focus')} data-settings-row={11 + rowOffset}>
            <div className="pr-4">
              <p className="text-sm font-medium mb-0.5 flex items-center gap-2">
                <Gamepad2 size={14} className="text-text-tertiary" />
                {t('settings.psBtn')}
              </p>
              <p className="text-xs text-text-secondary leading-relaxed">
                {t('settings.psBtnDesc')}
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button className={clsx('chip', !psBtn && 'active')} onClick={() => switchPsBtn(false)}>{t('common.off')}</button>
              <button className={clsx('chip', psBtn && 'active')} onClick={() => switchPsBtn(true)}>{t('common.on')}</button>
            </div>
          </div>

          {/* 连接状态（只读，随插拔实时刷新） */}
          <div className="flex items-center gap-2.5 px-5 py-3 border-t border-border-glass text-xs">
            <Gamepad2 size={14} className={pads.length > 0 ? 'text-[#00d4ff]' : 'text-text-tertiary'} />
            {pads.length > 0 ? (
              <span className="text-text-secondary">{t('settings.padsConnected', { list: pads.map((p) => p.name).join(t('settings.padsJoinSep')) })}</span>
            ) : (
              <span className="text-text-tertiary">{t('settings.padsNone')}</span>
            )}
          </div>
        </div>
      </section>

      {/* Covers */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-text-tertiary uppercase tracking-widest mb-4">{t('settings.sectionCovers')}</h2>
        <div className="glass-card p-5 overflow-hidden">
          <div className="flex items-center gap-2.5 mb-2">
            <KeyRound size={15} className="text-[#00d4ff]" />
            <p className="text-sm font-medium">SteamGridDB API Key</p>
          </div>
          <p className="text-xs text-text-secondary mb-4 leading-relaxed">
            {t('settings.sgdbDesc')}
          </p>
          <div className="flex gap-2">
            <input
              value={sgdbKey}
              onChange={(e) => setSgdbKey(e.target.value)}
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

          <div className="flex items-center gap-2.5 mb-2 mt-6">
            <KeyRound size={15} className="text-[#00d4ff]" />
            <p className="text-sm font-medium">TMDB API Key</p>
          </div>
          <p className="text-xs text-text-secondary mb-4 leading-relaxed">
            {t('settings.tmdbDesc')}
          </p>
          <div className="flex gap-2">
            <input
              value={tmdbKey}
              onChange={(e) => setTmdbKey(e.target.value)}
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

          {/* Steam CDN 补封面（手动触发，导入保持零网络） */}
          {/* 获取缺失封面：行 + 进度条 + 结果整体作为焦点行，蓝底/竖线随高度实时伸缩 */}
          <div className={clsx('mt-5 py-3.5 border-t border-border-glass -mx-5 px-5 -mb-5', focusedRow === 12 + rowOffset && 'settings-row-focus')} data-settings-row={12 + rowOffset}>
            <div className="flex items-center justify-between">
              <div className="pr-4">
                <p className="text-sm font-medium mb-0.5">{t('settings.fetchCovers')}</p>
                <p className="text-xs text-text-secondary leading-relaxed">
                  {t('settings.fetchCoversDesc')}
                </p>
              </div>
              <button
                onClick={handleFetchAllCovers}
                disabled={fetchingCovers}
                className="btn btn-glass gap-2 text-sm shrink-0"
              >
                {fetchingCovers && <Loader2 size={14} className="animate-spin" />}
                {fetchingCovers ? t('settings.fetching') : t('settings.fetchCoversBtn')}
              </button>
            </div>
            {fetchingCovers && fetchProgress && fetchProgress.total > 0 && (
              <div className="mt-3">
                {/* 进度条：每完成一个游戏走一格，宽度过渡让跳动平滑 */}
                <div className="h-1.5 rounded-full bg-bg-surface-active overflow-hidden">
                  <div
                    className="h-full rounded-full bg-[#00d4ff] transition-all duration-300"
                    style={{ width: `${Math.round((fetchProgress.done / fetchProgress.total) * 100)}%` }}
                  />
                </div>
                <p className="text-xs text-text-secondary mt-2">
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
              <p className={clsx('text-xs mt-3', fetchFailed ? 'text-danger' : 'text-text-secondary')}>
                {fetchResult}
              </p>
            )}
          </div>
        </div>
      </section>

      {/* Data */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-text-tertiary uppercase tracking-widest mb-4">{t('settings.sectionData')}</h2>
        <div className="glass-card overflow-hidden">
          <div className={clsx('flex items-center justify-between px-6 py-5 border-b border-border-glass', focusedRow === 13 + rowOffset && 'settings-row-focus')} data-settings-row={13 + rowOffset}>
            <div>
              <p className="text-sm font-medium mb-0.5">{t('settings.exportData')}</p>
              <p className="text-xs text-text-secondary">{t('settings.exportDesc')}</p>
            </div>
            <button
              onClick={handleExport}
              disabled={exporting}
              className="btn btn-glass gap-2 text-sm"
            >
              <Download size={15} />
              {exporting ? t('settings.exporting') : t('settings.exportBtn')}
            </button>
          </div>
          <div className={clsx('flex items-center justify-between px-6 py-5 border-b border-border-glass', focusedRow === 14 + rowOffset && 'settings-row-focus')} data-settings-row={14 + rowOffset}>
            <div>
              <p className="text-sm font-medium mb-0.5">{t('settings.importData')}</p>
              <p className="text-xs text-text-secondary">{t('settings.importDesc')}</p>
            </div>
            <button
              onClick={handleImport}
              disabled={importing}
              className="btn btn-glass gap-2 text-sm"
            >
              <Upload size={15} />
              {importing ? t('settings.importing') : t('settings.importBtn')}
            </button>
          </div>
          <div className={clsx('flex items-center justify-between px-6 py-5', focusedRow === 15 + rowOffset && 'settings-row-focus')} data-settings-row={15 + rowOffset}>
            <div>
              <p className="text-sm font-medium text-danger mb-0.5">{t('settings.clearData')}</p>
              <p className="text-xs text-text-secondary">{t('settings.clearDesc')}</p>
            </div>
            <button
              onClick={handleClearAllData}
              disabled={clearing}
              className="btn btn-danger gap-2 text-sm"
            >
              <Trash2 size={15} />
              {clearing ? t('settings.clearing') : t('settings.clearBtn')}
            </button>
          </div>
        </div>
      </section>

      {/* 库 */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-text-tertiary uppercase tracking-widest mb-4">{t('settings.sectionLibs')}</h2>
        <div className="glass-card overflow-hidden">
          {([
            { id: 'games' as const, name: 'nav.games' },
            { id: 'series' as const, name: 'nav.series' },
            { id: 'music' as const, name: 'nav.music' },
            { id: 'stats' as const, name: 'nav.stats' },
          ]).map((lib, i) => (
            <div
              key={lib.id}
              className={clsx('flex items-center justify-between gap-6 px-6 py-4', i > 0 && 'border-t border-border-glass', focusedRow === 16 + i + rowOffset && 'settings-row-focus')}
              data-settings-row={16 + i + rowOffset}
            >
              <p className="text-sm font-medium">{t(lib.name)}</p>
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
            </div>
          ))}
          <div className="px-5 py-2.5 border-t border-border-glass text-xs text-text-tertiary leading-snug">
            {t('settings.libsNote')}
            <br />
            {hiddenLibraries.includes('series') && hiddenLibraries.includes('music')
              ? t('settings.libsMpvOff')
              : t('settings.libsMpvNote')}
          </div>
        </div>
      </section>

      {/* 软件标识：自定义顶部封面与名称（空 = 默认 ZEX / 内置 logo） */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-text-tertiary uppercase tracking-widest mb-4">{t('settings.sectionBrand')}</h2>
        <div className="glass-card overflow-hidden">
          <div className={clsx('flex items-center justify-between gap-6 px-6 py-5')}>
            <div className="pr-4">
              <p className="text-sm font-medium mb-0.5">{t('settings.brandName')}</p>
              <p className="text-xs text-text-secondary leading-snug">
                {t('settings.brandNameDesc')}
              </p>
            </div>
            <input
              type="text"
              value={brandNameInput}
              onChange={(e) => setBrandNameInput(e.target.value)}
              onBlur={() => void saveBrandName(brandNameInput)}
              placeholder="ZEX"
              maxLength={30}
              className="input flex-1 text-sm shrink-0 max-w-[260px]"
            />
          </div>
          <div className={clsx('flex items-center justify-between gap-6 px-6 py-5 border-t border-border-glass')}>
            <div className="pr-4">
              <p className="text-sm font-medium mb-0.5">{t('settings.brandCover')}</p>
              <p className="text-xs text-text-secondary leading-snug">
                {t('settings.brandCoverDesc')}
              </p>
            </div>
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
          </div>
        </div>
      </section>

      {/* 性能：RTSS 帧数 OSD（全局默认；游戏级开关在游戏右键菜单） */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-text-tertiary uppercase tracking-widest mb-4">{t('settings.sectionPerf')}</h2>
        <div className="glass-card overflow-hidden">
          <div className={clsx('flex items-center justify-between px-6 py-5', focusedRow === 20 + rowOffset && 'settings-row-focus')} data-settings-row={20 + rowOffset}>
            <div className="pr-4">
              <p className="text-sm font-medium mb-0.5">{t('settings.rtssOsd')}</p>
              <p className="text-xs text-text-secondary leading-snug">{t('settings.rtssOsdDesc')}</p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button className={clsx('chip', !rtssEnabled && 'active')} onClick={() => switchRtssEnabled(false)}>
                {t('common.off')}
              </button>
              <button className={clsx('chip', rtssEnabled && 'active')} onClick={() => switchRtssEnabled(true)}>
                {t('common.on')}
              </button>
            </div>
          </div>

          <div className={clsx('flex items-center justify-between px-6 py-5 border-t border-border-glass', focusedRow === 21 + rowOffset && 'settings-row-focus')} data-settings-row={21 + rowOffset}>
            <div className="pr-4">
              <p className="text-sm font-medium mb-0.5">{t('settings.rtssOsdPosition')}</p>
              <p className="text-xs text-text-secondary leading-snug">{t('settings.rtssOsdPositionDesc')}</p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {[1, 2, 3, 4].map((p) => (
                <button key={p} className={clsx('chip', rtssPosition === p && 'active')} onClick={() => switchRtssPosition(p)}>
                  {p}
                </button>
              ))}
            </div>
          </div>

          <div className={clsx('flex items-center justify-between px-6 py-5 border-t border-border-glass', focusedRow === 22 + rowOffset && 'settings-row-focus')} data-settings-row={22 + rowOffset}>
            <div className="pr-4">
              <p className="text-sm font-medium mb-0.5">{t('settings.rtssOsdZoom')}</p>
              <p className="text-xs text-text-secondary leading-snug">{t('settings.rtssOsdZoomDesc')}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button className="chip" onClick={() => switchRtssZoom('left')} disabled={rtssZoom <= 1}>
                <Minus size={13} />
              </button>
              <span className="text-sm font-semibold w-6 text-center">{rtssZoom}</span>
              <button className="chip" onClick={() => switchRtssZoom('right')} disabled={rtssZoom >= 8}>
                <Plus size={13} />
              </button>
            </div>
          </div>

          <div className={clsx('flex items-center justify-between px-6 py-5 border-t border-border-glass', focusedRow === 23 + rowOffset && 'settings-row-focus')} data-settings-row={23 + rowOffset}>
            <div className="pr-4">
              <p className="text-sm font-medium mb-0.5">{t('settings.rtssOsdColor')}</p>
              <p className="text-xs text-text-secondary leading-snug">{t('settings.rtssOsdColorDesc')}</p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {RTSS_COLORS.map((c) => (
                <button
                  key={c.value}
                  className={clsx('chip', rtssColor === c.value && 'active')}
                  onClick={() => switchRtssColor(c.value)}
                >
                  <span
                    className="inline-block w-3 h-3 rounded-full mr-1.5 align-middle"
                    style={{ backgroundColor: `#${c.value.slice(2)}` }}
                  />
                  {t(c.labelKey)}
                </button>
              ))}
            </div>
          </div>

          <div className={clsx('flex items-center justify-between px-6 py-5 border-t border-border-glass', focusedRow === 24 + rowOffset && 'settings-row-focus')} data-settings-row={24 + rowOffset}>
            <div className="pr-4">
              <p className="text-sm font-medium mb-0.5">{t('settings.rtssOsdGraph')}</p>
              <p className="text-xs text-text-secondary leading-snug">{t('settings.rtssOsdGraphDesc')}</p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button className={clsx('chip', !rtssGraph && 'active')} onClick={() => switchRtssGraph(false)}>
                {t('common.off')}
              </button>
              <button className={clsx('chip', rtssGraph && 'active')} onClick={() => switchRtssGraph(true)}>
                {t('common.on')}
              </button>
            </div>
          </div>

          <div className={clsx('flex items-center justify-between px-6 py-5 border-t border-border-glass', focusedRow === 25 + rowOffset && 'settings-row-focus')} data-settings-row={25 + rowOffset}>
            <div className="pr-4">
              <p className="text-sm font-medium mb-0.5">{t('settings.rtssOsdGraphMax')}</p>
              <p className="text-xs text-text-secondary leading-snug">{t('settings.rtssOsdGraphMaxDesc')}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button className="chip" onClick={() => switchRtssGraphMax('left')} disabled={rtssGraphMax <= 10}>
                <Minus size={13} />
              </button>
              <span className="text-sm font-semibold w-10 text-center">{rtssGraphMax} ms</span>
              <button className="chip" onClick={() => switchRtssGraphMax('right')} disabled={rtssGraphMax >= 200}>
                <Plus size={13} />
              </button>
            </div>
          </div>

          {/* RTSS 状态行：已安装 → 启动；缺失 → 打开下载页 */}
          <div className={clsx('flex items-center justify-between px-6 py-5 border-t border-border-glass', focusedRow === 26 + rowOffset && 'settings-row-focus')} data-settings-row={26 + rowOffset}>
            <div className="pr-4">
              <p className="text-sm font-medium mb-0.5">{t('settings.rtssStatus')}</p>
              <p className="text-xs text-text-secondary leading-snug">{t('settings.rtssStatusDesc')}</p>
              {!rtss.installed && (
                <p className="mt-2 flex items-start gap-2 text-xs text-[#ffc94d] leading-snug">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  {t('settings.rtssNotInstalled')}
                </p>
              )}
            </div>
            {rtss.installed ? (
              <button className="btn btn-glass gap-2 text-sm px-4 shrink-0" onClick={() => void launchRtss()} disabled={launchingRtss}>
                {launchingRtss ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
                {rtss.running ? t('settings.rtssRunning') : t('settings.rtssLaunchBtn')}
              </button>
            ) : (
              <button className="btn btn-glass gap-2 text-sm px-4 shrink-0" onClick={() => void api.rtssOpenDownloadPage().catch(() => {})}>
                <Download size={14} />
                {t('settings.rtssDownloadPage')}
              </button>
            )}
          </div>
        </div>
      </section>

      {/* About */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-text-tertiary uppercase tracking-widest mb-4">{t('settings.sectionAbout')}</h2>
        <div className="glass-card p-6">
          <div className="flex items-center gap-3 mb-4">
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
          <p className="text-sm text-text-secondary leading-relaxed mb-4">
            {t('settings.aboutText')}
          </p>
          <a
            href="https://github.com/Yuzexiaoyu/Zex"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-sm text-[#00d4ff]/70 hover:text-[#00d4ff] transition-colors"
          >
            <ExternalLink size={14} />
            {t('settings.github')}
          </a>
        </div>
      </section>
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
