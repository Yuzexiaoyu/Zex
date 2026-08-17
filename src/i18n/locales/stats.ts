// 统计页词条（StatsView / StatsAdjustModal / StatsCovers）
export const zh: Record<string, string> = {
  // 列标题 / 单位
  'stats.game': '游戏',
  'stats.video': '影视',
  'stats.music': '音乐',
  'stats.unitGame': '款',
  'stats.unitVideo': '部',
  'stats.unitMusic': '首',
  'stats.playCount': '次播放',

  // 页面文案
  'stats.watchedEpisodes': '已看 {watched}/{total} 集',
  'stats.noRecords': '还没有记录',
  'stats.loadFailed': '统计数据读取失败',
  'stats.loading': '正在统计…',
  'stats.emptyTitle': '还没有任何记录',
  'stats.emptyDesc': '玩一局游戏、看一集剧、听一首歌，这里就会开始记录你的时间。',
  'stats.notPlayed': '未游玩',
  'stats.countTimes': '{n} 次',

  // 调整时长弹窗
  'stats.adjustDuration': '调整时长',
  'stats.adjustGameTitle': '调整游戏时长',
  'stats.currentDuration': '当前时长：',
  'stats.hours': '小时',
  'stats.minutes': '分钟',
  'stats.afterSet': '设置后：',
  'stats.adjustHint': '手动修正累计时长，下次游玩后增量照常累加',
  'stats.hoursLimit': '请输入不超过 {n} 小时的时长',
  'stats.saveFailedRetry': '保存失败，请重试',
};

export const en: Record<string, string> = {
  // Column titles / units
  'stats.game': 'Games',
  'stats.video': 'Series',
  'stats.music': 'Music',
  'stats.unitGame': 'games',
  'stats.unitVideo': 'series',
  'stats.unitMusic': 'tracks',
  'stats.playCount': 'plays',

  // Page text
  'stats.watchedEpisodes': 'Watched {watched}/{total} episodes',
  'stats.noRecords': 'No records yet',
  'stats.loadFailed': 'Failed to read stats',
  'stats.loading': 'Calculating…',
  'stats.emptyTitle': 'No records yet',
  'stats.emptyDesc': 'Play a game, watch an episode, or listen to a song — your time will start being recorded here.',
  'stats.notPlayed': 'Not played',
  'stats.countTimes': '{n} times',

  // Adjust playtime modal
  'stats.adjustDuration': 'Adjust playtime',
  'stats.adjustGameTitle': 'Adjust game playtime',
  'stats.currentDuration': 'Current: ',
  'stats.hours': 'Hours',
  'stats.minutes': 'Minutes',
  'stats.afterSet': 'After: ',
  'stats.adjustHint': 'Manually correct the accumulated playtime; increments keep adding up normally after the next session',
  'stats.hoursLimit': 'Enter a playtime no longer than {n} hours',
  'stats.saveFailedRetry': 'Save failed, please try again',
};
