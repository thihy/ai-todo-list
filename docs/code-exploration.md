# Code Exploration

How an Agent should orient itself in this codebase before opening
any task that touches contracts, IPC, AI behavior, or storage.
The goal is to make call-chain judgment cheap, traceable, and
robust against partial tooling availability.

> **Tool availability is variable.** This document covers three
> states: CodeGraph CLI available, CodeGraph MCP available, and
> neither available. Pick the first state you can confirm; fall
> back without stopping the task.

## 1. Status check

Before doing anything else, determine which tooling is alive:

```bash
codegraph status --no-color
```

A healthy result prints file / node / edge counts, the backend
(`node:sqlite - built-in (full WAL)` here), and a list of
pending changes. A `Backend: none` line means CodeGraph is not
initialised in this checkout — run `codegraph init` once, then
re-check.

When `Pending Changes: Modified: N files` is non-zero, the index
is stale relative to your working tree:

```bash
codegraph sync --no-color
```

Do not start a cross-cutting task against a stale index; it will
miss new files and report wrong callers.

## 2. Tooling matrix

| State | How to detect | Preferred path |
| --- | --- | --- |
| CLI available | `codegraph status` exits 0 | Drive everything from CLI |
| MCP tools loaded | `codegraph_*` tools appear in the Agent function list | Drive from MCP (faster, structured) |
| Neither | CLI command fails (sandbox / PATH) **and** no MCP tools | Use `rg` + hand-traced call chains |

If CLI is denied but MCP is loaded, prefer MCP. If MCP is loaded
but stale, `codegraph sync` via the shell is still available.

### CLI-on-PATH-or-not

The CLI is normally a global `codegraph` binary. Some Agent
sandboxes deny execution of binaries outside the workspace. In
that case:

- Request a wider sandbox permission (one-shot retry) **or**
- call the MCP tools instead **or**
- fall back to `rg` per §4.

Do not work around the denial by copying the binary into the
workspace or shelling through `node_modules/.bin/`. Both create
faux compliance without addressing the actual security policy.

## 3. Query discipline

CodeGraph's natural-language `context` is best-effort. It will
honestly warn when a query matched mostly on common words; treat
that warning as a signal to switch to exact-symbol queries.

Good queries (specific user behaviour or data flow):

```text
codegraph context "用户提交 Composer 表单到 todo.create"
codegraph context "AI ask 通过 DSH runtime 进入 todo 写入"
codegraph context "稳定任务目录在创建 / 重命名时的解析"
codegraph context "tag 目录 rename 与历史任务关联的边界"
```

Bad queries (broad keywords, will be low confidence):

```text
codegraph context "todo"
codegraph context "AI"
```

For individual symbols use the focused commands:

```bash
codegraph node src/main/db/todo-repo.ts::create
codegraph callers src/main/db/tag-repo.ts::merge
codegraph callees src/main/dsh/dsh-runtime.ts::getDshRuntime
codegraph impact src/shared/ipc-schema.ts::TagCatalogRow
```

## 4. The mandatory `rg` supplement

CodeGraph indexes **static** call relationships. It cannot see:

- IPC channel strings declared by `register('channel.name', ...)` and matched against `IpcChannelName`;
- `BrowserWindow.webContents.send('app:data-changed', ...)` push events;
- `app.on('before-quit', ...)` / `'window-all-closed'` lifecycle hooks;
- `app://` / `attachment://` custom protocol registrations;
- dynamic `import('...')` chains and `React.lazy(() => import('...'))`;
- `resources/dsh/cordis.yml` plugin / tool / permission declarations;
- CSS class names and CSS module relationships in `src/renderer/styles/`;
- React effect dependencies, setState-in-callback, and closure capture.

For every task, **always run `rg`** at minimum to:

```bash
# String-form IPC channels
rg -n "register\(['\"]" src/main/ipc
rg -n "__todo_router__" src
rg -n "IpcChannelName" src/shared

# Event subscriptions
rg -n "ipcRenderer\.on" src
rg -n "webContents\.send" src/main
rg -n "APP_EVENTS" src/preload

# Electron lifecycle
rg -n "app\.on\(['\"]" src/main
rg -n "setWindowOpenHandler|protocol\." src/main

# Dynamic imports
rg -n "import\(['\"]\\.\\./" src
rg -n "React\.lazy" src/renderer

# DSH plugin / tool surface
rg -n "tools:|permission:" resources/dsh

# CSS
rg -n "className=" src/renderer | rg -o 'className="[^"]*"' | sort -u
```

If a string-channel or event-name check contradicts what
CodeGraph reports, the string check wins — the call only exists
if the channel actually fires.

## 5. Three real call-chain examples

These are the three chains a new Agent must be able to trace from
end to end before declaring "I understand the architecture".

### 5.1 Form task creation

