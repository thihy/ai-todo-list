// DSH container — shared types.

// Model is a free string so the user can configure arbitrary providers/models
// via settings; DSH forwards it to whichever provider is selected.
export type AIModel = string;

export interface DshInvocationRequest {
  /** Model identifier (deepseek-chat / deepseek-reasoner). */
  model: AIModel;
  /** System prompt; user role handled by DSH internals. */
  systemPrompt?: string;
  /** Conversation messages, the latest one being the prompt. */
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  /** Tool names the agent may call. Empty list = pure chat. */
  tools: string[];
  /** Optional budget in USD; DSH refuses to spend beyond. */
  budgetUsd?: number;
  /** Invocation id; client-generated UUID. */
  invocationId: string;
}

export interface DshInvocationResult {
  invocationId: string;
  content: string;
  toolCalls: Array<{ name: string; args: unknown }>;
  costUsd: number;
  usage: { promptTokens: number; completionTokens: number };
}

export interface DshContainer {
  invoke(req: DshInvocationRequest): Promise<DshInvocationResult>;
  cancel(invocationId: string): void;
  models(): AIModel[];
  health(): { ok: boolean; mode: 'real' | 'shim' };
  /** Shim-only: register a tool at runtime. Real DSH uses plugins / providers instead. */
  registerTool?(name: string, fn: (args: unknown) => Promise<unknown>): void;
}

export interface DshHandle {
  container: DshContainer;
  invoke(req: DshInvocationRequest): Promise<DshInvocationResult>;
  cancel(id: string): void;
  models(): AIModel[];
  health(): { ok: boolean; mode: 'real' | 'shim' };
}

export type DshStreamEvent =
  | { type: 'start'; invocationId: string }
  | { type: 'token'; invocationId: string; text: string }
  | { type: 'toolCall'; invocationId: string; name: string; args: unknown }
  | { type: 'toolResult'; invocationId: string; name: string; ok: boolean; data?: unknown; error?: string }
  | { type: 'permissionRequest'; invocationId: string; tool: string; preview: string; tier: 'auto' | 'notify-undo' | 'block' }
  | { type: 'done'; invocationId: string; content: string; costUsd: number }
  | { type: 'error'; invocationId: string; message: string };
