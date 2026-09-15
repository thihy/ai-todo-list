// AI request/response/event types. Consumed by both main (DSH agent loop) and renderer.

import type { ULID } from './todo-types';

// Model is a free string so users can configure arbitrary providers/models.
export type AIModel = string;
export const AI_MODELS: readonly AIModel[] = ['deepseek-chat', 'deepseek-reasoner'];

/** Model provider — determines base URL / auth shape. Persisted in settings. */
export type AIProvider = 'deepseek' | 'openai' | 'anthropic' | 'ollama' | 'shim' | 'custom';
export const AI_PROVIDERS: readonly AIProvider[] = ['deepseek', 'openai', 'anthropic', 'ollama', 'shim', 'custom'];

export const PROVIDER_LABELS: Record<AIProvider, string> = {
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  ollama: 'Ollama（本地）',
  shim: '内置 Shim（离线）',
  custom: '自定义',
};

/**
 * Wire protocol for a `custom` provider. Determines the request shape + SSE
 * event parsing. Built-in providers derive their protocol implicitly.
 *  - openai        : /chat/completions (OpenAI-compatible; used by DeepSeek/Ollama)
 *  - openresponses : /responses (OpenAI Responses API)
 *  - anthropic     : /messages (Anthropic Messages API)
 */
export type AICustomProtocol = 'openai' | 'openresponses' | 'anthropic';
export const CUSTOM_PROTOCOLS: readonly AICustomProtocol[] = ['openai', 'openresponses', 'anthropic'];
export const PROTOCOL_LABELS: Record<AICustomProtocol, string> = {
  openai: 'OpenAI（/chat/completions）',
  openresponses: 'OpenAI Responses（/responses）',
  anthropic: 'Anthropic（/messages）',
};

/**
 * A user-defined custom provider instance. The user can create arbitrarily
 * many (e.g. "OpenRouter", "公司网关", "本地 Ollama 兼容层"), each with its own
 * protocol / baseURL / API key / model. `customProviderId` in settings selects
 * which one is active when `provider === 'custom'`.
 *
 * `apiKey` is the stored plaintext — server-side only; the renderer always
 * receives a redacted form (`CustomProviderView.apiKeyRedacted`).
 */
