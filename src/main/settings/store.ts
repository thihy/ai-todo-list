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
import type { AIModel, AIProvider, AICustomProtocol } from '../../shared/ai-types';

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
  /** Wire protocol for the `custom` provider. */
  protocol: AICustomProtocol;
  /** Base URL for the `custom` provider (e.g. https://api.openai.com/v1). */
  baseUrl: string;
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
  protocol: 'openai',
  baseUrl: '',
};

/** Default data root when the user has not picked a directory. */
export function defaultDataDir(): string {
  return join(app.getPath('userData'), '..', ROOT_DIR_NAME);
}

export class SettingsStore {
  /** Stable config path — always in userData, never inside the data dir. */
  private path: string;
  private cache: PersistedSettings;

  constructor() {
    // Config is read during bootstrap before any window or DB exists; we must
    // not depend on a pre-created data directory.
    const userData = app.getPath('userData');
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
      protocol: v.protocol,
      baseUrl: v.baseUrl,
    };
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
