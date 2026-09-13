// Renderer entry — drives the static splash (defined in index.html) until
// the main process reports core-ready. STARTUP-AI-ASYNC-002 supersedes
// STARTUP-DSH-001's gate of `core.ready AND ai.ready/failed`:
//
//   splash 退出条件 = core.status === 'ready'
//
// DSH bootstrap is deferred until AFTER the React App has rendered its
// first frame. The renderer signals this back to main via a new IPC
// (`app.renderer.ready`); main schedules the actual warm-up at that
// point. The splash can come down immediately on core.ready alone,
// while the 22 s DSH cold-boot happens in the background behind the
// AIPane loading overlay.
//
// Why the deferral matters:
//   1. The static splash can't show interactive feedback during the
//      DSH warm-up — there's no UI to update, just a loading label.
//      Removing it as soon as core is ready gets the user into their
//      task list immediately, where they can keep working while DSH
//      loads.
//   2. The DSH warm-up runs dynamic imports + a Cordis boot + adapter
//      / tools / persistence / listeners assembly. On a cold Windows
//      cache, the dynamic imports alone can take 10–15 s; combined
//      with Cordis context creation it's been measured at ~22 s.
//      Running that work synchronously inside `markCoreReady()` used
//      to starve Electron's main-process event loop long enough for
//      Windows to mark the BrowserWindow "未响应".
//   3. Provider health / API key / model availability is NOT a
//      startup concern. `ai.ready` here means only that the local
//      Cordis runtime + adapter + tools + persistence + listeners
//      are wired up. Provider reachability is probed lazily on the
//      first `ai.ask` and surfaces as a typed error there — never
//      on the splash.
//
// Single-flight: a module-scoped `mountPromise` is assigned on first
// entry. Subsequent transitions (snapshot + every app:startup event)
// call `maybeMountApp` but only the first call performs the dynamic
// import + React mount. This avoids the StrictMode / duplicate-event
// race where two snapshots arrive back-to-back with `core.ready` and
// each one would otherwise kick its own dynamic import.
//
// Once React has mounted, the splash fades out. We then wait for two
// `requestAnimationFrame` ticks (a single RAF only guarantees the
// layout was computed, not that React's commit-and-paint cycle has
// finished flushing to the screen) and call `app.renderer.ready` to
// hand control back to main for the DSH warm-up. We log the IPC
// failure but never throw — a missing handshake just means the AI
// panel stays in 'pending' (which the user can retry by reloading).
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

  // Paint the latest core phase on the splash so the user sees
  // progress even if we loaded the bundle while core was already on a
  // later phase. We deliberately do NOT also paint the AI phase
  // anymore — under STARTUP-AI-ASYNC-002 the AI component's state is
  // independent of the splash gate; its UI lives in the AIPane once
  // we mount. The `app:startup` subscription below also only paints
  // the core phase.
  window.__splash.setPhase(snapshot.core.phase);

  // 2) Subscribe before doing anything async — events fired during step 3
  //    (e.g. ai-ready) must not be lost. The listener has to be typed as
  //    `(p: StartupSnapshot) => void` because the AppEvent union does not
  //    yet encode the payload shape for `app:startup`.
  bridge.on('app:startup', ((next: StartupSnapshot) => {
    window.__splash.setPhase(next.core.phase);
    void maybeMountApp(next);
  }) as Parameters<TodoListApi['on']>[1]);

  // 3) Try mounting immediately if core is already ready.
  void maybeMountApp(snapshot);
}

// STARTUP-AI-ASYNC-002 — single-flight mount. The previous implementation
// used a boolean `appMounted` guard, which is correct but doesn't
// help with concurrent snapshots arriving in the same microtask: both
// callers could observe `appMounted === false` before the first one
// flips it. The `mountPromise` pattern (assign on first call, await
// it on every subsequent call) is strictly race-free — the React
// mount sequence runs at most once per page load, even under
// React StrictMode double-mount + duplicate startup events.
//
// A separate `rendererReadySent` flag tracks the `app.renderer.ready`
// handshake. We track it locally rather than relying on `mountPromise`
// because mountPromise only resolves when mountApp() finishes, but
// the handshake has to fire AFTER the splash is removed (which
// happens inside mountApp via RAF). Tracking it as a module-scoped
// flag means reload → remount fires a fresh signal, while duplicate
// `app:startup` events during one page-load don't.
let mountPromise: Promise<void> | null = null;
let rendererReadySent = false;

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
  // STARTUP-AI-ASYNC-002: the splash gate is core.ready alone. DSH
  // state (pending / loading / ready / failed) is owned by the AIPane
  // once we mount — see AIPane's loading overlay / retry banner.
  // Mounting now puts the user into their task list immediately;
  // the DSH cold-boot runs in parallel behind a loading UI.
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

    // STARTUP-AI-ASYNC-002 — hand control back to main for the DSH
    // warm-up ONLY AFTER React's commit-and-paint cycle has flushed.
    // Two RAFs is the canonical "first paint done" signal: the first
    // schedules work for the next frame, the second runs after that
    // frame has been painted. Without this, main could receive the
    // handshake while React is still mid-commit and immediately start
    // the heavy `import('@deepseek-ai/dsh-app-boot')` chain — that
    // dynamic import competes with React's paint for the same main-
    // process I/O budget on a cold cache.
    //
    // We remove the splash and signal the handshake in the same
    // tick, so the user sees the AIPane "正在启动 AI 助手…" overlay
    // appear immediately (the AI panel is part of the React tree we
    // just mounted). The flag prevents a second signal on StrictMode
    // remount or duplicate `app:startup` events.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.__splash.remove();
        if (!rendererReadySent) {
          rendererReadySent = true;
          void signalRendererReady();
        }
      });
    });
    const dshNote = snap.ai.status === 'failed'
      ? `dsh=local-failed (${snap.ai.errorMessage ?? 'no-message'})`
      : snap.ai.status === 'ready'
        ? 'dsh=local-ready'
        : 'dsh=will-boot-in-background';
    logger.info(`renderer: app mounted after ${Date.now() - startupWatchStart}ms (${dshNote})`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    showFatal(`加载主界面失败:${reason}`);
    // Reset so a future reload can try again.
    mountPromise = null;
  }
}

// STARTUP-AI-ASYNC-002 — renderer → main handshake. Fire-and-forget;
// the only failure mode is "main said no / IPC channel missing",
// which leaves the AI panel in 'pending' forever. We log at warn
// rather than escalating because the user-visible failure is just
// "the AI panel keeps showing 正在启动 AI 助手…" — the rest of the
// app is fully functional. A second call (reload + mount) is
// guarded by `rendererReadySent`.
async function signalRendererReady(): Promise<void> {
  const bridge: TodoListApi | undefined = window.todoList;
  if (!bridge?.app?.rendererReady) {
    logger.info('app.renderer.ready: bridge missing (older build?) — AI boot stays pending');
    return;
  }
  try {
    const res = await bridge.app.rendererReady();
    if (!res.ok) {
      logger.info(`app.renderer.ready: main declined (${res.code ?? 'unknown'}) — AI boot stays pending`);
    }
  } catch (err) {
    logger.info(`app.renderer.ready: IPC failed (${(err as Error).message}) — AI boot stays pending`);
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
