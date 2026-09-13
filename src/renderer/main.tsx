// Renderer entry — drives the static splash (defined in index.html) until
// the main process reports core-ready. Once core is ready, dynamically
// imports the App bundle (which itself lazy-loads SettingsModal /
// DocumentsView / DrawingPane / StatsPane) and removes the splash.
//
// Why dynamic import for App?
//   - `main.tsx` stays tiny so the splash paints immediately. The full
//     React + react-dom + hook tree of App is only paid for AFTER we know
//     core data is usable.
//   - If the App bundle fails to parse (chunk loading error, runtime
//     exception during eval) we surface the failure on the splash with a
//     reload button, instead of leaving a blank white window.

import type { StartupSnapshot } from '../shared/ipc-schema';
import type { TodoListApi } from '../shared/todo-list-api';
import './global';

const SLOW_THRESHOLD_MS = 4000;
const startupWatchStart = Date.now();
let lastPhaseAt = Date.now();

function showFatal(message: string): void {
  // Splash is the only DOM we can rely on. Render a useful error and let
  // the user reload — do NOT throw, because the static onerror hook in
  // index.html already covers script-level failures.
  try {
    window.__splash.showError(message, true);
  } catch {
    // ignore
  }
}

async function bootstrap(): Promise<void> {
  const bridge: TodoListApi | undefined = window.todoList;
  if (!bridge?.app?.startupGet) {
    showFatal('主进程桥接不可用,请重新加载。');
    return;
  }

  // 1) Snapshot first — avoid the race where core becomes ready between
  //    page-load and event-listener registration.
  let snapshot: StartupSnapshot | undefined;
  try {
    const res = await bridge.app.startupGet();
    if (res?.ok && res.data) snapshot = res.data;
  } catch (err) {
    showFatal(`读取启动状态失败:${(err as Error)?.message ?? '未知错误'}`);
    return;
  }
  if (!snapshot) {
    showFatal('主进程未返回启动状态,请重新加载。');
    return;
  }

  // Paint the latest phase on the splash so the user sees progress even if
  // we loaded the bundle while core was already on a later phase.
  window.__splash.setPhase(snapshot.core.phase);

  // 2) Subscribe before doing anything async — events fired during step 3
  //    (e.g. ai-ready) must not be lost. The listener has to be typed as
  //    `(p: StartupSnapshot) => void` because the AppEvent union does not
  //    yet encode the payload shape for `app:startup`. See todo-list-api
  //    AppEventMap.
  bridge.on('app:startup', ((next: StartupSnapshot) => {
    window.__splash.setPhase(next.core.phase);
    void maybeMountApp(next);
  }) as Parameters<TodoListApi['on']>[1]);

  // 3) Try mounting immediately if core is already ready.
  void maybeMountApp(snapshot);
}

let appMounted = false;
async function maybeMountApp(snap: StartupSnapshot): Promise<void> {
  if (appMounted) return;
  if (snap.core.status === 'failed') {
    showFatal(snap.core.errorMessage ?? '核心数据初始化失败。');
    return;
  }
  if (snap.core.status !== 'ready') {
    // Still loading. Show slow hint if we've been on the same phase for a
    // long time.
    if (Date.now() - lastPhaseAt > SLOW_THRESHOLD_MS) {
      window.__splash.setPhase(snap.core.phase); // re-trigger slow banner
    }
    lastPhaseAt = Date.now();
    return;
  }
  appMounted = true;
  try {
    // Dynamic import keeps the splash chunk small. The App bundle pulls
    // react-dom, the global stylesheet, and the bulk of the app shell.
    const mod = await import('./App');
    const { App } = mod;
    const rootEl = document.getElementById('root');
    if (!rootEl) {
      showFatal('挂载节点不存在,请重新加载。');
      return;
    }
    // Inject the global stylesheet AFTER import so splash CSS isn't
    // overridden before main paint.
    await import('./styles/global.css');

    // Use React's createRoot — pull from the dynamic React module so the
    // entry chunk stays slim.
    const ReactMod = await import('react');
    const ReactDomMod = await import('react-dom/client');
    const root = ReactDomMod.createRoot(rootEl);
    root.render(
      ReactMod.default.createElement(
        ReactMod.default.StrictMode,
        null,
        ReactMod.default.createElement(App, null),
      ),
    );
    // Only after React has mounted do we remove the splash. The renderer's
    // first paint may still take a tick, but the splash covers that gap
    // (already loaded, no extra network).
    requestAnimationFrame(() => {
      window.__splash.remove();
    });
    logger.info(`renderer: app mounted after ${Date.now() - startupWatchStart}ms`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    showFatal(`加载主界面失败:${reason}`);
  }
}

// Lightweight logger — main.tsx lives BEFORE React + the rest of the app
// are loaded, so we can't pull the project logger here. Use console
// directly; the main process's logger file is unrelated.
const logger = {
  info: (msg: string): void => {
    // eslint-disable-next-line no-console
    console.log(`[renderer:startup] ${msg}`);
  },
};

bootstrap().catch((err) => {
  showFatal(`启动失败:${(err as Error)?.message ?? '未知错误'}`);
});