// ─────────────────────────────────────────────
// Core Types
// ─────────────────────────────────────────────

export interface Game {
  id: string;
  name: string;
  platform: string;
  install_dir: string;
  exe_path: string;
  launch_args: string;
  env_vars: string;
  work_dir: string;
  cover_path: string;
  banner_path: string;
  bg_path: string;
  rating: number;
  notes: string;
  tags: string;
  favorite: boolean;
  hidden: boolean;
  play_count: number;
  total_seconds: number;
  created_at: string;
  updated_at: string;
}

export interface GameFilter {
  search?: string;
  platform?: string;
  favorite?: boolean;
  hidden?: boolean;
  sort_by?: 'name' | 'created_at' | 'updated_at' | 'play_count' | 'total_seconds';
  sort_order?: 'asc' | 'desc';
}

export interface SteamGame {
  app_id: String,
  name: String,
  install_dir: String,
  exe_path: String,
}

export interface GameSession {
  id: string;
  game_id: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number;
}

export interface Series {
  id: string;
  name: string;
  year: number | null;
  overview: string;
  cover_path: string;
  banner_path: string;
  tags: string;
  favorite: boolean;
  hidden: boolean;
  total_seconds: number;
  created_at: string;
  updated_at: string;
}

export interface Season {
  id: string;
  series_id: string;
  season_number: number;
  title: string;
  cover_path: string;
  total_seconds: number;
  created_at: string;
  updated_at: string;
}

export interface Episode {
  id: string;
  season_id: string;
  episode_number: number;
  title: string;
  overview: string;
  duration_seconds: number;
  cover_path: string;
  file_path: string;
  watched: boolean;
  watched_seconds: number;
  created_at: string;
  updated_at: string;
}

export interface Stats {
  total_games: number;
  total_series: number;
  total_play_time_seconds: number;
  week_play_time_seconds: number;
  month_play_time_seconds: number;
  recent_sessions: GameSession[];
  top_games: Array<Game & { total_seconds: number }>;
}

export type ThemeMode = 'light' | 'dark' | 'system';
export type UIMode = 'desktop' | 'ten-foot';
export type SortField = 'name' | 'created_at' | 'updated_at' | 'play_count' | 'total_seconds';
export type SortOrder = 'asc' | 'desc';

export interface Settings {
  theme: ThemeMode;
  ui_mode: UIMode;
  default_sort: SortField;
  default_order: SortOrder;
  steam_library_paths: string[];
}
