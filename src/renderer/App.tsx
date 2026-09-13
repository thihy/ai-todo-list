// App shell. The main area is a master-detail layout: task list (left) +
// task detail (right); the resident AI panel sits further right and collapses
// to a rail. Settings is a modal (not a route pane), opened from the bottom-left
// user chip or the 菜单 button. The Sidebar is gone — view switching lives in
// the title-bar 过滤 popover, and quick actions in the 菜单 / user menu.

import React, { useEffect, useState, useCallback, Suspense } from 'react';
import { ErrorBoundary } from './ErrorBoundary';
import { Topbar } from './layout/Topbar';
import { Statusbar } from './layout/Statusbar';
import { AIPanel } from './layout/AIPanel';
import { useToastBus } from './components/Toast';
import { CommandPaletteHost } from './components/CommandPalette';
// SettingsModal pulls the whole settings UI tree (ModelPane + CustomProviders-
// Editor + TaskAppearancePane + TagInput + useSettings). It's only opened
// occasionally — keep it out of the initial bundle.
const SettingsModal = React.lazy(() =>
  import('./components/SettingsModal').then((m) => ({ default: m.SettingsModal })),
);
import {
  PlanGuideModal,
  todayDateKey,
} from './components/PlanGuideModal';
import { Composer, type ExternalAiSubmitDetail } from './components/Composer';
import { TodoListPane } from './panes/TodoListPane';
// TodoEditorPane is the task-detail body. Only rendered when the user has
// actually selected a task — split it off so the typical cold-start (no
// selection yet) doesn't pay for its dependencies (MarkdownEditor +
// DocumentsView + DrawingPane chains).
const TodoEditorPane = React.lazy(() =>
  import('./panes/TodoEditorPane').then((m) => ({ default: m.TodoEditorPane })),
);
// StatsPane is a separate top-level view; pulling Excalidraw-adjacent
// deps isn't worth it for a route most users only open occasionally.
const StatsPane = React.lazy(() =>
  import('./panes/StatsPane').then((m) => ({ default: m.StatsPane })),
);
// DrawingPane wraps an Excalidraw canvas — heavy and isolated. Only
// loaded when the user navigates to the drawing route.
const DrawingPane = React.lazy(() =>
  import('./panes/DrawingPane').then((m) => ({ default: m.DrawingPane })),
);
// Lazy-load DocumentsView: it statically pulls MarkdownEditor + the mermaid
// dependency tree, which is heavy and only needed in the fullscreen-doc route.
// Splitting it off the entry chunk keeps cold start on the todo-list shell.
const DocumentsView = React.lazy(() =>
  import('./components/DocumentsView').then(m => ({ default: m.DocumentsView })),
);
import { PaneDivider } from './components/PaneDivider';
import { IconCheck, IconChevronRight } from './components/icons';
import { usePaneWidths } from './hooks/usePaneWidths';
import { parseHash, routeToHash, type Route, type ListFilter, type SortKey } from './router';
import { useAppEvent, useTodo, useSettings } from './hooks/useTodoListApi';
import { emitDataChanged } from './data-bus';
import { IconFullscreenExit } from './components/icons';

