// 杂项词条：托盘菜单 / 桌面歌词 / 封面选择 / TMDB 消歧等小窗
export const zh: Record<string, string> = {
  // 托盘菜单
  'misc.notPlaying': '未在播放',
  'misc.quit': '退出',
  'misc.traySeekHint': '拖动进度',

  // 桌面歌词
  'misc.unlockLyrics': '解锁桌面歌词',
  'misc.fontSmaller': '字号减小',
  'misc.fontLarger': '字号增大',
  'misc.lockLyrics': '锁定（点击穿透；只有右上角小锁钮可点，点它解锁）',
  'misc.closeLyrics': '关闭桌面歌词',

  // 封面选择弹窗
  'misc.coverLoading': '正在获取封面...',
  'misc.coverNonePortrait': '没有找到可用的竖版封面',
  'misc.coverNoneSgdb': '该游戏在 SteamGridDB 上没有 600×900 封面',
  'misc.coverFetchFailed': '获取封面失败',
  'misc.coverSetFailed': '设置封面失败',
  'misc.unknownAuthor': '未知作者',

  // TMDB 消歧弹窗
  'misc.tmdbPickTitle': '选择正确的条目',
  'misc.tmdbPickDesc': '「{title}」在 TMDB 上有 {n} 个同名/相近结果，选中的那条会用于获取简介、评分和剧照',
  'misc.tmdbCurrent': '当前匹配',
  'misc.tmdbNoOverview': '（该条目暂无简介）',
};

export const en: Record<string, string> = {
  // Tray menu
  'misc.notPlaying': 'Not playing',
  'misc.quit': 'Quit',
  'misc.traySeekHint': 'Drag to seek',

  // Desktop lyrics
  'misc.unlockLyrics': 'Unlock desktop lyrics',
  'misc.fontSmaller': 'Smaller font',
  'misc.fontLarger': 'Larger font',
  'misc.lockLyrics': 'Lock (clicks pass through; only the small lock button in the corner can be clicked — click it to unlock)',
  'misc.closeLyrics': 'Close desktop lyrics',

  // Cover picker modal
  'misc.coverLoading': 'Fetching covers...',
  'misc.coverNonePortrait': 'No usable portrait covers found',
  'misc.coverNoneSgdb': 'This game has no 600×900 covers on SteamGridDB',
  'misc.coverFetchFailed': 'Failed to fetch covers',
  'misc.coverSetFailed': 'Failed to set cover',
  'misc.unknownAuthor': 'Unknown author',

  // TMDB disambiguation modal
  'misc.tmdbPickTitle': 'Choose the right entry',
  'misc.tmdbPickDesc': '"{title}" has {n} same-named or similar results on TMDB; the one you pick is used for the synopsis, rating and stills',
  'misc.tmdbCurrent': 'Current match',
  'misc.tmdbNoOverview': '(No synopsis for this entry)',
};
