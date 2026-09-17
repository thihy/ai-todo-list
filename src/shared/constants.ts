// App-wide constants. Mirrored in openspec spec files.

export const APP_NAME = 'todo-list';
export const APP_VERSION = '1.0.0-rc5';
export const APP_USER_AGENT = `${APP_NAME}/${APP_VERSION}`;

// User-facing brand shown in the Windows taskbar right-click menu and the
// macOS app menu (Electron calls `SetCurrentProcessExplicitAppUserModelID`
// with this on Windows when an explicit AUMID hasn't been set yet, so it
// becomes the taskbar display label). Distinct from APP_NAME: APP_NAME is
// the internal id (kept for the HTTP User-Agent and anything that
// needs an ASCII slug); this is what end users see. Must match
// `productName` in package.json so packaged builds stay consistent.
export const APP_PRODUCT_NAME = 'AI待办';

// Stable reverse-DNS Windows AppUserModelId. MUST match `appId` in
// package.json's `build` block — electron-builder uses that when
// packaging, and Windows treats different AUMIDs as different apps
// (separate taskbar entries, separate pinned state, no carry-over
// between dev and packaged installs). Sharing one id across dev +
// packaged keeps the pin/taskbar group stable when a user upgrades
// from `pnpm dev` to a packaged install.
export const APP_USER_MODEL_ID = 'com.todolist.app';

export const DEFAULT_CAPTURE_HOTKEY = 'CommandOrControl+Shift+T';
export const DEFAULT_THEME = 'system' as const;
export const DEFAULT_PROVIDER = 'deepseek' as const;

/**
 * User-Agent token sent on every LLM provider request. The DSH `dsh-llm`
 * adapter hard-codes its own `deepseek-harness/…` attribution and strips
 * `user-agent` from profile headers, so we can't override it via headers —
 * we inject a custom `fetch` (see llm-adapter.ts) that rewrites the header
 * on the wire. Defaults to `TodoList`; the user can change it in 设置 → 模型.
 * Empty string falls back to the adapter default (`deepseek-harness/…`). */
export const DEFAULT_AI_USER_AGENT = 'TodoList';

export const ROOT_DIR_NAME = '.todo-list';
export const DB_FILENAME = 'db.sqlite';
export const CONFIG_FILENAME = 'config.json';
export const TODOS_SUBDIR = 'todos';
export const DRAWINGS_SUBDIR = 'drawings';
export const THUMBS_SUBDIR = 'thumbs';
export const ATTACHMENTS_SUBDIR = 'inbox-attachments';
export const TRASH_SUBDIR = 'trash';
/** AI 助手文件系统 + shell 工具的根目录。AI 的 read/read_image/write/edit/
 *  grep/glob 在 <dataDir>/<DSH_WORKSPACE_SUBDIR>/ 下运作（host 在
 *  tools/pre-execute 监听器里强制校验路径越界）；bash/pwsh 由 DSH sandbox
 *  在 kernel 层做 path containment 的二次保护。DSH_SESSIONS_ROOT 不重用此目录
 *  —— 会话存档是单独的根（`~/.dsh` 或环境变量），与用户的工作区不冲突。
 *  `process.env.DSH_WORKSPACE_ROOT` 在 src/main/index.ts 的 mkdirSync 之前
 *  设置（cordis.yml 的 !!js 表达式在 boot 时读取）。 */
export const DSH_WORKSPACE_SUBDIR = 'dsh_workspace';

export const MAX_BODY_VERSIONS = 20;
export const THUMB_WIDTH = 320;
export const THUMB_HEIGHT = 200;

export const PERMISSION_DEFAULT_TIMEOUT_MS = 30_000;
export const PERMISSION_DEADLINE_MS = PERMISSION_DEFAULT_TIMEOUT_MS;

export const SEARCH_LIMIT_DEFAULT = 50;
export const SEARCH_LIMIT_MAX = 200;

// DSH skill IDs
export const SKILL_CAPTURE = 'capture';
export const SKILL_DRAFT_PROGRESS = 'draftProgress';
export const SKILL_SUMMARIZE = 'summarize';
export const SKILL_DATA_ANALYSIS = 'dataAnalysis';

// AI tool permission tiers live in ./permission-tiers.ts (underscored tool names
// matching the registry in src/main/dsh/dsh-runtime.ts). The snake_case
// names that used to live here drifted from the registry; they were never
// imported by any production code.