const AI_OPEN_KEY = 'todo-list.aiOpen';
const LIST_OPEN_KEY = 'todo-list.listOpen';

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
  const [pendingAiCreate, setPendingAiCreate] = useState<ExternalAiSubmitDetail | null>(null);
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
  // Task list open state — mirrors AI's aiOpen. Open by default; user can
  // collapse the master column to a thin rail (just like the AI panel does)
  // when the detail pane is the focus. Persisted so the layout survives
  // restart. The rail itself is a flex sibling with a single expand button,
  // not a magic-bar — the affordance is the [|] icon.
  const [listOpen, setListOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LIST_OPEN_KEY) !== '0';
    } catch {
      return true;
    }
  });
  // Resizable panes: AI width persists across restarts. The detail pane is
  // flex:1, so it absorbs the remainder. The task list width is fixed at
  // its persisted value (no drag-resize); the previous 16px grip column on
  // its right edge was removed when the collapse affordance moved INTO the
  // panel header (see TodoListPane + AIPane).
  const { listWidth, aiWidth, setAiWidth } = usePaneWidths();
  // —— 每日计划引导 ——
  // 启动时 + 通知点击都可能弹 PlanGuideModal。settings.dailyPlanReminderTime
  // 和 snoozePlanGuideUntil 都在 useSettings() 里读，patch() 写回。
  const settings = useSettings();
  const [planGuideOpen, setPlanGuideOpen] = useState(false);
  // candidates 缓存：modal 打开那一刻拉一次（避免渲染期间 dataVersion 触发
  // 重渲染时 modal 里列表跳变）。Modal 自己 sortCandidates + slice(12)，
  // 所以即使缓存是全集也没问题。
  const [planCandidates, setPlanCandidates] = useState<import('../shared/todo-types').Todo[]>([]);
  const todayKey = React.useMemo(() => todayDateKey(), []);

  // 启动时根据 settings 决定是否弹引导。
  // 规则（与 plan-reminder.ts 一致）：
  //   - snoozePlanGuideUntil > now  → 跳过
  //   - lastPlanGuideDate === today → 跳过
  //   - today 已 planned 至少一个 → 不必引导，但仍允许用户主动调起
  //   - 其他情况 → 引导一次
  // settings 是 useSettings() 的返回；data 首次为 null 时 effect 不会跑（避免
  // 在 settings 还没拉到时弹），data 一就绪就重跑。
  useEffect(() => {
    if (!settings.data) return;
    const s = settings.data;
    const now = Date.now();
    const snoozed = s.snoozePlanGuideUntil != null && s.snoozePlanGuideUntil > now;
    const resolvedToday = s.lastPlanGuideDate === todayKey;
    if (snoozed || resolvedToday) return;
    // 已经 planned 了不主动弹 —— 但通知点击 / 用户主动调起路径仍能开。
    void window.todoList.todo.list({}).then((res) => {
      if (!res.ok) return;
      const all = res.data as import('../shared/todo-types').Todo[];
      const alreadyPlannedToday = all.some((t) => t.plannedFor === todayKey);
      if (alreadyPlannedToday) {
        // 仅写 lastPlanGuideDate，避免明天重复判定同一段 loaded 状态。
        // 失败时仅 toast —— 不会让用户卡在引导界面。
        settings.patch({ lastPlanGuideDate: todayKey }).catch((err: unknown) => {
          const reason = err instanceof Error && err.message ? err.message : '未知错误';
          toast.push({ kind: 'error', message: `保存引导状态失败：${reason}`, ttl: 3000 });
        });
        return;
      }
      // 全集作为候选 —— modal 自己排序 + 截前 12。
      setPlanCandidates(all.filter((t) => !t.archivedAt && !t.deletedAt));
      setPlanGuideOpen(true);
    });
    // effect 只在 settings.data 首次就绪 + 今日日期变更时跑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.data, todayKey]);

  // 通知点击触发：从 main 进程推 `app:plan-guide`，App 重新计算候选并打开 modal。
  useAppEvent('app:plan-guide', () => {
    void window.todoList.todo.list({}).then((res) => {
      if (!res.ok) return;
      setPlanCandidates(
        (res.data as import('../shared/todo-types').Todo[]).filter(
          (t) => !t.archivedAt && !t.deletedAt,
        ),
      );
      setPlanGuideOpen(true);
    });
  });

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

  useEffect(() => {
    try {
      localStorage.setItem(LIST_OPEN_KEY, listOpen ? '1' : '0');
    } catch {
      // ignore storage errors
    }
  }, [listOpen]);

  useAppEvent('app:toggle-ai', () => setAiOpen((v) => !v));
  useAppEvent('app:navigate', ({ route }) => {
    if (route) location.hash = route.startsWith('#') ? route : `#/${route}`;
  });
  // Bridge main→renderer data-changed pushes (AI tools mutate the DB in the
  // main process) to the renderer data bus, which re-fetches affected hooks.
  useAppEvent('app:data-changed', ({ scope }) => emitDataChanged(scope));

  // Tag catalog mutations also need the data bus to notify hooks
  // reading from tag.activeCatalog / tag.list. The event payload also
  // carries `affectedTodoIds` — we translate that into a 'todos'
  // scope bump so any open TodoListPane / detail refetches those rows
  // (otherwise a rename in the management pane leaves the open list
  // showing the old name until the next refresh).
  useAppEvent('app:tags-changed', (payload) => {
    emitDataChanged('tags');
    if (payload.affectedTodoIds && payload.affectedTodoIds.length > 0) {
      emitDataChanged('todos');
    }
  });

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
  const toggleList = useCallback(() => setListOpen((v) => !v), []);
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

  // —— Plan guide handlers ——
  // confirm: 逐个 update plannedFor（走 IPC patch 通道），最后写 lastPlanGuideDate。
  // 出错只 toast 提示，不阻止后续 update —— 已经写入的 plannedFor 自然让任务
  // 进入今日区，未写入的留在候选列表。
  const onPlanGuideConfirm = useCallback(async (ids: string[]): Promise<void> => {
    for (const id of ids) {
      const res = await window.todoList.todo.update(id, { plannedFor: todayKey });
      if (!res.ok) toast.push({ kind: 'error', message: '添加今日任务失败', ttl: 2000 });
    }
    try {
      await settings.patch({ lastPlanGuideDate: todayKey });
    } catch (err) {
      // The actual task updates already happened; failing only to record
      // the resolved date just means tomorrow's boot may re-prompt. Surface
      // it but don't block the modal from closing.
      const reason = err instanceof Error && err.message ? err.message : '未知错误';
      toast.push({ kind: 'error', message: `保存引导状态失败：${reason}`, ttl: 3000 });
    }
    setPlanGuideOpen(false);
    // 通知 TodoListPane refresh — 已有 app:data-changed { scope: 'todos' }
    // 会驱动 refresh；这里额外 emit 一次以防 race。
    emitDataChanged('todos');
  }, [todayKey, settings, toast]);

  const onPlanGuideSkip = useCallback(async (): Promise<void> => {
    try {
      await settings.patch({ lastPlanGuideDate: todayKey });
    } catch (err) {
      const reason = err instanceof Error && err.message ? err.message : '未知错误';
      toast.push({ kind: 'error', message: `保存引导状态失败：${reason}`, ttl: 3000 });
    }
    setPlanGuideOpen(false);
  }, [todayKey, settings, toast]);

  const onPlanGuideSnooze = useCallback(async (): Promise<void> => {
    // 24h 后再提醒。lastPlanGuideDate 不写 —— 24h 后仍属"未解决"，boot + 通知
    // 都会重新询问。
    try {
      await settings.patch({ snoozePlanGuideUntil: Date.now() + 24 * 60 * 60_000 });
    } catch (err) {
      const reason = err instanceof Error && err.message ? err.message : '未知错误';
      toast.push({ kind: 'error', message: `保存引导状态失败：${reason}`, ttl: 3000 });
    }
    setPlanGuideOpen(false);
  }, [settings, toast]);

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
                {/* Task list host: flex row, mirrors the AI panel's pattern
                    (open content + 16px grip on the right). When the list
                    is collapsed, swap the whole host for a thin 40px rail
                    with the same [|] expand affordance so the user can
                    pop it back open without hunting through menus. */}
                {listOpen ? (
                  // Collapse affordance is rendered INSIDE the task list's
                  // own header (right edge of .task-list__header, via the
                  // .task-list__collapse-btn button) — not in a separate
                  // 16px grip column on the panel's right edge. The user
                  // reads the icon as "part of the area" they're looking
                  // at, not as a chrome handle on a divider strip. Same
                  // pattern as the AI panel (see layout/AIPanel.tsx).
                  <TodoListPane
                    width={listWidth}
                    filter={listFilter}
                    sort={listSort}
                    selectedId={selectedId}
                    onSelect={(id) => navigate(routeToHash({ name: 'todo', id }))}
                    onOpenSettings={() => setSettingsOpen(true)}
                    onCompose={() => setComposing(true)}
                    onCollapse={toggleList}
                    toastBus={toast}
                  />
                ) : (
                  <button
                    type="button"
                    className="task-list-rail"
                    onClick={toggleList}
                    aria-label="展开任务列表"
                    aria-expanded={false}
                  >
                    {/* No top icon — the rail is the COLLAPSED state, so
                        showing a "collapse" affordance here is semantically
                        redundant. Mirrors the AI rail, whose top icon is
                        the AI brand (IconSparkle), not a collapse glyph;
                        the task rail's "brand" is just the vertical "任务"
                        label. The trailing chevron at the rail's bottom
                        (margin-top: auto on .task-list-rail svg) is the
                        actual expand affordance. */}
                    <span className="task-list-rail__label">任务</span>
                    <IconChevronRight size={14} />
                  </button>
                )}
                <TaskDetail
                  todoId={selectedId}
                  composing={composing}
                  onCloseCompose={() => setComposing(false)}
                  onAiSubmit={(detail) => {
                    setPendingAiCreate(detail);
                    setAiOpen(true);
                  }}
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
            {view === 'stats' && (
              <Suspense fallback={<div className="ai-panel__loading" role="status" aria-live="polite">加载中…</div>}>
                <StatsPane />
              </Suspense>
            )}
            {view === 'drawing' && route.name === 'todo-drawing' && (
              <Suspense fallback={<div className="ai-panel__loading" role="status" aria-live="polite">加载中…</div>}>
                <DrawingPane todoId={route.id} drawingId={route.drawingId} navigate={navigate} />
              </Suspense>
            )}
          </main>
          {aiOpen && <PaneDivider onDrag={(dx) => setAiWidth(aiWidth - dx)} />}
          <AIPanel
            open={aiOpen}
            width={aiWidth}
            onToggle={toggleAi}
            externalSubmit={pendingAiCreate}
            onExternalSubmitConsumed={() => setPendingAiCreate(null)}
          />
        </div>
        <Statusbar route={route} />
        <CommandPaletteHost open={paletteOpen} onClose={() => setPaletteOpen(false)} navigate={navigate} onCompose={() => { setPaletteOpen(false); setComposing(true); }} />
        <Suspense fallback={null}>
          <SettingsModal open={settingsOpen} onClose={closeSettings} />
        </Suspense>
        <PlanGuideModal
          open={planGuideOpen}
          candidates={planCandidates}
          todayKey={todayKey}
          onConfirm={onPlanGuideConfirm}
          onSkip={onPlanGuideSkip}
          onSnooze={onPlanGuideSnooze}
        />
      </div>
    </ErrorBoundary>
  );
};

