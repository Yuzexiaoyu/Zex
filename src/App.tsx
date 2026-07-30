import { useEffect } from 'react';
import { useAppStore } from './store';
import Sidebar from './components/Sidebar';
import GameView from './views/GameView';
import SeriesView from './views/SeriesView';
import StatsView from './views/StatsView';
import SettingsView from './views/SettingsView';
import './index.css';

export default function App() {
  const { activeView, theme } = useAppStore();

  // Apply theme on mount
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.classList.toggle('light', theme !== 'dark');
  }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--color-surface-1)]">
      <Sidebar />

      <main className="flex-1 min-w-0 overflow-hidden">
        {activeView === 'games' && <GameView />}
        {activeView === 'series' && <SeriesView />}
        {activeView === 'stats' && <StatsView />}
        {activeView === 'settings' && <SettingsView />}
      </main>
    </div>
  );
}
