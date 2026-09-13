// Renderer entry — drives the static splash (defined in index.html) until
// the main process reports BOTH core-ready AND a terminal DSH state.
// STARTUP-DSH-001: the splash previously came down as soon as core was
// ready, which left the first AI interaction paying the full Cordis
// cold-boot cost (1–3 s on warm cache, much more on cold Windows) and
// could push the BrowserWindow into "未响应" while the dsh-runtime
// was still resolving its dynamic imports. The new gate is:
//
//   core.status === 'ready' AND ai.status IN ('ready', 'failed')
//
// `ai.failed` here is a LOCAL DSH boot failure only (cordis.yml missing,
// plugin tree assembly failed, critical ctx service absent — see
// src/main/startup-state.ts markAiFailed). It does NOT block the
// splash from coming down: the AIPane renders its own "DSH 初始化失败"
// state and the rest of the app is fully usable. Network / API-key /
// provider errors are surfaced per-request inside `ai.ask` and never
// reach the splash.
//
// Single-flight: a module-scoped `mountPromise` is assigned on first
// entry. Subsequent transitions (snapshot + every app:startup event)
// call `maybeMountApp` but only the first call performs the dynamic
// import + React mount. This avoids the StrictMode / duplicate-event
// race where two snapshots arrive back-to-back with `core.ready +
// ai.ready` and each one would otherwise kick its own dynamic import.
//
// Once React has mounted, the splash fades out and the unhides the
// #root container. The dynamic import keeps the splash chunk tiny —
// the bulk of React + react-dom + the hook tree is paid for only
// after we know core data is usable.
//
// If the App bundle fails to parse (chunk loading error, runtime
// exception during eval) we surface the failure on the splash with a
// reload button, instead of leaving a blank white window.

import type { StartupSnapshot } from '../shared/ipc-schema';
import type { TodoListApi } from '../shared/todo-list-api';
// `window.__splash` 的类型由 src/renderer/global.d.ts 自动合入 Window
// 全局类型空间 —— 不需要也不应该在这里 side-effect import 该声明文件，
// 那样会让 Vite 的 import-analysis 当成运行时模块去解析它并报错。

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
    // STARTUP-DSH-001: surface the DSH loading phase on the splash
    // too — when core is ready but the warm-up is still in flight the
    // user should see "正在启动 DSH…" rather than the now-familiar
    // "就绪" (which would falsely imply AI is ready).
    if (next.core.status === 'ready') {
      window.__splash.setPhase(next.ai.phase);
    }
    void maybeMountApp(next);
  }) as Parameters<TodoListApi['on']>[1]);

  // 3) Try mounting immediately if core is already ready.
  void maybeMountApp(snapshot);
}

// STARTUP-DSH-001 — single-flight mount. The previous implementation
// used a boolean `appMounted` guard, which is correct but doesn't
// help with concurrent snapshots arriving in the same microtask: both
// callers could observe `appMounted === false` before the first one
// flips it. The `mountPromise` pattern (assign on first call, await
// it on every subsequent call) is strictly race-free — the React
// mount sequence runs at most once per page load, even under
// React StrictMode double-mount + duplicate startup events.
let mountPromise: Promise<void> | null = null;

async function maybeMountApp(snap: StartupSnapshot): Promise<void> {
  if (mountPromise) {
    // Someone else is already mounting. Wait for them; this resolves
    // immediately if they've already finished.
    return mountPromise;
  }
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
  // STARTUP-DSH-001: core is ready but the splash must remain up until
  // the DSH bootstrap reaches a terminal state. `ai.loading` and
  // `ai.pending` mean "still booting locally"; `ai.ready` and
  // `ai.failed` are both acceptable triggers for mount.
  if (snap.ai.status !== 'ready' && snap.ai.status !== 'failed') {
    // Show the DSH loading phase on the splash so the user sees
    // progress rather than a static "ready" label.
    window.__splash.setPhase(snap.ai.phase);
    return;
  }
  mountPromise = mountApp(snap);
  try {
    await mountPromise;
  } finally {
    // Keep the resolved promise around so subsequent calls observe
    // the "already-mounted" fast-path. We don't null it.
  }
}

async function mountApp(snap: StartupSnapshot): Promise<void> {
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
    const dshNote = snap.ai.status === 'failed'
      ? `dsh=local-failed (${snap.ai.errorMessage ?? 'no-message'})`
      : 'dsh=local-ready';
    logger.info(`renderer: app mounted after ${Date.now() - startupWatchStart}ms (${dshNote})`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    showFatal(`加载主界面失败:${reason}`);
    // Reset so a future reload can try again.
    mountPromise = null;
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