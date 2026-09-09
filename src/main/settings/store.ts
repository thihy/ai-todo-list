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
import { DEFAULT_CAPTURE_HOTKEY, ROOT_DIR_NAME, CONFIG_FILENAME, DEFAULT_PROVIDER } from '../../shared/constants';
import type { AIModel, AIProvider, CustomProviderConfig, CustomProviderInput } from '../../shared/ai-types';
import type { TagDef } from '../../shared/todo-types';

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
    const { tmpdir } = require('node:os') as typeof import('node:os');
    const { join } = require('node:path') as typeof import('node:path');
    return join(tmpdir(), 'thihy-test-userData');
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
    if (!existsSync(this.path)) return { ...DEFAULTS };
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      return { ...DEFAULTS, ...raw };
    } catch {
      return { ...DEFAULTS };
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
    return {
      provider: v.provider,
      apiKeyRedacted: v.apiKey
        ? `${v.apiKey.slice(0, 4)}${'*'.repeat(Math.max(v.apiKey.length - 8, 0))}${v.apiKey.slice(-4)}`
        : '',
      model: v.model,
      streaming: v.streaming,
      connected: !!v.apiKey,
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
}
