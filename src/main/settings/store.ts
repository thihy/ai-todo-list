// Settings persistence. The config file lives in a STABLE location (app
// userData) so it can be read before the data directory is known. The data
// directory (DB, markdown, drawings) is configurable via `dataDir` and is
// resolved lazily — null means "default location" (userData/../ROOT_DIR_NAME),
// preserving the pre-settings-picker behaviour for existing installs.
//
// API key lives only here; the renderer always receives a redacted form.

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { DEFAULT_CAPTURE_HOTKEY, ROOT_DIR_NAME, CONFIG_FILENAME, DEFAULT_PROVIDER } from '../../shared/constants';
import type { AIModel, AIProvider, CustomProviderConfig, CustomProviderInput } from '../../shared/ai-types';
import type { TagDef } from '../../shared/todo-types';
import { DEFAULT_TASK_APPEARANCE, type TaskAppearance, normalizeTaskAppearance } from '../../shared/task-appearance';

export interface PersistedSettings {
  provider: AIProvider;
  apiKey: string | null;
  model: AIModel;
  streaming: boolean;
  captureHotkey: string;
  theme: 'system' | 'light' | 'dark';
  lastHeartbeatAt: number | null;
  monthlyCostUsd: number;
  /** Absolute path to the data directory, or null for the default location. */
  dataDir: string | null;
  /** User-defined custom provider instances. */
  customProviders: CustomProviderConfig[];
  /** Active custom instance id when provider==='custom'; null = none. */
  customProviderId: string | null;
  /** Auto-archive: a `done` task is archived once its done_at is older than
   *  this many days. 0 = never auto-archive (manual archive only). The boot
   *  sweep + hourly interval in index.ts read this. */
  archiveAfterDays: number;
  /** Tag registry — names with a user-chosen colour. Tagged todos reference
   *  tags by plain string (Todo.tags); this holds the palette + autocomplete
   *  source, managed in Settings. */
  tags: TagDef[];
  /** 「今日待办」 reminder time (HH:MM, 24h). When the clock matches and the
   *  user hasn't planned any tasks for today, the main process fires an OS
   *  notification (see src/main/notification/plan-reminder.ts). Default
   *  09:00 — a gentle morning nudge. */
  dailyPlanReminderTime: string;
  /** Last day the startup guide was either shown or skipped/completed,
   *  format `YYYY-MM-DD`. Read by App.tsx to suppress re-prompting the same
   *  day; the daily reminder still fires even after the guide has been
   *  resolved for the day (the guide is the landing modal, the reminder is
   *  the OS push). */
  lastPlanGuideDate: string | null;
  /** Epoch-ms snooze deadline set by 「改天再提醒」 in the guide modal. Until
   *  this time passes, neither the boot-time guide nor the scheduled
   *  reminder re-prompts. Cleared by the next launch that finds it expired. */
  snoozePlanGuideUntil: number | null;
  /** Per-priority row background/foreground colours (none/low/medium/high).
   *  Theme mode lets the renderer fall back to CSS defaults; custom mode
   *  injects the user-chosen values as CSS custom properties. Normalised on
   *  load so any partial / corrupted JSON falls back to defaults. */
  taskAppearance: TaskAppearance;
  /** SEC-01 — JSON-RPC bridge settings. The bridge is OFF by default;
   *  users opt in via Settings → 数据 → 外部访问. The capability token is
   *  generated on first enable and rotated on demand. The token is
   *  sensitive but NOT an API key — its purpose is "is this local process
   *  the same owner as the desktop app", not "can it reach a remote API". */
  sdkBridge: {
    enabled: boolean;
    /** Capability token presented by clients on the first line of each
     *  request as a `auth: <token>` JSON-RPC extension field. Null until
     *  first enable (auto-generated on save). */
    token: string | null;
  };
  /** Auto-updater master switch. When false, the 5 s post-startup
   *  background check is skipped (no surprise manifest fetches on
   *  launch). Manual "检查更新" still works — that path is the user's
   *  explicit opt-in and is unaffected. Defaults to true so existing
   *  installs keep their auto-update behaviour. Read by
   *  `src/main/updates/updater.ts#setUpAutoUpdater` at boot and by
   *  `applyAutoUpdatePreference` for runtime toggling. */
  autoUpdate: boolean;
}

