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
import { useToastBus } from './components/Toast';
import { CommandPaletteHost } from './components/CommandPalette';
import { SettingsModal } from './components/SettingsModal';
import { Composer } from './components/Composer';
import { TodoListPane } from './panes/TodoListPane';
import { TodoEditorPane } from './panes/TodoEditorPane';
import { StatsPane } from './panes/StatsPane';
import { DrawingPane } from './panes/DrawingPane';
import { DocumentsView } from './components/DocumentsView';
import { PaneDivider } from './components/PaneDivider';
import { IconCheck } from './components/icons';
import { usePaneWidths } from './hooks/usePaneWidths';
import { parseHash, routeToHash, type Route, type ListFilter, type SortKey } from './router';
import { useAppEvent, useTodo } from './hooks/useTodoListApi';
import { emitDataChanged } from './data-bus';
import { IconFullscreenExit } from './components/icons';

const AI_OPEN_KEY = 'todo-list.aiOpen';

type View = 'list' | 'stats' | 'drawing';

function deriveView(route: Route): View {
  switch (route.name) {
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
  const [listSort, setListSort] = useState<SortKey>('alpha');
  // Fullscreen document mode: hides the task list + basic-info/links/activity
  // chrome, keeps the AI panel. The DocumentsView's tab bar shows an exit
  // button (IconFullscreenExit) so the user can drop back out.
  const [fullscreenTodoId, setFullscreenTodoId] = useState<string | null>(null);
  // Per-task active document tab. Lives in App (not in DocumentsView) because
  // entering fullscreen unmounts the normal-mode DocumentsView and mounts a
  // fresh fullscreen-mode one — without lifting state, every fullscreen
  // toggle snapped the user back to the first tab of the same task. Keyed
  // by todoId so multiple open tasks keep their own selection.
  const [selectedDocByTodo, setSelectedDocByTodo] = useState<Record<string, string>>({});
  const [aiOpen, setAiOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(AI_OPEN_KEY) !== '0';
    } catch {
      return true;
    }
  });
  // Resizable panes: list (left) + AI (right) widths persist across restarts.
  // The detail pane is flex:1, so it absorbs the remainder.
  const { listWidth, aiWidth, setListWidth, setAiWidth } = usePaneWidths();

  useEffect(() => {
    const onHash = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Sync the list filter + sort from #/list/<path>?sort=<key> deep links.
  useEffect(() => {
    if (route.name === 'list') {
      setListFilter(route.filter);
      setListSort(route.sort);
    }
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

  // Esc drops out of fullscreen doc mode (the inverse of clicking the fullscreen icon).
  useEffect(() => {
    if (!fullscreenTodoId) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setFullscreenTodoId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreenTodoId]);

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
    location.hash = routeToHash({ name: 'list', filter: f, sort: listSort });
  }, [listSort]);
  const selectSort = useCallback((s: SortKey) => {
    setListSort(s);
    location.hash = routeToHash({ name: 'list', filter: listFilter, sort: s });
  }, [listFilter]);

  const view = deriveView(route);
  const selectedId = route.name === 'todo' ? route.id : null;
  const showFullscreen = view === 'list' && fullscreenTodoId !== null && selectedId === fullscreenTodoId;

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
          listSort={listSort}
          onSelectSort={selectSort}
        />
        <div className="app-body">
          <main className={`app-main${view === 'list' ? ' is-master' : ''}`}>
            {view === 'list' && showFullscreen && selectedId && (
              <FullscreenDoc
                todoId={selectedId}
                onExit={() => setFullscreenTodoId(null)}
                selectedDocId={selectedDocByTodo[selectedId] ?? null}
                onSelectDoc={(tabId) => setSelectedDocByTodo((m) => ({ ...m, [selectedId]: tabId }))}
              />
            )}
            {view === 'list' && !showFullscreen && (
              <div className="master-detail">
                <TodoListPane
                  width={listWidth}
                  filter={listFilter}
                  sort={listSort}
                  selectedId={selectedId}
                  onSelect={(id) => navigate(routeToHash({ name: 'todo', id }))}
                  onOpenSettings={() => setSettingsOpen(true)}
                  onCompose={() => setComposing(true)}
                  toastBus={toast}
                />
                <PaneDivider onDrag={(dx) => setListWidth(listWidth + dx)} />
                <TaskDetail
                  todoId={selectedId}
                  composing={composing}
                  onCloseCompose={() => setComposing(false)}
                  navigate={navigate}
                  onFullscreen={(todoId) => setFullscreenTodoId(todoId)}
                  selectedDocId={selectedId ? selectedDocByTodo[selectedId] ?? null : null}
                  onSelectDoc={(tabId) => {
                    if (!selectedId) return;
                    setSelectedDocByTodo((m) => ({ ...m, [selectedId]: tabId }));
                  }}
                />
              </div>
            )}
            {view === 'stats' && <StatsPane />}
            {view === 'drawing' && route.name === 'todo-drawing' && (
              <DrawingPane todoId={route.id} drawingId={route.drawingId} navigate={navigate} />
            )}
          </main>
          {aiOpen && <PaneDivider onDrag={(dx) => setAiWidth(aiWidth - dx)} />}
          <AIPanel open={aiOpen} width={aiWidth} onToggle={toggleAi} />
        </div>
        <Statusbar route={route} />
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
  onFullscreen: (todoId: string) => void;
  selectedDocId: string | null;
  onSelectDoc: (tabId: string) => void;
}> = ({ todoId, composing, onCloseCompose, navigate, onFullscreen, selectedDocId, onSelectDoc }) => {
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
        <IconCheck size={28} className="task-detail__empty-glyph" />
        <div className="task-detail__empty-title">未选择任务</div>
        <div className="task-detail__empty-hint">
          从左侧列表选择一个任务查看详情，或点击上方「新建任务」。
        </div>
      </div>
    );
  }
  return (
    <div className="task-detail">
      <TodoEditorPane
        todoId={todoId}
        onFullscreen={() => onFullscreen(todoId)}
        selectedDocId={selectedDocId}
        onSelectDoc={onSelectDoc}
      />
    </div>
  );
};

/** FullscreenDoc — the document workspace fills the detail area; the task list
 *  disappears. The AI panel stays so the user can keep asking questions about
 *  whatever they're editing. Esc / the fullscreen-exit button drop back to normal mode. */
const FullscreenDoc: React.FC<{
  todoId: string;
  onExit: () => void;
  selectedDocId: string | null;
  onSelectDoc: (tabId: string) => void;
}> = ({ todoId, onExit, selectedDocId, onSelectDoc }) => {
  const { todo } = useTodo(todoId);
  const taskTitle = todo?.title ?? null;
  return (
    <div className="task-detail task-detail--fullscreen">
      <div className="fullscreen-doc">
        <div className="fullscreen-doc__header">
          <div className="fullscreen-doc__title">{taskTitle ?? '任务'}</div>
          <button
            type="button"
            className="fullscreen-doc__exit"
            onClick={onExit}
            title="退出全屏 (Esc)"
            aria-label="退出全屏"
          >
            <IconFullscreenExit size={16} /> 退出全屏
          </button>
        </div>
        <div className="fullscreen-doc__body">
          <DocumentsView
            todoId={todoId}
            taskTitle={taskTitle}
            onFullscreen={onExit}
            selectedDocId={selectedDocId}
            onSelectDoc={onSelectDoc}
          />
        </div>
      </div>
    </div>
  );
};
