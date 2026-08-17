// 通用词条：跨模块复用的短词与格式化模板。
// 各模块自己的文案放在各自 locales/<area>.ts，key 带 area 前缀
export const zh: Record<string, string> = {
  // 导航 / 库名
  'nav.games': '游戏库',
  'nav.series': '影视库',
  'nav.music': '音乐库',
  'nav.stats': '统计',
  'nav.settings': '设置',

  // 通用短词
  'common.cancel': '取消',
  'common.confirm': '确认',
  'common.delete': '删除',
  'common.remove': '移除',
  'common.close': '关闭',
  'common.save': '保存',
  'common.saving': '保存中...',
  'common.error': '错误',
  'common.warning': '警告',
  'common.success': '成功',
  'common.tip': '提示',
  'common.yes': '是',
  'common.no': '否',
  'common.loading': '加载中...',
  'common.retry': '重试',
  'common.on': '开',
  'common.off': '关',
  'common.search': '搜索',
  'common.all': '全部',
  'common.none': '无',
  'common.sort': '排序',
  'common.sortBy': '排序方式',
  'common.selectSort': '选择排序方式',
  'common.browse': '浏览',
  'common.deselectAll': '取消全选',
  'common.done': '完成',

  // 时长 / 集数格式化（utils/media.ts）
  'common.duration.seconds': '{n} 秒',
  'common.duration.minutes': '{n} 分钟',
  'common.duration.hours': '{n} 小时',
  'common.duration.hoursMinutes': '{h} 小时 {m} 分',
  'common.duration.hoursMinutesPadded': '{h} 小时 {m} 分',
  'common.duration.underMinute': '不到 1 分钟',
  'common.duration.zero': '0 分钟',
  'common.episodeN': '第 {n} 集',

  // 保存失败 / 操作失败通用拼接
  'common.saveFailed': '保存失败: {msg}',

  // 主窗框架
  'app.minimize': '最小化',
  'app.closeToTray': '最小化到系统托盘（右键托盘图标可退出）',
};

export const en: Record<string, string> = {
  'nav.games': 'Games',
  'nav.series': 'Series',
  'nav.music': 'Music',
  'nav.stats': 'Stats',
  'nav.settings': 'Settings',

  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.delete': 'Delete',
  'common.remove': 'Remove',
  'common.close': 'Close',
  'common.save': 'Save',
  'common.saving': 'Saving...',
  'common.error': 'Error',
  'common.warning': 'Warning',
  'common.success': 'Success',
  'common.tip': 'Notice',
  'common.yes': 'Yes',
  'common.no': 'No',
  'common.loading': 'Loading...',
  'common.retry': 'Retry',
  'common.on': 'On',
  'common.off': 'Off',
  'common.search': 'Search',
  'common.all': 'All',
  'common.none': 'None',
  'common.sort': 'Sort',
  'common.sortBy': 'Sort by',
  'common.selectSort': 'Choose sort order',
  'common.browse': 'Browse',
  'common.deselectAll': 'Deselect all',
  'common.done': 'Done',

  'common.duration.seconds': '{n}s',
  'common.duration.minutes': '{n} min',
  'common.duration.hours': '{n} hr',
  'common.duration.hoursMinutes': '{h} hr {m} min',
  'common.duration.hoursMinutesPadded': '{h} hr {m} min',
  'common.duration.underMinute': 'Under 1 minute',
  'common.duration.zero': '0 min',
  'common.episodeN': 'Episode {n}',

  'common.saveFailed': 'Save failed: {msg}',

  'app.minimize': 'Minimize',
  'app.closeToTray': 'Minimize to system tray (right-click tray icon to quit)',
};
