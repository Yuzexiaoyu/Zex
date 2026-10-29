import type { Game, GameFolder, LibraryCell, LibrarySlot } from '../types';

// 文件夹成员集合：顶层要把它们排除掉（归属是排他的，进了文件夹就不在顶层单独占格）
export function folderMemberIds(folders: GameFolder[]): Set<string> {
  const ids = new Set<string>();
  for (const f of folders) {
    for (const id of f.game_ids) ids.add(id);
  }
  return ids;
}

/** 顶层游戏 = 不在任何文件夹里的那些 */
export function topLevelGames(games: Game[], folders: GameFolder[]): Game[] {
  const members = folderMemberIds(folders);
  return games.filter((g) => !members.has(g.id));
}

/** 文件夹内成员（按 folder.game_ids 的顺序，即后端 game_folder_items.sort_order）。
 *  取不到的 id 跳过 —— GameView 的同名归档去重会滤掉一部分游戏，它们不该在清单里留空行 */
export function folderGames(folder: GameFolder, byId: Map<string, Game>): Game[] {
  const out: Game[] = [];
  for (const id of folder.game_ids) {
    const g = byId.get(id);
    if (g) out.push(g);
  }
  return out;
}

/** 一格的绝对格号（0 基）。-1 = 未定位：新添加的游戏、导入的老数据 */
export function slotOf(item: { slot?: number }): number {
  const s = item.slot;
  return typeof s === 'number' && s >= 0 ? s : -1;
}

interface LayoutOpts {
  /** 平铺模式（文件夹内 / 搜索筛选）：按数组顺序密排，不看格号、不留空格、不显示文件夹 */
  flat?: boolean;
  /** 每行格数：用来把总格数补满整行 */
  colCount: number;
  /** 末尾额外补几行空格（拖拽中补 2 行：空槽显成「可以放这」的虚线框，
      留一行的话内容行占满时就只看得见底下那一行） */
  padRows?: number;
}

interface Placeable {
  slot: number;
  createdAt: string;
  key: string;
  cell: LibraryCell;
}

// 定位相同（或都未定位）时的稳定次序：建立时间 → key。同一份数据每次算出来都一样
function byAge(a: Placeable, b: Placeable): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * 游戏库顶层的格子布局 —— 整库自由摆放。
 *
 * 游戏和文件夹共用一个「绝对格号」空间：各自钉在自己的 slot 上，拖到哪就永远在哪，
 * 任何一格都能空着，谁都不会自动往前堆。未定位（slot<0，新添加的游戏 / 导入的老数据）
 * 的落进第一个空格。撞格的往后顺延（导入、或从文件夹里移出来撞上别人时）。
 *
 * 文件夹内的视图（flat）不走这套：文件夹内部是一条列表，按数组顺序密排。
 */
export function buildLibraryLayout(
  games: Game[],
  folders: GameFolder[],
  opts: LayoutOpts,
): LibrarySlot[] {
  const gameCell = (game: Game): LibraryCell => ({ kind: 'game', key: `g:${game.id}`, game });
  if (opts.flat) {
    return games.map(gameCell);
  }
  const colCount = Math.max(1, opts.colCount);
  const byId = new Map(games.map((g) => [g.id, g]));
  const members = folderMemberIds(folders);

  const items: Placeable[] = [];
  for (const folder of folders) {
    items.push({
      slot: slotOf(folder),
      createdAt: folder.created_at,
      key: `f:${folder.id}`,
      cell: { kind: 'folder', key: `f:${folder.id}`, folder, games: folderGames(folder, byId) },
    });
  }
  for (const game of games) {
    if (members.has(game.id)) continue; // 在文件夹里 → 不在顶层占格
    items.push({
      slot: slotOf(game),
      createdAt: game.created_at,
      key: `g:${game.id}`,
      cell: gameCell(game),
    });
  }

  const placed = new Map<number, LibraryCell>();
  // 从 at 开始找第一个空格放进去（撞格顺延 / 未定位找第一个空格共用这条）
  const put = (at: number, cell: LibraryCell) => {
    let s = Math.max(0, at);
    while (placed.has(s)) s += 1;
    placed.set(s, cell);
  };
  for (const it of items.filter((i) => i.slot >= 0).sort((a, b) => (a.slot !== b.slot ? a.slot - b.slot : byAge(a, b)))) {
    put(it.slot, it.cell);
  }
  // 未定位的：按建立时间依次填进最前面的空格（新加的游戏就补在最靠前的那个洞里）
  for (const it of items.filter((i) => i.slot < 0).sort(byAge)) {
    put(0, it.cell);
  }

  const last = placed.size > 0 ? Math.max(...placed.keys()) : -1;
  const slots: LibrarySlot[] = [];
  for (let i = 0; i <= last; i++) slots.push(placed.get(i) ?? null);

  // 补满整行 + 末尾预留行
  const rows = Math.ceil(slots.length / colCount) + Math.max(0, opts.padRows ?? 0);
  while (slots.length < rows * colCount) slots.push(null);
  return slots;
}
