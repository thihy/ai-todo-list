// DSH LLM adapter — wires the official `@deepseek-ai/dsh-llm-pi-ai`
// `PiAiAdapter` (whose `stream()` calls delegate to pi-ai's
// openai-completions / anthropic-messages / openai-responses protocol
// modules for SSE parsing and per-provider reasoning deltas) to our
// settings-driven provider/model selection.
//
// History: an earlier `TodoListLlmAdapter` hand-rolled OpenAI + Anthropic
// SSE parsers (streamOpenAI / streamAnthropic) — replaced by the upstream
// adapter so we don't maintain a parallel streaming implementation. The
// package's own `apply(ctx, config)` is a cordis integration helper that
// pulls in settings + credentials seams we don't want to depend on; this
// file uses the exported `PiAiAdapter` class directly with an in-memory
// pi-ai `CredentialStore`/`AuthContext` (we never invoke pi-ai's own
// OAuth/ambient discovery — every key comes from our settings store via
// `resolveApiKey`).
//
// Why we build `ResolvedPiAiProviderProfile` ourselves rather than call
// the internal `resolveProfiles()` helper: the helper is intentionally not
// re-exported (only the `Config` schema and `PiAiAdapter` class are
// public). Our needs are narrower than the package's full route model
// (catalog reuse, modelOverrides, compat profiles, transport selection)
// — for the 5 routes we register, we reuse pi-ai's catalog providers via
// `builtinProviders()` and build hand-declared providers via
// `createProvider()` from `@earendil-works/pi-ai`. Both are public API.

