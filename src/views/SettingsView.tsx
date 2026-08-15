import { useState, useEffect, useRef } from 'react';
import { Settings as SettingsIcon, Sun, Moon, Monitor, MonitorPlay, FolderOpen, Download, Upload, ExternalLink, KeyRound, Trash2, Loader2, Minus, Plus, Cpu, AlertTriangle, Gamepad2, X, Power, Image as ImageIcon } from 'lucide-react';
import zexLogo from '../assets/zex-logo.png';
import { coverSrc } from '../utils/media';
import { clsx } from 'clsx';
import * as api from '../api';
import { message, save, open } from '@tauri-apps/plugin-dialog';
import { useAppStore, MIN_GAME_COLUMNS, MAX_GAME_COLUMNS } from '../store';
import { setGamepadEnabled, isGamepadEnabled, useGamepadGroup, useFocusIndex, useRightStickScroll, useModalGamepad, getConnectedPads, onConnectedChange } from '../gamepad';
import type { ConnectedPad } from '../gamepad';

export default function SettingsView() {
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
  const [fetchingCovers, setFetchingCovers] = useState(false);
  const [fetchProgress, setFetchProgress] = useState<{ done: number; total: number; ok: number; fail: number } | null>(null);
  const [fetchResult, setFetchResult] = useState<string | null>(null); // 完成结果（内联显示，不弹窗）
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
  }, []);

  // 手柄开关即时保存（写库 + 同步给 Gamepad 服务）
  const switchGamepad = (v: boolean) => {
    setGamepadEnabledState(v);
    setGamepadEnabled(v);
    void api.setSetting('gamepad_enabled', v ? '1' : '0').catch((err: any) => {
      void message(`保存失败: ${err.message}`, { title: '错误', kind: 'error' });
    });
  };

  // 西瓜键唤起开关：即时保存（后端写库 + 注册表同步）。注册表失败时设置已生效于 ZEX，
  // 但 Game Bar 仍可能抢键，提示但不清除
  const switchGuideBtn = (v: boolean) => {
    setGuideBtn(v);
    void api.setGuideButtonEnabled(v).then((regOk) => {
      if (!regOk) {
        void message('设置已保存，但注册表写入失败：Game Bar 可能仍会抢占西瓜键，请稍后重试', { title: '警告', kind: 'warning' });
      }
    }).catch((err: any) => {
      setGuideBtn(!v); // 保存失败回滚
      void message(`保存失败: ${err.message}`, { title: '错误', kind: 'error' });
    });
  };

  // PS logo 键唤起开关：即时保存（写库 + 更新运行时标志，无注册表联动）
  const switchPsBtn = (v: boolean) => {
    setPsBtn(v);
    void api.setPsButtonEnabled(v).catch((err: any) => {
      setPsBtn(!v); // 保存失败回滚
      void message(`保存失败: ${err.message}`, { title: '错误', kind: 'error' });
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
          v ? '注册表写入失败，开机自启未生效' : '注册表删除失败，开机自启仍生效',
          { title: '警告', kind: 'warning' },
        );
      }
    }).catch((err: any) => {
      setAutostartState(!v);
      void message(`保存失败: ${err.message}`, { title: '错误', kind: 'error' });
    });
  };

  // 自启方式：驻留托盘 / 直接显示（仅自启开启时可切换，后端重写 Run 值带 --show-window）
  const switchAutostartShow = (v: boolean) => {
    setAutostartShow(v);
    void api.setAutostart(true, v).then((regOk) => {
      if (!regOk) {
        setAutostartShow(!v);
        void message('注册表写入失败，自启方式未生效', { title: '警告', kind: 'warning' });
      }
    }).catch((err: any) => {
      setAutostartShow(!v);
      void message(`保存失败: ${err.message}`, { title: '错误', kind: 'error' });
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
    { value: 'light' as const, icon: Sun, label: '浅色' },
    { value: 'dark' as const, icon: Moon, label: '深色' },
    { value: 'system' as const, icon: Monitor, label: '系统' },
  ];

  const focusedRow = useFocusIndex('settings:rows');

  // 自启方式行（编号 3）仅在开机自启开启时渲染 → 自启关闭时其后的所有行在
  // rows 数组中的索引会少 1。JSX 的 data-settings-row 编号据此偏移，保证
  // 数组索引 ↔ DOM 编号在两种状态下都一一对应（否则手柄焦点整体错位一格）
  const rowOffset = autostart ? 0 : -1;

  // 隐藏库：三个主库最多 2 个；统计页不占名额，可独立隐藏
  const tryHide = (id: 'games' | 'series' | 'music' | 'stats') => {
    if (id !== 'stats' && !hiddenLibraries.includes(id) && hiddenLibraries.filter((x) => x !== 'stats').length >= 2) {
      void message('最多隐藏 2 个库，至少保留 1 个库可见', { title: '提示', kind: 'info' });
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
    try {
      const res = await api.fetchAllSteamCovers();
      await loadGames();
      setFetchResult(
        res.total === 0
          ? '所有 Steam 游戏都已配置封面'
          : `完成：共处理 ${res.total} 个游戏，成功 ${res.ok} 张，失败 ${res.fail} 张`,
      );
    } catch (err: any) {
      setFetchResult(`获取失败：${err.message}`);
    } finally {
      setFetchingCovers(false);
    }
  };

  const handleSaveSgdbKey = async () => {
    setSavingKey(true);
    try {
      await api.setSetting('steamgriddb_api_key', sgdbKey.trim());
      await message('已保存，下次 Steam 扫描导入时生效', { title: '保存成功', kind: 'info' });
    } catch (err: any) {
      await message(`保存失败: ${err.message}`, { title: '错误', kind: 'error' });
    } finally {
      setSavingKey(false);
    }
  };

  const handleSaveTmdbKey = async () => {
    setSavingTmdbKey(true);
    try {
      await api.setSetting('tmdb_api_key', tmdbKey.trim());
      await message('已保存，添加影视或右键自动获取封面时生效', { title: '保存成功', kind: 'info' });
    } catch (err: any) {
      await message(`保存失败: ${err.message}`, { title: '错误', kind: 'error' });
    } finally {
      setSavingTmdbKey(false);
    }
  };

  const handleBrowsePlayer = async () => {
    const picked = await open({
      title: '选择播放器程序',
      multiple: false,
      directory: false,
      filters: [{ name: '程序', extensions: ['exe'] }],
    });
    if (typeof picked === 'string') setPlayerPath(picked);
  };

  // 播放设置即时保存：每次改动直接落库，不设保存按钮
  const savePlayerSetting = (key: string, value: string) => {
    void api.setSetting(key, value).catch((err: any) => {
      void message(`保存失败: ${err.message}`, { title: '错误', kind: 'error' });
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
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      });
      if (typeof selected !== 'string') return;
      const stored = await api.setBrandCover(selected);
      await saveBrandCover(stored);
    } catch (err) {
      alert(typeof err === 'string' ? err : '更换封面失败，请检查图片格式与大小');
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const path = await save({
        title: '导出数据',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        defaultPath: 'zex-backup.json',
      });
      if (!path) { setExporting(false); return; }
      const data = await api.exportData();
      const { writeTextFile } = await import('@tauri-apps/plugin-fs');
      await writeTextFile(path, data);
      await message(`数据已导出到: ${path}`, { title: '导出成功', kind: 'info' });
    } catch (err: any) {
      await message(`导出失败: ${err.message}`, { title: '错误', kind: 'error' });
    } finally {
      setExporting(false);
    }
  };

  const handleImport = async () => {
    setImporting(true);
    try {
      const path = await open({
        title: '导入数据',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        multiple: false,
      });
      if (!path) { setImporting(false); return; }
      const { readTextFile } = await import('@tauri-apps/plugin-fs');
      const data = await readTextFile(path as string);
      await api.importData(data);
      // 导入会整库替换：四大库 + 歌单全部重拉，避免界面残留导入前的旧数据
      await Promise.all([loadGames(), loadSeries(), loadTracks(), loadPlaylists()]);
      await message('数据导入成功！', { title: '成功', kind: 'info' });
    } catch (err: any) {
      await message(`导入失败: ${err.message}`, { title: '错误', kind: 'error' });
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
      await message('所有数据已清除', { title: '成功', kind: 'info' });
    } catch (err: any) {
      await message(`清除失败: ${err.message}`, { title: '错误', kind: 'error' });
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
        设置
      </h1>

      {/* Appearance */}
      <section className="mb-6">
        <h2 className="text-sm font-semibold text-text-tertiary uppercase tracking-widest mb-3">外观</h2>
        <div className="glass-card overflow-hidden">

          {/* Theme */}
          <div className={clsx('flex items-center justify-between px-5 py-3', focusedRow === 0 && 'settings-row-focus')} data-settings-row={0}>
            <div>
              <p className="text-sm font-medium mb-0.5">主题</p>
              <p className="text-xs text-text-secondary">浅色 / 深色 / 跟随系统</p>
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
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* 游戏库每行数量 */}
          <div className={clsx('flex items-center justify-between gap-4 px-6 py-5 border-t border-border-glass', focusedRow === 1 && 'settings-row-focus')} data-settings-row={1}>
            <div>
              <p className="text-sm font-medium mb-0.5">游戏库每行数量</p>
              <p className="text-xs text-text-secondary">调整封面网格的列数，拖动即时生效并自动记住</p>
            </div>
            <div className="flex items-center gap-5 shrink-0">
              <div className="grid-size-row w-[180px]">
                <button
                  className="grid-size-btn"
                  disabled={gameColumns <= MIN_GAME_COLUMNS}
                  onClick={() => setGameColumns(gameColumns - 1)}
                  title="减少一列"
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
                  title="增加一列"
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
        <h2 className="text-sm font-semibold text-text-tertiary uppercase tracking-widest mb-4">启动</h2>
        <div className="glass-card overflow-hidden">
          <div className={clsx('flex items-center justify-between gap-6 px-6 py-5', focusedRow === 2 && 'settings-row-focus')} data-settings-row={2}>
            <div className="pr-4">
              <p className="text-sm font-medium mb-0.5 flex items-center gap-2">
                <Power size={14} className="text-text-tertiary" />
                开机自启
              </p>
              <p className="text-xs text-text-secondary leading-relaxed">
                登录 Windows 后自动启动 ZEX。驻留托盘时后台照常累计时长与预热播放器，
                可用手柄 logo 键或托盘图标唤回（西瓜键 / PS 键需在「手柄」设置中开启）
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button className={clsx('chip', !autostart && 'active')} onClick={() => switchAutostart(false)}>关</button>
              <button className={clsx('chip', autostart && 'active')} onClick={() => switchAutostart(true)}>开</button>
            </div>
          </div>

          {autostart && (
            <div className={clsx('flex items-center justify-between gap-6 px-6 py-5 border-t border-border-glass', focusedRow === 3 && 'settings-row-focus')} data-settings-row={3}>
              <div className="pr-4">
                <p className="text-sm font-medium mb-0.5">自启方式</p>
                <p className="text-xs text-text-secondary leading-relaxed">
                  {autostartShow
                    ? '开机直接显示主窗口，与手动启动一致'
                    : '驻留系统托盘不弹窗口，后台照常记录与预热；点托盘图标或按手柄 logo 键唤回'}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button className={clsx('chip', !autostartShow && 'active')} onClick={() => switchAutostartShow(false)}>驻留托盘</button>
                <button className={clsx('chip', autostartShow && 'active')} onClick={() => switchAutostartShow(true)}>显示窗口</button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Player */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-text-tertiary uppercase tracking-widest mb-4">播放</h2>
        <div className="glass-card overflow-hidden">
          <div className={clsx('px-5 pt-4 pb-3', focusedRow === 4 + rowOffset && 'settings-row-focus')} data-settings-row={4 + rowOffset}>
            <div className="flex items-center gap-2.5 mb-2">
              <MonitorPlay size={15} className="text-[#00d4ff]" />
              <p className="text-sm font-medium">播放引擎</p>
            </div>
            <p className="text-xs text-text-secondary mb-2.5 leading-snug">
              内置 mpv 随 ZEX 打包，MKV / HEVC / AV1 / DTS / TrueHD 与 ASS 字幕全支持，
              启动即全屏，观看进度和累计时长由 ZEX 自动记录。外部播放器是黑盒，记不到进度。
            </p>
            <div className="flex items-center gap-1.5">
              <button className={clsx('chip', engine === 'mpv' && 'active')} onClick={() => switchEngine('mpv')}>
                内置 mpv
              </button>
              <button className={clsx('chip', engine === 'external' && 'active')} onClick={() => switchEngine('external')}>
                外部播放器
              </button>
            </div>
            {!mpvOk && (
              <p className="mt-3 flex items-start gap-2 text-xs text-[#ffc94d] leading-snug">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                没找到随包的 mpv，播放会自动回退到外部播放器。运行
                <code className="px-1 rounded bg-bg-surface-active">bash scripts/fetch-mpv.sh</code>
                拉取后重新构建即可。
              </p>
            )}
          </div>

          {engine === 'mpv' ? (
            <>
              <div className={clsx('flex items-center justify-between px-6 py-5 border-t border-border-glass', focusedRow === 5 + rowOffset && 'settings-row-focus')} data-settings-row={5 + rowOffset}>
                <div className="pr-4">
                  <p className="text-sm font-medium mb-0.5 flex items-center gap-2">
                    <Cpu size={14} className="text-text-tertiary" />
                    硬件解码
                  </p>
                  <p className="text-xs text-text-secondary leading-snug">
                    显卡解码，4K / HEVC 片源必开。个别老显卡驱动会花屏，遇到就关掉改用 CPU 解码
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button className={clsx('chip', !hwdec && 'active')} onClick={() => switchHwdec(false)}>关</button>
                  <button className={clsx('chip', hwdec && 'active')} onClick={() => switchHwdec(true)}>开</button>
                </div>
              </div>

              <div className={clsx('flex items-center justify-between px-6 py-5 border-t border-border-glass', focusedRow === 6 + rowOffset && 'settings-row-focus')} data-settings-row={6 + rowOffset}>
                <div className="pr-4">
                  <p className="text-sm font-medium mb-0.5">HDR / 杜比视界直通</p>
                  <p className="text-xs text-text-secondary leading-relaxed">
                    HDR10 / HDR10+ / HLG 直通，杜比视界 Profile 5 与 8 由 libplacebo 正确 tone map。
                    Profile 7（UHD 原盘双层）会回落到 HDR10 基础层 —— PC 上没有播放器能做到完整 DV 输出。
                    只在 HDR 片源上生效，SDR 不受影响
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button className={clsx('chip', !hdr && 'active')} onClick={() => switchHdr(false)}>关</button>
                  <button className={clsx('chip', hdr && 'active')} onClick={() => switchHdr(true)}>开</button>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className={clsx('px-6 py-5 border-t border-border-glass', focusedRow === 5 + rowOffset && 'settings-row-focus')} data-settings-row={5 + rowOffset}>
                <p className="text-sm font-medium mb-0.5">播放器路径</p>
                <p className="text-xs text-text-secondary mb-2 leading-snug">
                  留空则交给系统默认关联程序打开。注意：走外部播放器时 ZEX 拿不到播放进度，
                  「继续观看」和累计时长都不会更新
                </p>
                <div className="flex gap-2">
                  <input
                    value={playerPath}
                    onChange={(e) => setPlayerPath(e.target.value)}
                    onBlur={savePlayerPath}
                    placeholder="留空 = 系统默认程序，例：F:\Potplayer\PotPlayerMini64.exe"
                    className="input flex-1 text-sm"
                  />
                  <button onClick={handleBrowsePlayer} className="btn btn-glass gap-2 text-sm px-4 shrink-0">
                    <FolderOpen size={14} />
                    浏览
                  </button>
                </div>
              </div>

              <div className={clsx('flex items-center justify-between px-6 py-5 border-t border-border-glass', focusedRow === 6 + rowOffset && 'settings-row-focus')} data-settings-row={6 + rowOffset}>
                <div className="pr-4">
                  <p className="text-sm font-medium mb-0.5">全屏播放</p>
                  <p className="text-xs text-text-secondary leading-relaxed">
                    MPC-HC / VLC / mpv 用它们自己的命令行开关
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button className={clsx('chip', playerFullscreen && 'active')} onClick={() => switchFullscreen(true)}>
                    全屏
                  </button>
                  <button className={clsx('chip', !playerFullscreen && 'active')} onClick={() => switchFullscreen(false)}>
                    窗口
                  </button>
                </div>
              </div>
            </>
          )}

          {/* 播放音乐时默认显示歌词（恒渲染：音乐播放走内置 mpv，与影视引擎无关） */}
          <div className={clsx('flex items-center justify-between gap-6 px-6 py-5 border-t border-border-glass', focusedRow === 7 + rowOffset && 'settings-row-focus')} data-settings-row={7 + rowOffset}>
            <div className="pr-4">
              <p className="text-sm font-medium mb-0.5">播放音乐时默认显示歌词</p>
              <p className="text-xs text-text-secondary leading-relaxed">
                开启后播放音乐时自动显示桌面歌词；歌曲无内嵌同步歌词时自动跳过，
                手动关闭后本次播放内不再弹出
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button className={clsx('chip', !lyricsAutoShow && 'active')} onClick={() => switchLyricsAutoShow(false)}>关</button>
              <button className={clsx('chip', lyricsAutoShow && 'active')} onClick={() => switchLyricsAutoShow(true)}>开</button>
            </div>
          </div>
        </div>
      </section>

      {/* 手柄 */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-text-tertiary uppercase tracking-widest mb-4">手柄</h2>
        <div className="glass-card overflow-hidden">
          <div className={clsx('flex items-center justify-between gap-6 px-6 py-5', focusedRow === 8 + rowOffset && 'settings-row-focus')} data-settings-row={8 + rowOffset}>
            <div>
              <p className="text-sm font-medium flex items-center gap-2">
                <Gamepad2 size={14} className="text-text-tertiary" />
                手柄支持
              </p>
              <p className="text-xs text-text-secondary mt-0.5 leading-snug">
                支持 Xbox 系列与 PS5 DualSense / DualSense Edge（USB 有线）。
                方向键 / 左摇杆导航，A/✕ 确认，B/○ 返回，LB/L1、RB/R1 循环切库
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button className={clsx('chip', !gamepadEnabled && 'active')} onClick={() => switchGamepad(false)}>关</button>
              <button className={clsx('chip', gamepadEnabled && 'active')} onClick={() => switchGamepad(true)}>开</button>
            </div>
          </div>

          {/* 西瓜键唤起开关（默认关）：开时写入注册表关掉 Game Bar 抢键 */}
          <div className={clsx('flex items-center justify-between gap-6 px-6 py-5 border-t border-border-glass', focusedRow === 9 + rowOffset && 'settings-row-focus')} data-settings-row={9 + rowOffset}>
            <div className="pr-4">
              <p className="text-sm font-medium mb-0.5 flex items-center gap-2">
                <Gamepad2 size={14} className="text-text-tertiary" />
                用西瓜键打开软件
              </p>
              <p className="text-xs text-text-secondary leading-relaxed">
                开启后按 Xbox 手柄西瓜键可从托盘唤起 ZEX，同时写入注册表关闭「Game Bar
                用西瓜键打开」避免抢键（改的是当前用户注册表，重启 Game Bar 后完全生效）。
                关闭则恢复 Game Bar 默认行为，西瓜键不再唤起 ZEX
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button className={clsx('chip', !guideBtn && 'active')} onClick={() => switchGuideBtn(false)}>关</button>
              <button className={clsx('chip', guideBtn && 'active')} onClick={() => switchGuideBtn(true)}>开</button>
            </div>
          </div>

          {/* PS logo 键唤起开关（默认关）：HID 报文直读，独立开关，不涉及 Game Bar */}
          <div className={clsx('flex items-center justify-between gap-6 px-6 py-5 border-t border-border-glass', focusedRow === 10 + rowOffset && 'settings-row-focus')} data-settings-row={10 + rowOffset}>
            <div className="pr-4">
              <p className="text-sm font-medium mb-0.5 flex items-center gap-2">
                <Gamepad2 size={14} className="text-text-tertiary" />
                用 PS logo 键打开软件
              </p>
              <p className="text-xs text-text-secondary leading-relaxed">
                开启后按 DualSense / DualSense Edge 的 PS 键（USB 有线）可从托盘唤起 ZEX。
                与西瓜键独立开关，走 HID 报文直读，不涉及 Game Bar 注册表
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button className={clsx('chip', !psBtn && 'active')} onClick={() => switchPsBtn(false)}>关</button>
              <button className={clsx('chip', psBtn && 'active')} onClick={() => switchPsBtn(true)}>开</button>
            </div>
          </div>

          {/* 连接状态（只读，随插拔实时刷新） */}
          <div className="flex items-center gap-2.5 px-5 py-3 border-t border-border-glass text-xs">
            <Gamepad2 size={14} className={pads.length > 0 ? 'text-[#00d4ff]' : 'text-text-tertiary'} />
            {pads.length > 0 ? (
              <span className="text-text-secondary">已连接：{pads.map((p) => p.name).join('、')}</span>
            ) : (
              <span className="text-text-tertiary">未连接手柄</span>
            )}
          </div>
        </div>
      </section>

      {/* Covers */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-text-tertiary uppercase tracking-widest mb-4">封面</h2>
        <div className="glass-card p-5 overflow-hidden">
          <div className="flex items-center gap-2.5 mb-2">
            <KeyRound size={15} className="text-[#00d4ff]" />
            <p className="text-sm font-medium">SteamGridDB API Key</p>
          </div>
          <p className="text-xs text-text-secondary mb-4 leading-relaxed">
            部分游戏在 Steam CDN 上没有竖版封面（如新上架的游戏），配置此 Key 后导入时会自动从
            SteamGridDB 兜底获取 600×900 封面。免费申请：steamgriddb.com 登录后 → Preferences → API →
            Generate API Key。
          </p>
          <div className="flex gap-2">
            <input
              value={sgdbKey}
              onChange={(e) => setSgdbKey(e.target.value)}
              placeholder="粘贴 SteamGridDB API Key"
              className="input flex-1 text-sm"
            />
            <button
              onClick={handleSaveSgdbKey}
              disabled={savingKey}
              className="btn btn-accent text-sm px-5"
            >
              {savingKey ? '保存中...' : '保存'}
            </button>
          </div>

          <div className="flex items-center gap-2.5 mb-2 mt-6">
            <KeyRound size={15} className="text-[#00d4ff]" />
            <p className="text-sm font-medium">TMDB API Key</p>
          </div>
          <p className="text-xs text-text-secondary mb-4 leading-relaxed">
            影视库自动封面（海报、季封面、集剧照）数据源。免费申请：themoviedb.org 注册登录后 →
            Settings → API → Create，取 v3 API Key（读访问令牌不需要）。
            若无法连接 TMDB 请配置系统代理。
          </p>
          <div className="flex gap-2">
            <input
              value={tmdbKey}
              onChange={(e) => setTmdbKey(e.target.value)}
              placeholder="粘贴 TMDB API Key"
              className="input flex-1 text-sm"
            />
            <button
              onClick={handleSaveTmdbKey}
              disabled={savingTmdbKey}
              className="btn btn-accent text-sm px-5"
            >
              {savingTmdbKey ? '保存中...' : '保存'}
            </button>
          </div>

          {/* Steam CDN 补封面（手动触发，导入保持零网络） */}
          {/* 获取缺失封面：行 + 进度条 + 结果整体作为焦点行，蓝底/竖线随高度实时伸缩 */}
          <div className={clsx('mt-5 py-3.5 border-t border-border-glass -mx-5 px-5 -mb-5', focusedRow === 11 + rowOffset && 'settings-row-focus')} data-settings-row={11 + rowOffset}>
            <div className="flex items-center justify-between">
              <div className="pr-4">
                <p className="text-sm font-medium mb-0.5">从 Steam CDN 获取缺失封面</p>
                <p className="text-xs text-text-secondary leading-relaxed">
                  导入时只从 Steam 本地缓存复制封面；此按钮会为缺少封面/横幅的 Steam
                  游戏从 Steam CDN 下载补齐
                </p>
              </div>
              <button
                onClick={handleFetchAllCovers}
                disabled={fetchingCovers}
                className="btn btn-glass gap-2 text-sm shrink-0"
              >
                {fetchingCovers && <Loader2 size={14} className="animate-spin" />}
                {fetchingCovers ? '获取中...' : '获取缺失封面'}
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
                  进度：{fetchProgress.done} / {fetchProgress.total}（成功 {fetchProgress.ok}，失败 {fetchProgress.fail}）
                </p>
              </div>
            )}

            {/* 完成结果：内联显示，不弹窗 */}
            {fetchResult && (
              <p className={clsx('text-xs mt-3', fetchResult.startsWith('获取失败') ? 'text-danger' : 'text-text-secondary')}>
                {fetchResult}
              </p>
            )}
          </div>
        </div>
      </section>

      {/* Data */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-text-tertiary uppercase tracking-widest mb-4">数据</h2>
        <div className="glass-card overflow-hidden">
          <div className={clsx('flex items-center justify-between px-6 py-5 border-b border-border-glass', focusedRow === 12 + rowOffset && 'settings-row-focus')} data-settings-row={12 + rowOffset}>
            <div>
              <p className="text-sm font-medium mb-0.5">导出数据</p>
              <p className="text-xs text-text-secondary">将所有游戏和影视数据导出为 JSON 文件</p>
            </div>
            <button
              onClick={handleExport}
              disabled={exporting}
              className="btn btn-glass gap-2 text-sm"
            >
              <Download size={15} />
              {exporting ? '导出中...' : '导出'}
            </button>
          </div>
          <div className={clsx('flex items-center justify-between px-6 py-5 border-b border-border-glass', focusedRow === 13 + rowOffset && 'settings-row-focus')} data-settings-row={13 + rowOffset}>
            <div>
              <p className="text-sm font-medium mb-0.5">导入数据</p>
              <p className="text-xs text-text-secondary">从 JSON 备份文件恢复数据</p>
            </div>
            <button
              onClick={handleImport}
              disabled={importing}
              className="btn btn-glass gap-2 text-sm"
            >
              <Upload size={15} />
              {importing ? '导入中...' : '导入'}
            </button>
          </div>
          <div className={clsx('flex items-center justify-between px-6 py-5', focusedRow === 14 + rowOffset && 'settings-row-focus')} data-settings-row={14 + rowOffset}>
            <div>
              <p className="text-sm font-medium text-danger mb-0.5">清除所有数据</p>
              <p className="text-xs text-text-secondary">删除全部游戏、影视和封面文件（API Key 保留）</p>
            </div>
            <button
              onClick={handleClearAllData}
              disabled={clearing}
              className="btn btn-danger gap-2 text-sm"
            >
              <Trash2 size={15} />
              {clearing ? '清除中...' : '清除'}
            </button>
          </div>
        </div>
      </section>

      {/* 库 */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-text-tertiary uppercase tracking-widest mb-4">库</h2>
        <div className="glass-card overflow-hidden">
          {([
            { id: 'games' as const, name: '游戏库' },
            { id: 'series' as const, name: '影视库' },
            { id: 'music' as const, name: '音乐库' },
            { id: 'stats' as const, name: '统计' },
          ]).map((lib, i) => (
            <div
              key={lib.id}
              className={clsx('flex items-center justify-between gap-6 px-6 py-4', i > 0 && 'border-t border-border-glass', focusedRow === 15 + i + rowOffset && 'settings-row-focus')}
              data-settings-row={15 + i + rowOffset}
            >
              <p className="text-sm font-medium">{lib.name}</p>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  className={clsx('chip', hiddenLibraries.includes(lib.id) && 'active')}
                  onClick={() => tryHide(lib.id)}
                >
                  隐藏
                </button>
                <button
                  className={clsx('chip', !hiddenLibraries.includes(lib.id) && 'active')}
                  onClick={() => setLibraryHidden(lib.id, false)}
                >
                  显示
                </button>
              </div>
            </div>
          ))}
          <div className="px-5 py-2.5 border-t border-border-glass text-xs text-text-tertiary leading-snug">
            主库最多隐藏 2 个，至少保留 1 个可见；统计页可单独隐藏，设置页本身固定显示。
            <br />
            {hiddenLibraries.includes('series') && hiddenLibraries.includes('music')
              ? '影视库与音乐库均已隐藏 → mpv 预加载已关闭（省内存），正在播放的内容不受影响'
              : '影视库与音乐库同时隐藏时才会关闭 mpv 预加载'}
          </div>
        </div>
      </section>

      {/* 软件标识：自定义顶部封面与名称（空 = 默认 ZEX / 内置 logo） */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-text-tertiary uppercase tracking-widest mb-4">软件标识</h2>
        <div className="glass-card overflow-hidden">
          <div className={clsx('flex items-center justify-between gap-6 px-6 py-5')}>
            <div className="pr-4">
              <p className="text-sm font-medium mb-0.5">软件名称</p>
              <p className="text-xs text-text-secondary leading-snug">
                显示在顶部栏，留空恢复默认「ZEX」
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
              <p className="text-sm font-medium mb-0.5">软件封面</p>
              <p className="text-xs text-text-secondary leading-snug">
                顶部栏的 Logo，支持 png / jpg / webp（≤ 10MB），建议透明背景
              </p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <img
                src={brandCover ? coverSrc(brandCover) : zexLogo}
                alt="封面预览"
                draggable={false}
                className="w-10 h-10 object-contain rounded-lg bg-bg-surface border border-border-glass"
                onError={(e) => { (e.currentTarget as HTMLImageElement).src = zexLogo; }}
              />
              <button onClick={handlePickBrandCover} className="btn btn-glass gap-2 text-sm px-4">
                <ImageIcon size={14} />
                更换封面
              </button>
              {brandCover && (
                <button onClick={() => void resetBrandCover()} className="btn btn-glass text-sm px-4 text-text-secondary">
                  恢复默认
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* About */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-text-tertiary uppercase tracking-widest mb-4">关于</h2>
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
              <p className="text-sm text-text-secondary">版本 0.1.0</p>
            </div>
          </div>
          <p className="text-sm text-text-secondary leading-relaxed mb-4">
            ZEX 是一款本地游戏、影视与音乐库管理工具。游戏库支持 Steam 扫描与手动添加、封面自动搜索、游玩时长追踪；
            影视与音乐由内置 mpv 播放器驱动，支持剧集连播、进度记录与播放控制；最小化到托盘后照常后台记录，
            可随时从托盘菜单唤回并切换库，支持 Xbox / PS 手柄全程导航。
          </p>
          <a
            href="https://github.com/Yuzexiaoyu/Zex"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-sm text-[#00d4ff]/70 hover:text-[#00d4ff] transition-colors"
          >
            <ExternalLink size={14} />
            GitHub 仓库
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
              <h3 className="text-base font-semibold">清除所有数据</h3>
            </div>
            <button onClick={() => setShowClearConfirm(false)} className="w-8 h-8 rounded-lg flex items-center justify-center text-text-tertiary hover:bg-bg-surface-active">
              <X size={16} />
            </button>
          </div>
          <div className="px-5 py-4">
            <p className="text-sm text-text-secondary leading-relaxed">
              将删除所有游戏、影视、季、集、游玩记录和封面文件，此操作不可恢复（API Key 设置保留）。确定继续？
            </p>
            <div className="flex justify-end gap-2 pt-4">
              <button onClick={() => setShowClearConfirm(false)} className={clsx('btn btn-ghost', clearFocused === 0 && 'gamepad-focus')}>否</button>
              <button onClick={() => void doClearAll()} className={clsx('btn btn-danger', clearFocused === 1 && 'gamepad-focus')}>是</button>
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
