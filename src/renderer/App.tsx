// App shell. The main area is a master-detail layout: task list (left) +
// task detail (right); the resident AI panel sits further right and collapses
// to a rail. Settings is a modal (not a route pane), opened from the bottom-left
// user chip or the 菜单 button. The Sidebar is gone — view switching lives in
// the title-bar 过滤 popover, and quick actions in the 菜单 / user menu.

import React, { useEffect, useState, useCallback } from 'react';
import { ErrorBoundary } from './ErrorBoundary';
import { Topbar } from './layout/Topbar';
import { Statusbar } from './layout/Statusbar';
import { AIPanel } from './layout/AIPanel';
import { ToastHost, useToastBus } from './components/Toast';
import { CommandPaletteHost } from './components/CommandPalette';
import { SettingsModal } from './components/SettingsModal';
import { Composer } from './components/Composer';
import { TodoListPane } from './panes/TodoListPane';
import { TodoEditorPane } from './panes/TodoEditorPane';
import { InboxPane } from './panes/InboxPane';
import { StatsPane } from './panes/StatsPane';
import { DrawingPane } from './panes/DrawingPane';
import { parseHash, routeToHash, type Route, type ListFilter } from './router';
import { useAppEvent } from './hooks/useThihyApi';
import { emitDataChanged } from './data-bus';

const AI_OPEN_KEY = 'thihy.aiOpen';

type View = 'list' | 'inbox' | 'stats' | 'drawing';

function deriveView(route: Route): View {
  switch (route.name) {
    case 'inbox':
      return 'inbox';
    case 'stats':
      return 'stats';
    case 'todo-drawing':
      return 'drawing';
    default:
      return 'list'; // home, list, todo, settings, ai
  }
}

export const App: React.FC = () => {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  const toast = useToastBus();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const [listFilter, setListFilter] = useState<ListFilter>({ kind: 'all' });
  const [aiOpen, setAiOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(AI_OPEN_KEY) !== '0';
    } catch {
      return true;
    }
  });

  useEffect(() => {
    const onHash = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Sync the list filter from #/list/<path> deep links.
  useEffect(() => {
    if (route.name === 'list') setListFilter(route.filter);
  }, [route]);

  // Ctrl-K command palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(AI_OPEN_KEY, aiOpen ? '1' : '0');
    } catch {
      // ignore storage errors
    }
  }, [aiOpen]);

  useAppEvent('app:toggle-ai', () => setAiOpen((v) => !v));
  useAppEvent('app:navigate', ({ route }) => {
    if (route) location.hash = route.startsWith('#') ? route : `#/${route}`;
  });
  // Bridge main→renderer data-changed pushes (AI tools mutate the DB in the
  // main process) to the renderer data bus, which re-fetches affected hooks.
  useAppEvent('app:data-changed', ({ scope }) => emitDataChanged(scope));

  // 'settings' is a modal: open it when the route matches (deep link / menu).
  useEffect(() => {
    if (route.name === 'settings') setSettingsOpen(true);
  }, [route]);

  // 'ai' route opens the panel but keeps the main area on the list.
  useEffect(() => {
    if (route.name === 'ai') setAiOpen(true);
  }, [route]);

  const navigate = useCallback((to: string) => {
    location.hash = to;
  }, []);
  const toggleAi = useCallback(() => setAiOpen((v) => !v), []);
  const selectFilter = useCallback((f: ListFilter) => {
    setListFilter(f);
    location.hash = routeToHash({ name: 'list', filter: f });
  }, []);

  const view = deriveView(route);
  const selectedId = route.name === 'todo' ? route.id : null;

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    if (location.hash.startsWith('#/settings')) location.hash = '#/';
  }, []);

  return (
    <ErrorBoundary>
      <div className="app-shell">
        <Topbar
          onOpenPalette={() => setPaletteOpen(true)}
          listFilter={listFilter}
          onSelectFilter={selectFilter}
        />
        <div className="app-body">
          <main className={`app-main${view === 'list' ? ' is-master' : ''}`}>
            {view === 'list' && (
              <div className="master-detail">
                <TodoListPane
                  filter={listFilter}
                  selectedId={selectedId}
                  onSelect={(id) => navigate(routeToHash({ name: 'todo', id }))}
                  onOpenSettings={() => setSettingsOpen(true)}
                  onCompose={() => setComposing(true)}
                />
                <TaskDetail
                  todoId={selectedId}
                  composing={composing}
                  onCloseCompose={() => setComposing(false)}
                  navigate={navigate}
                />
              </div>
            )}
            {view === 'inbox' && <InboxPane />}
            {view === 'stats' && <StatsPane />}
            {view === 'drawing' && route.name === 'todo-drawing' && (
              <DrawingPane todoId={route.id} drawingId={route.drawingId} navigate={navigate} />
            )}
          </main>
          <AIPanel open={aiOpen} onToggle={toggleAi} />
        </div>
        <Statusbar route={route} />
        <ToastHost bus={toast} />
        <CommandPaletteHost open={paletteOpen} onClose={() => setPaletteOpen(false)} navigate={navigate} onCompose={() => { setPaletteOpen(false); setComposing(true); }} />
        <SettingsModal open={settingsOpen} onClose={closeSettings} />
      </div>
    </ErrorBoundary>
  );
};

const TaskDetail: React.FC<{
  todoId: string | null;
  composing: boolean;
  onCloseCompose: () => void;
  navigate: (to: string) => void;
}> = ({ todoId, composing, onCloseCompose, navigate }) => {
  if (composing) {
    return (
      <div className="task-detail task-detail--compose">
        <Composer onClose={onCloseCompose} navigate={navigate} />
      </div>
    );
  }
  if (!todoId) {
    return (
      <div className="task-detail task-detail--empty">
        <div className="task-detail__empty-glyph" aria-hidden="true">✓</div>
        <div className="task-detail__empty-title">未选择任务</div>
        <div className="task-detail__empty-hint">
          从左侧列表选择一个任务查看详情，或点击上方「新建任务」。
        </div>
      </div>
    );
  }
  return (
    <div className="task-detail">
      <TodoEditorPane todoId={todoId} navigate={navigate} />
    </div>
  );
};