export interface CustomProviderConfig {
  id: string;
  name: string;
  protocol: AICustomProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Writable shape: apiKey is optional so the renderer can send back the list
 *  without re-typing keys; the store preserves keys for entries that omit it. */
export type CustomProviderInput = Omit<CustomProviderConfig, 'apiKey'> & {
  apiKey?: string;
};

/** Redacted renderer-facing form. */
export type CustomProviderView = Omit<CustomProviderConfig, 'apiKey'> & {
  apiKeyRedacted: string;
};

/** Models offered per provider in the settings UI. `custom` is free-form. */
export const PROVIDER_MODELS: Record<AIProvider, string[]> = {
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini'],
  anthropic: ['claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-5'],
  ollama: ['llama3.1', 'qwen2.5', 'deepseek-r1'],
  shim: ['shim-mock'],
  custom: [],
};

export interface ParsedTodo {
  title: string;
  dueAt: number | null;
  // 5 档：very-low | low | medium | high | very-high。AI 解析不再有
  // "none" 选项 —— 用户没显式标优先级时直接落到 low（与 todo_create 默
  // 认行为一致）。
  priority: 'very-low' | 'low' | 'medium' | 'high' | 'very-high';
  tags: string[];
}

export interface AICost {
  model: AIModel;
  durationMs: number;
  estimatedCostUsd: number;
  tokensIn: number | null;
  tokensOut: number | null;
}

export interface AIInvocationRequest {
  skillId:
    | 'capture'
    | 'draftProgress'
    | 'summarize'
    | 'dataAnalysis'
    | 'chat';
  input: string | { todoId: ULID; hint?: string };
}

// Stream events use `type` to match DshStreamEvent shape from main/dsh/types.ts.
//
// L5-A: the wire carries the **raw DSH SessionEvent** (via the `sessionEvent`
// variant) instead of a synthesized `toolCall` blob. This keeps main thin
// (no transformation layer) and lets the renderer reach the full DSH
// SessionEventMap vocabulary — including future complex components like
// ToolRow / AssistantMarkdown that consume the raw stream. Tool-call ↔
// tool-result merge still happens in the renderer (see useAiStream).
export interface AIStreamEventBase {
  invocationId: string;
  /** Renderer-side arrival timestamp (ms, Date.now()), stamped by useAiStream
   *  when it processes each ai:stream event. Used for turn-metrics (time-to-
   *  first-token, duration). Optional because events constructed elsewhere
   *  (e.g. tests) may not set it. */
  ts?: number;
}

export interface AIStartEvent extends AIStreamEventBase {
  type: 'start';
}

export interface AIReasoningEvent extends AIStreamEventBase {
  type: 'reasoning';
  text: string;
}

export interface AITokenEvent extends AIStreamEventBase {
  type: 'token';
  token: string;
}

/** Synthesized tool-call event is intentionally NOT part of this surface.
 *  Tool-call pairing + projection lives in the renderer as a pure function
 *  (`projectStreamTurn`) over the raw `sessionEvent` stream — see
 *  `src/renderer/dsh/stream-turn.ts`. Keeping pairing OUT of the React
 *  useState updater avoids the StrictMode-double-invocation hazard (a
 *  side-effect map would lose / duplicate entries). Main forwards raw
 *  SessionEvents via `AISessionEvent`; the renderer pairs tool/call and
 *  tool/result keyed by callId. */

/** Raw DSH SessionEvent passthrough. Renderer ingests this and re-emits the
 *  narrower synthesized events (token / reasoning / toolCall) that AIPane
 *  consumes. The wire shape matches `SessionEvent` from
 *  `@deepseek-ai/dsh-session` but the `data` field is typed as `unknown`
 *  here so we don't drag the whole SessionEventMap vocabulary through the
 *  shared boundary (the renderer imports the typed `SessionEventMap` and
 *  narrows by `e.event.type`). */
export interface AISessionEvent extends AIStreamEventBase {
  type: 'sessionEvent';
  event: { type: string; data?: unknown };
}

export interface AIPermissionRequestEvent extends AIStreamEventBase {
  type: 'permissionRequest';
  tool: string;
  preview: string;
  tier: 'auto' | 'notify-undo' | 'block';
}

export interface AIDoneEvent extends AIStreamEventBase {
  type: 'done';
  content: string;
  costUsd: number;
  /** Output token count from runTurn, for the turn-metrics tok/s display. */
  tokensOut?: number;
  /** Input token count from runTurn (cached/preview context). */
  tokensIn?: number;
}

export interface AIErrorEvent extends AIStreamEventBase {
  type: 'error';
  message: string;
}

export type AIStreamEvent =
  | AIStartEvent
  | AITokenEvent
  | AIReasoningEvent
  | AISessionEvent
  | AIPermissionRequestEvent
  | AIDoneEvent
  | AIErrorEvent;

export interface PermissionRequest {
  invocationId: string;
  toolName: string;
  args: unknown;
  reason: string;
  expiresAtMs: number;
}

export interface PermissionResponse {
  invocationId: string;
  toolName: string;
  decision: 'allow' | 'deny';
  rememberForSeconds: number;
}

// ===== Human-in-the-loop (DSH user-questions + user-approval) =====
//
// Wire shapes that mirror @deepseek-ai/dsh-user-questions/types but strip
// server-only fields (the `agent` runtime ref) so the renderer can carry
// the request payload without leaking the live agent handle into IPC.
//
// `reqId` is a server-minted correlation id so the answerer can match
// the user's answer back to the pending waterfall call without sharing
// the agent's internal id (which is a branded string the renderer has
// no business seeing).

/** One selectable answer offered to the user. */
export interface UserQuestionOption {
  label: string;
  description?: string;
}

/** One question in a multi-question request. */
export interface UserQuestionItem {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: UserQuestionOption[];
  multiSelect?: boolean;
  intent?: { kind: 'plan-review'; approve: string };
}

/** Single-question batch as it travels main → renderer. */
export interface UserQuestionRequest {
  reqId: string;
  invocationId: string;
  questions: UserQuestionItem[];
}

/** One answer entry (mirrors DSH AskUserQuestionAnswerItem). */
export interface UserQuestionAnswerItem {
  id: string;
  /** Selected option labels. Empty when `custom` is set on a single-select. */
  selected: string[];
  /** Optional free-text "Other" answer. */
  custom?: string;
}

/** Renderer → main: the human's structured answer. */
export interface UserQuestionAnswer {
  reqId: string;
  answers: UserQuestionAnswerItem[];
}

/** Binary approval request from main → renderer (DSH user-approval). */
export interface UserApprovalRequest {
  reqId: string;
  invocationId: string;
  toolName: string;
  reason: string;
  /** Optional hint for the renderer; missing on legacy ctx.approval callers. */
  preview?: string;
  expiresAtMs: number;
}

/** Binary approval answer from renderer → main. */
export interface UserApprovalAnswer {
  reqId: string;
  decision: 'allow-once' | 'reject';
}

export interface AIMemoryEntry {
  id: ULID;
  kind: 'preference' | 'fact' | 'context';
  text: string;
  createdAt: number;
  sourceInvocationId: string | null;
}

export interface AISettings {
  provider: AIProvider;
  apiKeyRedacted: string;
  model: AIModel;
  streaming: boolean;
  connected: boolean;
  lastHeartbeatAt: number | null;
  monthlyCostUsd: number;
  /** User-defined custom provider instances (meaningful when provider==='custom'). */
  customProviders: CustomProviderView[];
  /** Active custom instance id when provider==='custom'; null = none selected. */
  customProviderId: string | null;
  /** User-Agent header sent on LLM provider requests. */
  userAgent: string;
}