const DEFAULTS: PersistedSettings = {
  provider: DEFAULT_PROVIDER,
  apiKey: null,
  model: 'deepseek-chat',
  streaming: true,
  captureHotkey: DEFAULT_CAPTURE_HOTKEY,
  theme: 'system',
  lastHeartbeatAt: null,
  monthlyCostUsd: 0,
  dataDir: null,
  customProviders: [],
  customProviderId: null,
  archiveAfterDays: 1,
  tags: [],
  dailyPlanReminderTime: '09:00',
  lastPlanGuideDate: null,
  snoozePlanGuideUntil: null,
  taskAppearance: { ...DEFAULT_TASK_APPEARANCE, colors: { ...DEFAULT_TASK_APPEARANCE.colors } },
  sdkBridge: { enabled: false, token: null },
  autoUpdate: true,
};

/** Default data root when the user has not picked a directory. */
export function defaultDataDir(): string {
  return join(safeUserDataDir(), '..', ROOT_DIR_NAME);
}

/** Resolve the userData directory without throwing under vitest (where
 *  electron's `app` is undefined). Falls back to a stable per-process tmp
 *  directory in non-electron environments so the production constructor
 *  still works without a dir argument. */
function safeUserDataDir(): string {
  try {
    return app.getPath('userData');
  } catch {
    return join(tmpdir(), 'todo-list-test-userData');
  }
}

export class SettingsStore {
  /** Stable config path — always in userData, never inside the data dir. */
  private path: string;
  private cache: PersistedSettings;

  constructor(dir?: string) {
    // Config is read during bootstrap before any window or DB exists; we must
    // not depend on a pre-created data directory. Tests pass a tmp dir; the
    // production path falls through to electron's userData.
    const userData = dir ?? safeUserDataDir();
    this.path = join(userData, CONFIG_FILENAME);
    this.cache = this.load();
  }

