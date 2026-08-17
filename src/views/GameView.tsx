import { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '../store';
import GameGrid from '../components/GameGrid';
import GameDetail from './GameDetail';
import SteamScanModal from '../components/SteamScanModal';
import DiskManagerModal from '../components/DiskManagerModal';
import { message } from '@tauri-apps/plugin-dialog';
import { Plus, Gamepad2, ChevronDown } from 'lucide-react';
import { useEscIntercept } from '../utils/escIntercept';
import { useT } from '../i18n';

interface Props {
  onAddGame?: () => void;
}

export default function GameView({ onAddGame }: Props) {
  const t = useT();
  // 逐字段订阅，避免无关字段（如音乐进度）带着整个游戏库重画
  const games = useAppStore((s) => s.games);
  const loadGames = useAppStore((s) => s.loadGames);
  // 详情弹出窗口（仅右键菜单「查看详情」进入）
  const selectedGameId = useAppStore((s) => s.selectedGameId);
  const setSelectedGameId = useAppStore((s) => s.setSelectedGameId);
  const launchGame = useAppStore((s) => s.launchGame);

  const columns = useAppStore((s) => s.gameColumns); // 每行数量在「设置 → 外观」里调
  const [showSteamModal, setShowSteamModal] = useState(false);
  const [addMenu, setAddMenu] = useState(false); // 添加游戏下拉（手动 / Steam 导入）
  const [showDiskManager, setShowDiskManager] = useState(false); // 磁盘管理弹窗（右键菜单进入）

  // 添加下拉开着时由它消费 Esc，App 的全局「Esc=收托盘」让位
  useEscIntercept(addMenu);

  useEffect(() => {
    loadGames();
  }, []);

  // 下拉打开时：点击别处 / Esc 关闭
  useEffect(() => {
    if (!addMenu) return;
    const close = () => setAddMenu(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [addMenu]);

  const handleLaunch = useCallback(async (id: string) => {
    try {
      await launchGame(id);
    } catch (err: any) {
      await message(t('games.launchFailed', { msg: typeof err === 'string' ? err : (err?.message ?? String(err)) }), { title: t('common.error'), kind: 'error' });
    }
  }, [launchGame]);

  return (
    <div className="flex h-full">
      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Toolbar（排序与列数已移入右键菜单） */}
        <div className="shrink-0 px-6 py-4 flex items-center gap-3">
          {/* 添加游戏下拉：手动添加 / Steam 导入 */}
          <div className="relative">
            <button
              onClick={(e) => { e.stopPropagation(); setAddMenu(!addMenu); }}
              className="btn btn-accent gap-2 text-sm"
            >
              <Plus size={15} />
              {t('games.addGame')}
              <ChevronDown size={13} className={addMenu ? 'rotate-180 transition-transform' : 'transition-transform'} />
            </button>
            {addMenu && (
              <div className="absolute left-0 top-full mt-3 z-50" onClick={(e) => e.stopPropagation()}>
                <div className="glass-modal solid-modal w-80 overflow-hidden shadow-2xl animate-scale-in">
                  <div className="px-4 py-3 border-b border-border-glass bg-[rgba(0,212,255,0.05)]">
                    <p className="text-sm font-semibold text-text-primary">{t('games.addToLibrary')}</p>
                    <p className="mt-0.5 text-xs text-text-secondary">{t('games.chooseAddMethod')}</p>
                  </div>
                  <div className="p-2 space-y-1.5">
                    <button
                      onClick={() => { setAddMenu(false); onAddGame?.(); }}
                      className="group w-full flex items-center gap-3 rounded-xl px-3 py-3 text-left transition-all hover:bg-[rgba(0,212,255,0.10)] border border-transparent hover:border-[rgba(0,212,255,0.20)]"
                    >
                      <span className="w-10 h-10 rounded-xl bg-[rgba(0,212,255,0.12)] border border-[rgba(0,212,255,0.22)] flex items-center justify-center shrink-0 group-hover:bg-[rgba(0,212,255,0.18)]">
                        <Plus size={18} className="text-[#00d4ff]" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-text-primary">{t('games.addManual')}</span>
                        <span className="block mt-0.5 text-xs text-text-secondary">{t('games.addManualDesc')}</span>
                      </span>
                    </button>
                    <button
                      onClick={() => { setAddMenu(false); setShowSteamModal(true); }}
                      className="group w-full flex items-center gap-3 rounded-xl px-3 py-3 text-left transition-all hover:bg-bg-surface-hover border border-transparent hover:border-border-glass-hover"
                    >
                      <span className="w-10 h-10 rounded-xl bg-bg-surface border border-border-glass flex items-center justify-center shrink-0 group-hover:bg-bg-surface-active">
                        <Gamepad2 size={18} className="text-text-secondary group-hover:text-text-primary" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-text-primary">{t('games.steamImport')}</span>
                        <span className="block mt-0.5 text-xs text-text-secondary">{t('games.steamImportDesc')}</span>
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Grid */}
        <div className="flex-1 min-h-0">
          <GameGrid
            games={games}
            onLaunch={handleLaunch}
            columns={columns}
            onAddGame={onAddGame}
            onOpenSteam={() => setShowSteamModal(true)}
            onOpenDiskManager={() => setShowDiskManager(true)}
          />
        </div>
      </div>

      {/* 详情弹出窗口（右键菜单「查看详情」进入） */}
      {selectedGameId && (
        <GameDetail
          gameId={selectedGameId}
          onClose={() => setSelectedGameId(null)}
        />
      )}

      {/* Modals */}
      {showSteamModal && (
        <SteamScanModal
          onClose={() => setShowSteamModal(false)}
          onImported={loadGames}
        />
      )}

      {/* 磁盘管理弹窗（游戏封面右键菜单进入） */}
      {showDiskManager && (
        <DiskManagerModal onClose={() => setShowDiskManager(false)} />
      )}
    </div>
  );
}