import {
  PiAiAdapter,
  type ResolvedPiAiProviderProfile,
  type PiAiProviderProfile,
  type PiAiModelProfile,
} from '@deepseek-ai/dsh-llm-pi-ai';
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import {
  createProvider,
  type Provider,
  type ProviderAuth,
  type Model,
  type AuthContext,
  type CredentialStore,
  type Credential,
} from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import type { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { AIProvider, CustomProviderConfig, AICustomProtocol } from '../../shared/ai-types';
import type { ResolvedEndpoint } from './endpoints';

/** Routes registered with the LlmService. Order is irrelevant; dispatch is
 *  by `agentOptions.provider`. We omit `'shim'` — `ai.ask` short-circuits
 *  before reaching the runtime when no endpoint resolves. */
export const REAL_PROVIDER_ROUTES = ['deepseek', 'openai', 'anthropic', 'ollama', 'custom'] as const;
export type RealProviderRoute = (typeof REAL_PROVIDER_ROUTES)[number];

export interface CreateAdaptersDeps {
  /** Live endpoint from persisted settings; null means "not configured" —
   *  `ai.ask` short-circuits before reaching the adapter. */
  getEndpoint(): ResolvedEndpoint | null;
  /** Custom provider list (custom instance lifecycle can change without
   *  the endpoint re-resolving in every call path). */
  getCustomProviders(): readonly CustomProviderConfig[];
  /** Active custom provider instance id (or null). */
  getCustomProviderId(): string | null;
  /** User-Agent header value for LLM provider requests. Empty string = use
   *  the adapter default (deepseek-harness/…). Read per operation so a
   *  settings change reaches the next request without restart. */
  getUserAgent(): string;
}

/** Resolve the route key for `agentOptions.provider` from the user's
 *  current settings. shim maps to null — caller skips agent creation. */
export function providerRouteFor(provider: AIProvider): RealProviderRoute | null {
  switch (provider) {
    case 'deepseek':
    case 'openai':
    case 'anthropic':
    case 'ollama':
    case 'custom':
      return provider;
    case 'shim':
      return null;
  }
}

// ===== Protocol → pi-ai api identifier =====
function apiFactoryFor(protocol: AICustomProtocol | undefined): {
  api: string;
  factory: () => Parameters<typeof createProvider>[0]['api' & string] extends never ? never : ReturnType<typeof openAICompletionsApi>;
} {
  switch (protocol) {
    case 'openai':
      return { api: 'openai-completions', factory: openAICompletionsApi };
    case 'openresponses':
      return { api: 'openai-responses', factory: openAIResponsesApi };
    case 'anthropic':
      return { api: 'anthropic-messages', factory: anthropicMessagesApi };
    default:
      return { api: 'openai-completions', factory: openAICompletionsApi };
  }
}

// ===== Profile construction =====
//
// We construct the five profiles the runtime registers. Catalog routes
// (deepseek/openai/anthropic) reuse pi-ai's built-in `Provider` instance;
// hand-declared routes (ollama/custom) get a fresh `Provider` via
// `createProvider()`.
//
// Why reuse catalog providers: their wire implementations live in
// pi-ai's own provider factory modules (Bedrock's Smithy binding,
// Anthropic SDK glue, etc.) — recreating them from parts would silently
// narrow which providers work. The package's own `buildProvider()` does
// the same `reuseCatalogProvider` switch.

function buildCatalogProfile(
  provider: 'deepseek' | 'openai' | 'anthropic',
  displayName: string,
  baseCatalog: Provider[],
): ResolvedPiAiProviderProfile {
  const catalog = baseCatalog.find((p) => p.id === provider);
  if (!catalog) throw new Error(`pi-ai catalog does not ship provider "${provider}"`);
  // Reuse the catalog provider as-is (it owns its own api, models, auth).
  // The SDK's `reuseCatalogProvider` returns an object with a fresh id but
  // the same `stream()`/`streamSimple()` as the catalog — we do the same.
  const piProvider: Provider = {
    ...catalog,
    id: provider,
    name: displayName,
  };
  return {
    provider,
    displayName,
    apiKeyEnv: credentialRef(`${provider.toUpperCase()}_API_KEY`),
    streamIdleTimeoutMs: 300_000,
    maxRequestImageBytes: 20_971_520,
    requestImagePixelBudget: 4_194_304,
    requestImageMaxBytes: 1_048_576,
    retryPolicy: resolveRetryPolicy(undefined, `llm/${provider}`),
    piProvider,
    // 0.1.5-rc.2: ResolvedPiAiProviderProfile gained a required `modelErrors`
    // (per-model diagnostics reported before a request is attempted). We build
    // these profiles by hand from pi-ai's catalog rather than through the
    // adapter's config validation, so there is never a per-model diagnostic to
    // report — an empty map is the honest value, not a placeholder.
    modelErrors: new Map(),
    configuredMaxTokens: new Map(),
  };
}

function buildOllamaProfile(): ResolvedPiAiProviderProfile {
  // pi-ai doesn't ship an 'ollama' provider — but Ollama's /chat/completions
  // is OpenAI-compatible. Declare it as `openai-completions` pointing at
  // the local daemon; no `models` list (pi-ai accepts unlisted ids).
  const apiKeyEnv = credentialRef('OLLAMA_API_KEY');
  const baseURL = 'http://localhost:11434/v1';
  const models: Model<'openai-completions'>[] = [];
  const auth: ProviderAuth = {
    apiKey: {
      name: 'Ollama (no key)',
      resolve: async () => ({ auth: {}, source: 'ollama' }),
    },
  };
  const piProvider = createProvider<'openai-completions'>({
    id: 'ollama',
    name: 'Ollama（本地）',
    baseUrl: baseURL,
    auth,
    models,
    api: openAICompletionsApi(),
  });
  return {
    provider: 'ollama',
    displayName: 'Ollama（本地）',
    apiKeyEnv,
    api: 'openai-completions',
    baseURL,
    streamIdleTimeoutMs: 300_000,
    maxRequestImageBytes: 20_971_520,
    requestImagePixelBudget: 4_194_304,
    requestImageMaxBytes: 1_048_576,
    retryPolicy: resolveRetryPolicy(undefined, 'llm/ollama'),
    piProvider,
    // 0.1.5-rc.2: ResolvedPiAiProviderProfile gained a required `modelErrors`
    // (per-model diagnostics reported before a request is attempted). We build
    // these profiles by hand from pi-ai's catalog rather than through the
    // adapter's config validation, so there is never a per-model diagnostic to
    // report — an empty map is the honest value, not a placeholder.
    modelErrors: new Map(),
    configuredMaxTokens: new Map(),
  };
}

function buildCustomProfile(
  inst: CustomProviderConfig | undefined,
): ResolvedPiAiProviderProfile {
  const provider = 'custom';
  const apiKeyEnv = credentialRef('CUSTOM_API_KEY');
  if (!inst) {
    // No instance yet: register the route with a sentinel baseURL so the
    // adapter owns the provider key. ai.ask guards upstream and rejects
    // requests without a usable instance before reaching the adapter, so
    // this sentinel never carries traffic.
    const baseURL = 'http://invalid.local';
    const models: Model<'openai-completions'>[] = [];
    const piProvider = createProvider<'openai-completions'>({
      id: provider,
      name: '自定义',
      baseUrl: baseURL,
      auth: { apiKey: { name: 'Custom', resolve: async () => undefined } },
      models,
      api: openAICompletionsApi(),
    });
    return {
      provider,
      displayName: '自定义',
      apiKeyEnv,
      api: 'openai-completions',
      baseURL,
      streamIdleTimeoutMs: 300_000,
      maxRequestImageBytes: 20_971_520,
      requestImagePixelBudget: 4_194_304,
      requestImageMaxBytes: 1_048_576,
      retryPolicy: resolveRetryPolicy(undefined, 'llm/custom'),
      piProvider,
      // See buildCatalogProfile: no per-model diagnostics exist for a
      // hand-built profile, so the map is empty rather than absent.
      modelErrors: new Map(),
      configuredMaxTokens: new Map(),
    };
  }
  const baseUrl = inst.baseUrl.trim().replace(/\/+$/, '');
  const proto = apiFactoryFor(inst.protocol);
  const models: Model<typeof proto.api>[] = [
    {
      id: inst.model,
      name: inst.model,
      api: proto.api,
      provider,
      baseUrl,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      contextWindow: 262_144,
      maxTokens: 32_768,
    } as unknown as Model<typeof proto.api>,
  ];
  const piProvider = createProvider<typeof proto.api>({
    id: provider,
    name: `自定义 · ${inst.name}`,
    baseUrl,
    auth: {
      apiKey: {
        name: `Custom · ${inst.name}`,
        resolve: async ({ credential }) => ({
          auth: credential?.key ? { apiKey: credential.key } : {},
          source: 'custom',
        }),
      },
    },
    models,
    api: proto.factory(),
  });
  return {
    provider,
    displayName: `自定义 · ${inst.name}`,
    apiKeyEnv,
    api: proto.api,
    baseURL: baseUrl,
    streamIdleTimeoutMs: 300_000,
    maxRequestImageBytes: 20_971_520,
    requestImagePixelBudget: 4_194_304,
    requestImageMaxBytes: 1_048_576,
    retryPolicy: resolveRetryPolicy(undefined, 'llm/custom'),
    piProvider,
    // 0.1.5-rc.2: ResolvedPiAiProviderProfile gained a required `modelErrors`
    // (per-model diagnostics reported before a request is attempted). We build
    // these profiles by hand from pi-ai's catalog rather than through the
    // adapter's config validation, so there is never a per-model diagnostic to
    // report — an empty map is the honest value, not a placeholder.
    modelErrors: new Map(),
    configuredMaxTokens: new Map(),
  };
}

// ===== Auth seam (pi-ai-shaped, in-memory) =====
//
// Pi-ai's `Models` collection takes a `CredentialStore` for pi-ai's own
// writes (OAuth login flows) and an `AuthContext` for ambient lookups
// (env vars, ~/.aws/credentials). We never use those — every key is
// supplied by our settings store via `resolveApiKey` — so we hand pi-ai
// a no-op implementation. The provider's own `resolve()` (the
// catalog-shipped one) short-circuits on a key from `resolveApiKey` via
// the request-level `apiKey` override, never reaching this store.

const noopCredentialStore: CredentialStore = {
  async read(): Promise<Credential | undefined> {
    return undefined;
  },
  async list(): Promise<readonly { providerId: string; type: Credential['type'] }[]> {
    return [];
  },
  async modify(_id, _mutate) {
    return undefined;
  },
  async delete() {
    /* noop */
  },
};

const noopAuthContext: AuthContext = {
  async env(): Promise<string | undefined> {
    return undefined;
  },
  async fileExists(): Promise<boolean> {
    return false;
  },
};

// ===== Profile map builder =====

/** A fetch that stamps the configured `User-Agent` on every outgoing request.
 *  pi-ai's createClient honors `options.fetch`; the DSH adapter's
 *  `attributionHeaders()` hard-codes `deepseek-harness/…` and strips
 *  `user-agent` from profile headers, so the wire-level fetch is the only
 *  override seam. `new Headers(init.headers)` copies whatever shape the
 *  SDK used (plain object / Headers / array of pairs) and `set()` overrides
 *  case-insensitively. `HeadersInit` is DOM-typed and not in the node tsconfig
 *  lib, so the param is left permissive here. */
function makeUserAgentFetch(ua: string): typeof globalThis.fetch {
  const base = globalThis.fetch;
  // Build a fresh Headers from whatever the SDK passed and stamp the UA.
  // `init.headers` may be a plain object, Headers, or array of pairs — the
  // Headers constructor accepts all of them; we go through `any` only to
  // sidestep the DOM-typed HeadersInit that isn't in the node tsconfig lib.
  const stamp = (headers: unknown): Headers => {
    const h = new Headers((headers as any) ?? undefined);
    h.set('user-agent', ua);
    return h;
  };
  return (input, init) =>
    base(input, { ...(init ?? {}), headers: stamp(init?.headers) });
}

/** Override each provider's stream/streamSimple so the request runs through a
 *  fetch that stamps the configured User-Agent. Mutates the provider in place
 *  (its `stream`/`streamSimple` are not readonly) — the original methods are
 *  bound back to the same instance so any closure/`this` state is preserved. */
function applyUserAgent(p: Provider, ua: string): void {
  if (!ua) return;
  const fetch = makeUserAgentFetch(ua);
  const origStream = p.stream.bind(p) as typeof p.stream;
  const origSimple = p.streamSimple.bind(p) as typeof p.streamSimple;
  p.stream = ((model: Parameters<typeof p.stream>[0], context: Parameters<typeof p.stream>[1], options?: Parameters<typeof p.stream>[2]) =>
    origStream(model, context, { ...(options ?? {}), fetch })) as typeof p.stream;
  p.streamSimple = ((model: Parameters<typeof p.streamSimple>[0], context: Parameters<typeof p.streamSimple>[1], options?: Parameters<typeof p.streamSimple>[2]) =>
    origSimple(model, context, { ...(options ?? {}), fetch })) as typeof p.streamSimple;
}

function buildProfiles(deps: CreateAdaptersDeps): ReadonlyMap<string, ResolvedPiAiProviderProfile> {
  const catalog = builtinProviders();
  const profiles: Array<[string, ResolvedPiAiProviderProfile]> = [
    ['deepseek', buildCatalogProfile('deepseek', 'DeepSeek', catalog)],
    ['openai', buildCatalogProfile('openai', 'OpenAI', catalog)],
    ['anthropic', buildCatalogProfile('anthropic', 'Anthropic', catalog)],
    ['ollama', buildOllamaProfile()],
  ];
  const list = deps.getCustomProviders();
  const activeId = deps.getCustomProviderId();
  const inst = list.find((c) => c.id === activeId) ?? list[0];
  profiles.push(['custom', buildCustomProfile(inst)]);
  // User-Agent override — read per operation so a settings change reaches the
  // next request without restart (same invariant as endpoint/customProviders).
  const ua = deps.getUserAgent();
  if (ua) for (const [, profile] of profiles) if (profile.piProvider) applyUserAgent(profile.piProvider, ua);
  return new Map(profiles);
}

// ===== Adapter factory =====

/** Create the LLM adapter bundle. Call once at DSH boot — the returned
 *  `real` instance is registered with `ctx.llm.registerAdapter` for all
 *  five `REAL_PROVIDER_ROUTES`. */
export function createLlmAdapters(deps: CreateAdaptersDeps): {
  real: PiAiAdapter;
  routes: readonly RealProviderRoute[];
} {
  const real = new PiAiAdapter({
    profiles: () => buildProfiles(deps),
    resolveApiKey: async (provider, _profile) => {
      // The user stores API keys in our settings store, not in env vars.
      // Map the dsh-llm provider route back to a settings read:
      //   - built-in providers → settings.apiKey (ollama ignores it)
      //   - custom             → the active instance's apiKey
      // We resolve via getEndpoint so the same one-call-per-turn invariant
      // holds — a changed key reaches the next request without restart.
      if (provider === 'custom') {
        const list = deps.getCustomProviders();
        const activeId = deps.getCustomProviderId();
        return list.find((c) => c.id === activeId)?.apiKey ?? list[0]?.apiKey ?? '';
      }
      const ep = deps.getEndpoint();
      if (!ep) return '';
      if (provider === 'ollama') return '';
      return ep.apiKey;
    },
    auth: {
      credentials: noopCredentialStore,
      authContext: noopAuthContext,
    },
  });
  // The PiAiAdapter already implements the LlmAdapter contract; expose as
  // the abstract type so the runtime can register without depending on the
  // concrete class.
  void real as unknown as LlmAdapter;
  return { real, routes: REAL_PROVIDER_ROUTES };
}

// Silence unused-import warning for `PiAiProviderProfile` /
// `PiAiModelProfile` — kept exported in the API surface for future
// profile-shape overrides (compat fields, modelOverrides) we don't
// currently configure.
void (null as unknown as PiAiProviderProfile | PiAiModelProfile);