const TaskDetail: React.FC<{
  todoId: string | null;
  composing: boolean;
  onCloseCompose: () => void;
  onAiSubmit: (detail: ExternalAiSubmitDetail) => void;
  navigate: (to: string) => void;
  onFullscreen: (todoId: string) => void;
  selectedDocId: string | null;
  onSelectDoc: (tabId: string) => void;
}> = ({ todoId, composing, onCloseCompose, onAiSubmit, navigate, onFullscreen, selectedDocId, onSelectDoc }) => {
  if (composing) {
    return (
      <div className="task-detail task-detail--compose">
        <Composer onClose={onCloseCompose} navigate={navigate} onAiSubmit={onAiSubmit} />
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
      <Suspense fallback={<div className="ai-panel__loading" role="status" aria-live="polite">加载任务详情…</div>}>
        <TodoEditorPane
          todoId={todoId}
          onFullscreen={() => onFullscreen(todoId)}
          selectedDocId={selectedDocId}
          onSelectDoc={onSelectDoc}
        />
      </Suspense>
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
          <Suspense fallback={<div className="ai-panel__loading" role="status" aria-live="polite">加载中…</div>}>
            <DocumentsView
              todoId={todoId}
              taskTitle={taskTitle}
              onFullscreen={onExit}
              selectedDocId={selectedDocId}
              onSelectDoc={onSelectDoc}
            />
          </Suspense>
        </div>
      </div>
    </div>
  );
};
