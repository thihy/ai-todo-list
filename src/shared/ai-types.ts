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
  priority: 'none' | 'low' | 'medium' | 'high';
  project: string | null;
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
export interface AIStreamEventBase {
  invocationId: string;
}

export interface AIStartEvent extends AIStreamEventBase {
  type: 'start';
}

export interface AITokenEvent extends AIStreamEventBase {
  type: 'token';
  token: string;
}

export interface AIToolCallEvent extends AIStreamEventBase {
  type: 'toolCall';
  toolName: string;
  args: unknown;
  result: unknown;
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
}

export interface AIErrorEvent extends AIStreamEventBase {
  type: 'error';
  message: string;
}

export type AIStreamEvent =
  | AIStartEvent
  | AITokenEvent
  | AIToolCallEvent
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
  /** Wire protocol — meaningful when provider === 'custom'. */
  protocol: AICustomProtocol;
  /** Base URL — meaningful when provider === 'custom'. */
  baseUrl: string;
}