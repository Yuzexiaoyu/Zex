import { create } from 'zustand';
import type { Game, GameFilter, Series, Stats, ThemeMode, UIMode } from '../types';
import * as api from '../api';

interface AppState {
  // ─── Data ───────────────────────────────
  games: Game[];
  series: Series[];
  stats: Stats | null;
  runningGameId: string | null;

  // ─── UI State ───────────────────────────
  activeView: 'games' | 'series' | 'stats' | 'settings';
  filter: GameFilter;
  selectedGameId: string | null;
  selectedSeriesId: string | null;
  selectedSeasonId: string | null;
  sidebarOpen: boolean;
  theme: ThemeMode;
  uiMode: UIMode;

  // ─── Actions ────────────────────────────
  loadGames: () => Promise<void>;
  loadSeries: () => Promise<void>;
  loadStats: () => Promise<void>;

  setActiveView: (view: AppState['activeView']) => void;
  setFilter: (filter: Partial<GameFilter>) => void;
  setSelectedGameId: (id: string | null) => void;
  setSelectedSeriesId: (id: string | null) => void;
  setSelectedSeasonId: (id: string | null) => void;
  toggleSidebar: () => void;
  setTheme: (theme: ThemeMode) => void;
  setUIMode: (mode: UIMode) => void;

  createGame: (game: Omit<Game, 'id' | 'created_at' | 'updated_at' | 'play_count' | 'total_seconds'>) => Promise<Game>;
  updateGame: (id: string, game: Partial<Game>) => Promise<void>;
  deleteGame: (id: string) => Promise<void>;
  launchGame: (id: string) => Promise<void>;
  setRunningGameId: (id: string | null) => void;

  createSeries: (series: Omit<Series, 'id' | 'created_at' | 'updated_at' | 'total_seconds'>) => Promise<Series>;
  updateSeries: (id: string, series: Partial<Series>) => Promise<void>;
  deleteSeries: (id: string) => Promise<void>;

  updateWatchProgress: (episodeId: string, watchedSeconds: number, watched: boolean) => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  // ─── Initial Data ──────────────────────
  games: [],
  series: [],
  stats: null,
  runningGameId: null,

  // ─── Initial UI State ───────────────────
  activeView: 'games',
  filter: {},
  selectedGameId: null,
  selectedSeriesId: null,
  selectedSeasonId: null,
  sidebarOpen: true,
  theme: 'dark',
  uiMode: 'desktop',

  // ─── Actions ────────────────────────────
  loadGames: async () => {
    const { filter } = get();
    const games = Object.keys(filter).length > 0
      ? await api.filterGames(filter)
      : await api.getAllGames();
    set({ games });
  },

  loadSeries: async () => {
    const series = await api.getAllSeries();
    set({ series });
  },

  loadStats: async () => {
    const stats = await api.getStats();
    set({ stats });
  },

  setActiveView: (activeView) => set({ activeView }),
  setFilter: (partial) => set((s) => ({ filter: { ...s.filter, ...partial } })),
  setSelectedGameId: (selectedGameId) => set({ selectedGameId }),
  setSelectedSeriesId: (selectedSeriesId) => set({ selectedSeriesId }),
  setSelectedSeasonId: (selectedSeasonId) => set({ selectedSeasonId }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setTheme: (theme) => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    set({ theme });
  },
  setUIMode: (uiMode) => set({ uiMode }),

  createGame: async (game) => {
    const created = await api.createGame(game);
    set((s) => ({ games: [...s.games, created] }));
    return created;
  },

  updateGame: async (id, game) => {
    await api.updateGame(id, game);
    set((s) => ({
      games: s.games.map((g) => (g.id === id ? { ...g, ...game } : g)),
    }));
  },

  deleteGame: async (id) => {
    await api.deleteGame(id);
    set((s) => ({ games: s.games.filter((g) => g.id !== id), selectedGameId: null }));
  },

  launchGame: async (id) => {
    await api.launchGame(id);
    set({ runningGameId: id });
  },

  setRunningGameId: (id) => set({ runningGameId: id }),

  createSeries: async (series) => {
    const created = await api.createSeries(series);
    set((s) => ({ series: [...s.series, created] }));
    return created;
  },

  updateSeries: async (id, series) => {
    await api.updateSeries(id, series);
    set((s) => ({
      series: s.series.map((s2) => (s2.id === id ? { ...s2, ...series } : s2)),
    }));
  },

  deleteSeries: async (id) => {
    await api.deleteSeries(id);
    set((s) => ({ series: s.series.filter((s2) => s2.id !== id), selectedSeriesId: null }));
  },

  updateWatchProgress: async (episodeId, watchedSeconds, watched) => {
    await api.updateWatchProgress(episodeId, watchedSeconds, watched);
  },
}));
