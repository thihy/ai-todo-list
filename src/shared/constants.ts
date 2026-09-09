// App-wide constants. Mirrored in openspec spec files.

export const APP_NAME = 'todo-list';
export const APP_VERSION = '0.1.0';
export const APP_USER_AGENT = `${APP_NAME}/${APP_VERSION}`;

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