# Operations

How thihy-todolist behaves on real hardware, how to recover from problems,
and where to look when things go wrong.

## Logging

Logs go to:
- stdout in dev
- `${userData}/thihy.log` always (rotated implicitly by truncation; no built-in rotation)

Set the threshold via the logger API (or by patching `src/main/logger.ts`):

```ts
import { logger } from './logger';
logger.setThreshold('debug');
```

## Storage locations

| Platform | Path                                                                   |
| -------- | ---------------------------------------------------------------------- |
| Windows  | `%APPDATA%/thihy-todolist/` and `%APPDATA%/../thihy-todolist/thihy.log` |
| macOS    | `~/Library/Application Support/thihy-todolist/`                         |
| Linux    | `~/.config/thihy-todolist/`                                            |

Inside the app root:

```
thihy-todolist/
├── todos.db                  SQLite + WAL files
├── todos.db-wal              WAL
├── todos.db-shm              shared memory index
├── todos/<id>.md             one Markdown body per TODO
├── drawings/<id>.json        one Excalidraw scene per drawing
├── attachments/<id>-…        clipboard + drag-dropped files
└── config.json               SettingsStore output (apiKey lives here)
```

## Backups

`todos.db` is the source of truth; the `todos/*.md` and `drawings/*.json`
files are derived. To back up: stop the app, copy the entire directory.
Restore: copy back, restart.

## Auto-update

`electron-updater` checks GitHub Releases on launch. New version → renderer
gets an `app:update-available` event. User can trigger download from the
settings pane; on completion they get `app:update-downloaded` and can
"Restart to install".

If a release breaks on first boot, downgrade:

```bash
pnpm dist:dir          # build unpacked
# ... copy old build over new build in the user's install dir
```

## Performance

The hot path is the TODO list view. It pulls from FTS5 + the `todos` table;
the query is index-friendly on `(status, due_at)` and the tag filter is a
JOIN on the `todo_tags` table.

For very large libraries (>50k TODOs) the list pane switches to virtualised
rows via `react-window`. We lazy-load the dependency on first paint of the
list pane with >1000 items.

## Known limitations

- The capture window doesn't HMR; restart it manually.
- DSH real boot is best-effort; if `@deepseek-ai/dsh-base` peer isn't
  satisfied we drop to the shim and DSH plugin composition is disabled.
- The JSON-RPC bridge uses a Unix socket which means it only works on the
  same machine; remote access requires port-forwarding the pipe, which
  Windows does not support. Use the IPC surface from a renderer if you need
  remote access.
