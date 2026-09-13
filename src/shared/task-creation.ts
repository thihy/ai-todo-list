// Shared encoding / decoding for the create-task envelope that travels
// between the AI-create UI, the IPC layer, the main process, and the
// persisted JSONL history.
//
// Why an envelope at all:
//   The model needs to know "this turn is a create-task request, not a
//   chat" — otherwise it would default to suggestions / conversation.
//   The ten fixed creation rules (default status, conservative priority,
//   parentId must come from a real tool result, etc.) are now in the DSH
//   system prompt (see resources/dsh/cordis.yml 「创建任务操作」), so the
//   wire envelope carries only:
//
//     [todo-list:create-task:v1] {intent, localDate, text}
//
//   `text` is the user's literal description + any attachment blocks —
//   structured data, not a higher-priority instruction. The prefix is a
//   structural separator, not a security or trust boundary.
//
// Why JSON in the payload:
//   The user is allowed to type any text, including literal sequences
//   that look like our old bracketed separators (e.g. `[用户的任务描述开始]`).
//   JSON in the payload cleanly escapes whatever the user typed; a single
//   `JSON.parse` after the prefix is enough.

export type UserIntent = 'chat' | 'create-task';

export const TASK_CREATION_PREFIX = '[todo-list:create-task:v1]';

/** Result of decoding a persisted or in-flight user message.
 *  - `text` is what gets shown in plain chat bubbles and what we'd send
 *    back as the user-side of `priorTurns` if a future model ever needs it.
 *  - `intent` is `create-task` only when the wire carried the create-task
 *    envelope (new or legacy strict match). Plain chat yields `undefined`.
 *  - `description` is set when `intent` is `create-task`: the user-typed
 *    description with any trailing attachment blocks stripped. The
 *    create-task card renders this so the user never sees file dumps
 *    inside the operation card. */
export interface DecodedUserMessage {
  text: string;
  intent?: UserIntent;
  description?: string;
}

/** Encode the create-task envelope. Main process calls this when IPC
 *  intent === 'create-task'; renderer passes `text` containing the user's
 *  literal description and any pre-resolved attachment blocks.
 *  The prefix stays on the same line as the JSON, so the decoder doesn't
 *  have to care about whether the user text starts with a newline. */
export function encodeTaskCreationEnvelope(text: string, now: Date = new Date()): string {
  const payload = JSON.stringify({
    intent: 'create-task',
    localDate: localDateKey(now),
    text,
  });
  return `${TASK_CREATION_PREFIX} ${payload}`;
}

// ----- Legacy envelope (strict back-compat) -----
//
// Before this refactor the create-task request was wrapped via
// `buildAiTaskCreationPrompt(userInput)` into a multi-line bracketed
// envelope. Existing JSONL history may still carry those exact strings,
// so the decoder recognises them by STRICT match — only the literal
// opening header followed by the opening/closing markers wraps a
// description. Anything else falls through as plain chat text.
//
// We deliberately do NOT use a loose regex on the text — that would
// mistake ordinary user input for an envelope (e.g. someone pasting a
// snippet that mentions "用户的任务描述开始") and would silently lose
// the round-trip integrity of old history.
const LEGACY_PREFIX = '[应用操作模式：创建任务]';
const LEGACY_START = '[用户的任务描述开始]';
const LEGACY_END = '[用户的任务描述结束]';

function tryDecodeLegacyCreateTask(raw: string): DecodedUserMessage | null {
  if (!raw.startsWith(LEGACY_PREFIX)) return null;
  const startIdx = raw.indexOf(LEGACY_START);
  const endIdx = raw.indexOf(LEGACY_END);
  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) return null;
  const desc = raw.slice(startIdx + LEGACY_START.length, endIdx).trim();
  const tail = raw.slice(endIdx + LEGACY_END.length).trim();
  const text = tail ? `${desc}\n\n${tail}` : desc;
  return { text, intent: 'create-task', description: desc };
}

/** Decode a raw user message. Never throws and never loses text:
 *  - New envelope → JSON parsed, returns `text` (full content with
 *    attachments) + `intent: 'create-task'` + `description` (user-typed
 *    portion only).
 *  - Legacy envelope (strict match) → same shape, with `description`
 *    extracted from between the old markers.
 *  - Anything else → plain chat; `intent` is undefined and `text` is
 *    the raw string verbatim. */
export function decodeUserMessage(raw: string): DecodedUserMessage {
  if (typeof raw !== 'string' || raw.length === 0) return { text: raw ?? '' };
  if (raw.startsWith(TASK_CREATION_PREFIX)) {
    const rest = raw.slice(TASK_CREATION_PREFIX.length).trimStart();
    try {
      const obj = JSON.parse(rest);
      if (obj && typeof obj === 'object' && typeof (obj as { text?: unknown }).text === 'string') {
        const t = (obj as { text: string }).text;
        const intentRaw = (obj as { intent?: unknown }).intent;
        if (intentRaw === 'create-task') {
          // Description = user-typed portion. We don't have an explicit
          // marker in the new envelope to strip attachments (they're
          // concatenated into `text` by the renderer), so treat the
          // full text as the description for display purposes — the
          // card shows the full thing, multi-line and readable.
          return { text: t, intent: 'create-task', description: t };
        }
        return { text: t };
      }
    } catch {
      // JSON parse failed — fall through and treat the raw text as
      // plain chat. Better to show the prefix than to lose the message.
    }
  }
  const legacy = tryDecodeLegacyCreateTask(raw);
  if (legacy) return legacy;
  return { text: raw };
}

/** Local-date key in YYYY-MM-DD. Used at encode-time so `dueAt` and
 *  `plannedFor` decisions made by the model use the same "today" the
 *  user saw when they sent the request. Computed per call — never cached
 *  at Agent startup, so a request that crosses midnight still sees the
 *  correct date. */
export function localDateKey(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
