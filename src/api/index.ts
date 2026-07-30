import { invoke } from '@tauri-apps/api/core';
import type { Game, GameFilter, SteamGame, GameSession, Series, Season, Episode, Stats } from '../types';
export type { SteamGame };

// ─── Games ─────────────────────────────────

export async function getAllGames(): Promise<Game[]> {
  return invoke('get_all_games');
}

export async function getGame(id: string): Promise<Game | null> {
  return invoke('get_game', { id });
}

export async function createGame(game: Omit<Game, 'id' | 'created_at' | 'updated_at' | 'play_count' | 'total_seconds'>): Promise<Game> {
  return invoke('create_game', { game });
}

export async function updateGame(id: string, game: Partial<Game>): Promise<Game> {
  return invoke('update_game', { id, game });
}

export async function deleteGame(id: string): Promise<void> {
  return invoke('delete_game', { id });
}

export async function filterGames(filter: GameFilter): Promise<Game[]> {
  return invoke('filter_games', { filter });
}

// ─── Steam ─────────────────────────────────

export async function scanSteamLibrary(): Promise<SteamGame[]> {
  return invoke('scan_steam_library');
}

export async function importSteamGames(steamGames: SteamGame[]): Promise<Game[]> {
  return invoke('import_steam_games', { steamGames });
}

// ─── Sessions ──────────────────────────────

export async function launchGame(id: string): Promise<void> {
  return invoke('launch_game', { id });
}

export async function getGameSessions(id: string): Promise<GameSession[]> {
  return invoke('get_game_sessions', { gameId: id });
}

// ─── Series ────────────────────────────────

export async function getAllSeries(): Promise<Series[]> {
  return invoke('get_all_series');
}

export async function createSeries(series: Omit<Series, 'id' | 'created_at' | 'updated_at' | 'total_seconds'>): Promise<Series> {
  return invoke('create_series', { series });
}

export async function updateSeries(id: string, series: Partial<Series>): Promise<Series> {
  return invoke('update_series', { id, series });
}

export async function deleteSeries(id: string): Promise<void> {
  return invoke('delete_series', { id });
}

export async function getSeasons(seriesId: string): Promise<Season[]> {
  return invoke('get_seasons', { seriesId });
}

export async function createSeason(season: Omit<Season, 'id' | 'created_at' | 'updated_at' | 'total_seconds'>): Promise<Season> {
  return invoke('create_season', { season });
}

export async function updateSeason(id: string, season: Partial<Season>): Promise<Season> {
  return invoke('update_season', { id, season });
}

export async function deleteSeason(id: string): Promise<void> {
  return invoke('delete_season', { id });
}

export async function getEpisodes(seasonId: string): Promise<Episode[]> {
  return invoke('get_episodes', { seasonId });
}

export async function createEpisode(episode: Omit<Episode, 'id' | 'created_at' | 'updated_at'>): Promise<Episode> {
  return invoke('create_episode', { episode });
}

export async function updateEpisode(id: string, episode: Partial<Episode>): Promise<Episode> {
  return invoke('update_episode', { id, episode });
}

export async function deleteEpisode(id: string): Promise<void> {
  return invoke('delete_episode', { id });
}

export async function updateWatchProgress(id: string, watchedSeconds: number, watched: boolean): Promise<void> {
  return invoke('update_watch_progress', { id, watchedSeconds, watched });
}

export async function markEpisodeWatched(id: string, watched: boolean): Promise<void> {
  return invoke('mark_episode_watched', { id, watched });
}

// ─── Covers ────────────────────────────────

export async function searchCovers(query: string, type: 'game' | 'series'): Promise<Array<{ url: string; width: number; height: number }>> {
  return invoke('search_covers', { query, coverType: type });
}

export async function downloadCover(url: string, name: string, type: 'cover' | 'banner' | 'bg'): Promise<string> {
  return invoke('download_cover', { url, name, coverType: type });
}

// ─── Stats ────────────────────────────────

export async function getStats(): Promise<Stats> {
  return invoke('get_stats');
}

// ─── Data Export/Import ───────────────────

export async function exportData(): Promise<string> {
  return invoke('export_data');
}

export async function importData(jsonData: string): Promise<void> {
  return invoke('import_data', { jsonData });
}
