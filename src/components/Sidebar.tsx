import { clsx } from 'clsx';
import { useAppStore } from '../store';
import { Gamepad2, Film, BarChart3, Settings, ChevronLeft, ChevronRight } from 'lucide-react';

const navItems = [
  { id: 'games' as const, label: '游戏库', icon: Gamepad2 },
  { id: 'series' as const, label: '影视库', icon: Film },
  { id: 'stats' as const, label: '统计', icon: BarChart3 },
  { id: 'settings' as const, label: '设置', icon: Settings },
];

export default function Sidebar() {
  const { activeView, setActiveView, sidebarOpen, toggleSidebar, uiMode } = useAppStore();
  const isTenFoot = uiMode === 'ten-foot';

  return (
    <aside
      className={clsx(
        'flex flex-col h-full transition-all duration-200 ease-out shrink-0',
        'bg-[var(--color-surface-2)] border-r border-[var(--color-border)]',
        sidebarOpen ? (isTenFoot ? 'w-64' : 'w-56') : 'w-16',
      )}
    >
      {/* Logo */}
      <div className={clsx(
        'flex items-center h-14 px-4 border-b border-[var(--color-border)]',
        !sidebarOpen && 'justify-center',
      )}>
        <span className="text-xl font-bold tracking-tight text-[var(--color-accent)]">
          ZEX
        </span>
        {sidebarOpen && (
          <span className="ml-2 text-xs text-[var(--color-text-secondary)]">游戏与影视库</span>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 py-3 space-y-1 px-2">
        {navItems.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveView(id)}
            className={clsx(
              'nav-item w-full flex items-center gap-3 rounded-lg transition-colors',
              'text-sm font-medium',
              activeView === id
                ? 'bg-[var(--color-accent)] text-white'
                : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]',
              !sidebarOpen && 'justify-center px-0 py-3',
            )}
            title={!sidebarOpen ? label : undefined}
          >
            <Icon size={isTenFoot ? 24 : 20} className="shrink-0" />
            {sidebarOpen && <span>{label}</span>}
          </button>
        ))}
      </nav>

      {/* Toggle */}
      <div className="p-2 border-t border-[var(--color-border)]">
        <button
          onClick={toggleSidebar}
          className="w-full flex items-center justify-center py-2 rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)] transition-colors"
        >
          {sidebarOpen ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
        </button>
      </div>
    </aside>
  );
}