  private load(): PersistedSettings {
    if (!existsSync(this.path)) return { ...DEFAULTS, taskAppearance: { ...DEFAULT_TASK_APPEARANCE, colors: { ...DEFAULT_TASK_APPEARANCE.colors } } };
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      // 旧 config.json 没有 taskAppearance 字段：归一化成默认值而不是整对象 spread 覆盖。
      const merged = { ...DEFAULTS, ...raw };
      merged.taskAppearance = normalizeTaskAppearance(raw.taskAppearance);
      return merged;
    } catch {
      return { ...DEFAULTS, taskAppearance: { ...DEFAULT_TASK_APPEARANCE, colors: { ...DEFAULT_TASK_APPEARANCE.colors } } };
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.cache, null, 2), 'utf8');
  }

  get(): PersistedSettings {
    return { ...this.cache };
  }

  /** Resolved data directory (absolute). Falls back to the default location. */
  getDataDir(): string {
    return this.cache.dataDir && this.cache.dataDir.trim()
      ? this.cache.dataDir
      : defaultDataDir();
  }

  /** Public-facing settings with API key redacted. */
  publicView() {
    const v = this.cache;
    const activeCustom = v.customProviders.find((c) => c.id === v.customProviderId) ?? v.customProviders[0];
    // `connected` means the selected provider is configured enough to accept
    // a request; network reachability is reported separately by ai.health.
    // Ollama is intentionally keyless, while a custom endpoint may also be a
    // keyless local service, so its base URL + model are the useful signal.
    const connected = v.provider === 'ollama'
      ? true
      : v.provider === 'shim'
        ? false
        : v.provider === 'custom'
          ? Boolean(activeCustom?.baseUrl.trim() && activeCustom.model.trim())
          : Boolean(v.apiKey);
    return {
      provider: v.provider,
      apiKeyRedacted: v.apiKey
        ? `${v.apiKey.slice(0, 4)}${'*'.repeat(Math.max(v.apiKey.length - 8, 0))}${v.apiKey.slice(-4)}`
        : '',
      model: v.model,
      streaming: v.streaming,
      connected,
      lastHeartbeatAt: v.lastHeartbeatAt,
      monthlyCostUsd: v.monthlyCostUsd,
      captureHotkey: v.captureHotkey,
      theme: v.theme,
      dataDir: this.getDataDir(),
      customProviders: v.customProviders.map((c) => ({
        id: c.id,
        name: c.name,
        protocol: c.protocol,
        baseUrl: c.baseUrl,
        apiKeyRedacted: c.apiKey
          ? `${c.apiKey.slice(0, 4)}${'*'.repeat(Math.max(c.apiKey.length - 8, 0))}${c.apiKey.slice(-4)}`
          : '',
        model: c.model,
      })),
      customProviderId: v.customProviderId,
      archiveAfterDays: v.archiveAfterDays,
      tags: v.tags,
      dailyPlanReminderTime: v.dailyPlanReminderTime,
      lastPlanGuideDate: v.lastPlanGuideDate,
      snoozePlanGuideUntil: v.snoozePlanGuideUntil,
      taskAppearance: v.taskAppearance,
      // SEC-01 — always return the full state (enabled + token) so the
      // renderer can show "regenerate / copy" affordances even when the
      // bridge is currently disabled. The token is NOT an API key — its
      // sole purpose is local capability gating, see bridge.ts.
      sdkBridge: {
        enabled: v.sdkBridge.enabled,
        token: v.sdkBridge.token,
        socketPath: process.platform === 'win32'
          ? '\\\\.\\pipe\\todo-list'
          : '/tmp/todo-list.sock',
      },
      autoUpdate: v.autoUpdate,
    };
  }

  /**
   * Replace the custom-providers list from a writable input. For entries that
   * omit `apiKey` (the renderer never re-types keys it isn't editing), the
   * previously stored key is preserved. Entries whose id no longer appears in
   * the input are dropped. If the active id is dropped, it is cleared.
   */
  mergeCustomProviders(input: CustomProviderInput[]): PersistedSettings {
    const prevById = new Map(this.cache.customProviders.map((c) => [c.id, c]));
    const next: CustomProviderConfig[] = input.map((c) => ({
      id: c.id,
      name: c.name,
      protocol: c.protocol,
      baseUrl: c.baseUrl,
      apiKey: c.apiKey && c.apiKey.length > 0 ? c.apiKey : prevById.get(c.id)?.apiKey ?? '',
      model: c.model,
    }));
    this.patch({ customProviders: next });
    const ids = new Set(next.map((c) => c.id));
    if (this.cache.customProviderId && !ids.has(this.cache.customProviderId)) {
      this.patch({ customProviderId: null });
    }
    return this.cache;
  }

  patch(patch: Partial<PersistedSettings>): PersistedSettings {
    const next: PersistedSettings = { ...this.cache, ...patch };
    // Never let streaming default override true if patch omits it
    if (patch.streaming === undefined && DEFAULTS.streaming) next.streaming = DEFAULTS.streaming;
    this.cache = next;
    this.persist();
    return this.cache;
  }

  recordHeartbeat(): void {
    this.cache.lastHeartbeatAt = Date.now();
    this.persist();
  }

  addCost(usd: number): void {
    this.cache.monthlyCostUsd = (this.cache.monthlyCostUsd ?? 0) + usd;
    this.persist();
  }

  /** SEC-01 — toggle the bridge. Enabling auto-generates a token if none
   *  exists. Returns the (possibly new) token so callers can display it
   *  once for the user to copy. */
  setSdkBridgeEnabled(enabled: boolean): string | null {
    const next = { ...this.cache.sdkBridge, enabled };
    if (enabled && !next.token) {
      next.token = generateSdkToken();
    }
    this.cache = { ...this.cache, sdkBridge: next };
    this.persist();
    return next.token;
  }

  /** SEC-01 — rotate the bridge token. Disables the bridge until the user
   *  re-enables it (rotation alone is rarely the right answer; usually the
   *  user also wants to invalidate outstanding clients). */
  rotateSdkBridgeToken(): string {
    const token = generateSdkToken();
    this.cache = { ...this.cache, sdkBridge: { enabled: false, token } };
    this.persist();
    return token;
  }
}

/** 32 random bytes → base64url. Sufficient for a local-only capability
 *  token — this is NOT a cryptographic authentication of remote parties
 *  (the socket / pipe is local). */
function generateSdkToken(): string {
  return randomBytes(32).toString('base64url');
}