```text
src/renderer/components/Composer.tsx (form submit)
  → window.todoList.todo.create(input)                   # shared/todo-list-api.ts
  → ipcRenderer.invoke('__todo_router__', 'todo.create', { input })
  → src/preload/index.ts (proxy)
  → src/main/ipc/router.ts (channel allowlist + dispatch)
  → src/main/ipc/todo-handlers.ts (handler closure)
  → TodoRepo.create(input)                               # src/main/db/todo-repo.ts
      ├─ INSERT INTO todos (...)
      ├─ INSERT INTO tags (todo_id, tag) (one row per name)
      ├─ onTagsAttached(names) → TagRepo.activateUsedNames(names)
      └─ writeBody(todo.id, '')  +  resolveTaskDir(todo.id)
  → Broadcast app:data-changed { scope: 'todos' }        # BrowserWindow.webContents.send
  → Renderer data-bus bumps 'todos' counter              # src/renderer/data-bus.ts
  → useTodos refetches → TodoListPane re-renders
```

Spot-check the static graph with `rg`:

```bash
rg -n "register\('todo\\.create'" src/main/ipc
rg -n "onTagsAttached|activateUsedNames" src/main
rg -n "'app:data-changed'" src/main
```

### 5.2 AI `todo.create` tool call

```text
src/renderer/panes/AIPane.tsx (user submits with intent: 'create-task')
  → window.todoList.ai.ask({ intent, prompt, images })
  → __todo_router__ → 'ai.ask'
  → src/main/ipc/ai-handlers.ts
  → getDshRuntime()                                      # src/main/dsh/dsh-runtime.ts (lazy)
  → DSH agent loop dispatches the 'todo.create' tool
  → tool handler → TodoRepo.create(...)                  # same path as §5.1 from this point
  → Streamed tool-result back through ai:stream
```

Static-check the dynamic parts:

```bash
rg -n "intent.*create-task|encodeTaskCreationEnvelope" src
rg -n "todo\\.create" resources/dsh/cordis.yml
rg -n "AIProvider|providerRouteFor" src/main/dsh
```

### 5.3 Stable task-directory resolution

```text
TodoRepo.create / update / read
  → taskDirectories.resolve(todoId)                      # src/main/files/task-directories.ts
      ├─ SELECT title, storage_dir FROM todos WHERE id = ?
      ├─ storage_dir ?  return join(todosDir, basename(storage_dir))
      └─ else  storage_dir = findLegacyDir(...) ?? preferredName(todoId, title)
              └─ UPDATE todos SET storage_dir = ? WHERE id = ?
  → return join(todosDir, dirName); mkdirSync({ recursive: true })
  → MarkdownStore / DrawingStore / InboxStore / DocumentStore
    all consume the SAME path via resolveTaskDir (DI'd in src/main/index.ts)
```

Important: never add a sibling resolver that recomputes the
directory from the current title. AGENTS.md invariant #4.

```bash
rg -n "TaskDirectoryStore|taskDirectories\\.resolve" src/main
rg -n "preferredName|findLegacyDir" src/main/files/task-directories.ts
rg -n "resolveTaskDir" src/main/index.ts
```

## 6. Before committing

```bash
codegraph affected <changed-files...>
```

This surfaces the test files that exercise the changed code. A
real change usually pulls in one or two `tests/unit/*.spec.ts`
files; if `affected` returns nothing for a substantive change,
double-check that you have not accidentally edited a non-indexed
path.

Then:

```bash
pnpm typecheck
git diff --check
git diff --stat
git status --short
```

## 7. Index lifecycle rules

- `.codegraph/` is git-ignored at two levels (root `.gitignore`
  line 33 + `.codegraph/.gitignore`). Never commit `codegraph.db`,
  `daemon.pid`, `daemon.log`, or the per-project socket name.
- If a teammate reports "CodeGraph is missing", they probably
  need `codegraph init` once on a fresh clone. The init creates
  `.codegraph/` locally and is safe to re-run.
- If `codegraph status` shows the daemon is stuck (idle timeout
  exceeded, socket file present but no live process), run
  `codegraph unlock` to drop the lock before re-syncing.
- Do **not** install the MCP server automatically into another
  Agent's config without their explicit consent — `codegraph
  install` modifies `~/.claude/...` etc. and is irreversible from
  inside the workspace.

## 8. Quick reference

```text
orient       codegraph status --no-color
refresh      codegraph sync --no-color
behaviour    codegraph context "<user behaviour or data flow>"
symbol       codegraph node <symbol>
incoming     codegraph callers <symbol>
outgoing     codegraph callees <symbol>
risk         codegraph impact <symbol>
tests        codegraph affected <file...>
static gaps  rg -n "<pattern>" src[/renderer/main|/preload|/shared|/main/dsh|/resources]
fallback     rg + hand-traced call chains, do not invent
```
