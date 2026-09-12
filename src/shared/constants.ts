// App-wide constants. Mirrored in openspec spec files.

export const APP_NAME = 'todo-list';
export const APP_VERSION = '0.1.0';
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

export const ROOT_DIR_NAME = '.todo-list';
export const DB_FILENAME = 'db.sqlite';
export const CONFIG_FILENAME = 'config.json';
export const TODOS_SUBDIR = 'todos';
export const DRAWINGS_SUBDIR = 'drawings';
export const THUMBS_SUBDIR = 'thumbs';
export const ATTACHMENTS_SUBDIR = 'inbox-attachments';
export const TRASH_SUBDIR = 'trash';

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

// AI tool permission tiers live in ./permission-tiers.ts (dotted tool names
// matching the registry in src/main/dsh/dsh-runtime.ts). The snake_case
// names that used to live here drifted from the registry; they were never
// imported by any production code.