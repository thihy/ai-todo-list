// DocumentsView — 任务的多文档工作区（schema v21）。顶部一条横向 tab 栏，
// 选中文档的编辑器填满下方空间：
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │ [进展] [文档] [绘图]                       [↻]  [⛶]  [+]     │  ← tab 栏
//   ├──────────────────────────────────────────────────────────────┤
//   │  按 kind 渲染对应编辑器：                                    │
//   │   progress → MarkdownEditor                                │
//   │   note_md   → MarkdownEditor                                │
//   │   drawing   → Excalidraw 编辑器                              │
//   └──────────────────────────────────────────────────────────────┘
//
// tab 列表**从磁盘目录派生**：文档就是文件，标签就是文件名（除了 progress.md
// 固定叫「进展」）。所以用户在应用外丢一个 .md 进来、或删掉一个文件，点一下
// ↻ 就能看到变化 —— 不需要任何 DB 索引去记录「有哪些文档」。
//
// 注意：链接 和 附件 不在这里。它们各有自己的表(todo_links /
// inbox_attachments)，没有对应的文件，属于任务身份区而不是「用户创作内容」。
// 它们在 TodoEditorPane 里有专属 section。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDocuments, useDocument, useDrawings } from '../hooks/useTodoListApi';
import { usePrompt } from '../hooks/usePrompt';
import { useFocusSync } from '../hooks/useFocusSync';
import { MarkdownEditor } from './MarkdownEditor';
import { ExcalidrawEditor } from './ExcalidrawEditor';
import {
  IconActivity,
  IconClose,
  IconDoc,
  IconDrawing,
  IconFullscreen,
  IconPlus,
  IconRefresh,
} from './icons';
import type { AppFocus } from '../../shared/todo-list-api';
import type { DocumentKind, DrawingMeta } from '../../shared/todo-types';

const KIND_ICON: Record<DocumentKind, React.FC<{ size?: number }>> = {
  progress: IconActivity,
  note_md: IconDoc,
  drawing: IconDrawing,
};

const KIND_LABEL: Record<DocumentKind, string> = {
  progress: '进展',
  note_md: '文档',
  drawing: '绘图',
};

/** A unified tab entry — one file in the task directory. 绘图文件同时在
 *  drawings 表里有一行（缩略图挂在 drawing id 上），那行是**派生索引**：
 *  它补的是 id / 缩略图，身份仍然是磁盘上那个文件。文件在、行不在（用户
 *  在应用外丢进来的 .excalidraw）时 id 为 null，见下方占位视图。 */
type Tab = {
  kind: DocumentKind;
  fileName: string;
  label: string;
  /** Only set for drawing files that have a drawings row. */
  drawingId: string | null;
  thumb: string | null;
};

/** Delete (×) affordance on a tab. The default progress doc is not removable
 *  (it's the task's primary work surface).
 *
 *  提示语必须点名磁盘上将被删掉的那个文件 —— 既然文件就是文档，只说「删除
 *  「架构_1」？」会让人不确定到底动了什么。 */
function removeTab(tab: Tab, todoId: string, after: () => void): void {
  if (tab.kind === 'progress') return;
  if (!window.confirm(`删除「${tab.label}」？\n磁盘上的文件 ${tab.fileName} 会一起删除。`)) return;
  // 有 drawings 行的绘图走 DrawingStore（顺带清缩略图和 DB 行），
  // 其余一律直接删文件 —— 文件才是文档本身。
  if (tab.kind === 'drawing' && tab.drawingId) {
    void window.todoList.drawing.delete(tab.drawingId).then(after);
    return;
  }
  void window.todoList.document.remove(todoId, tab.fileName).then(after);
}

const DocEditor: React.FC<{ todoId: string; tab: Tab }> = ({ todoId, tab }) => {
  const { content, version, save, saving, error } = useDocument(todoId, tab.fileName);

  switch (tab.kind) {
    case 'progress':
    case 'note_md':
      return (
        <MarkdownEditor
          docId={tab.fileName}
          todoId={todoId}
          value={content}
          version={version}
          onSave={save}
          saving={saving}
          error={error}
        />
      );
    default:
      return <div className="docs-workspace__empty">{KIND_LABEL[tab.kind]} 视图待实现</div>;
  }
};

/** 一个 .excalidraw 文件还没有 drawings 行（用户直接丢进目录的）。文件在、
 *  内容完好，所以这里如实告诉用户它是什么、为什么暂时不能编辑 —— 至少它
 *  没有被悄悄藏起来。 */
const UnclaimedDrawingView: React.FC<{ todoId: string; tab: Tab }> = ({ todoId, tab }) => {
  const { documents, refresh } = useDocuments(todoId);
  void documents;
  return (
    <div className="docs-workspace__empty">
      <p>{tab.fileName} 是这个任务目录里的绘图文件，但还没有登记到绘图列表。</p>
      <p>在应用里新建一张绘图并保存后，它会接管这个文件。</p>
      <button type="button" onClick={() => void refresh()}>
        重新扫描目录
      </button>
    </div>
  );
};

/** Drawing tab body: in-place Excalidraw editor. The legacy "open editor"
 *  affordance is gone — selecting a drawing tab mounts the editor here,
 *  mirroring how progress / note_md work in the same workspace. */
const DrawingView: React.FC<{ todoId: string; drawingId: string }> = ({ todoId, drawingId }) => (
  <div className="docs-workspace__drawing">
    <ExcalidrawEditor todoId={todoId} drawingId={drawingId} className="docs-workspace__excalidraw" />
  </div>
);

export const DocumentsView: React.FC<{
  todoId: string;
  /** Task title — included in the focus push so the AI sees it without a
   *  separate todo.get call. Optional; falls back to a generic title. */
  taskTitle?: string | null;
  /** Open the editor fullscreen (hides the task list; AI pane stays). */
  onFullscreen?: () => void;
  /** Controlled active tab id, lifted to the App so the selection survives
   *  the normal ↔ fullscreen unmount/remount of this component. Optional;
   *  when omitted, DocumentsView falls back to its own internal state. */
  selectedDocId?: string | null;
  onSelectDoc?: ((tabId: string) => void) | null;
}> = ({ todoId, taskTitle, onFullscreen, selectedDocId, onSelectDoc }) => {
  const { documents, error, refresh, refreshFromDisk } = useDocuments(todoId);
  const [createError, setCreateError] = useState<string | null>(null);
  const { drawings, refresh: refreshDrawings } = useDrawings(todoId);
  const { node: promptNode } = usePrompt();
  // Controlled vs uncontrolled: when the parent passes selectedDocId + a
  // setter, the parent's state is the source of truth (so fullscreen-mode
  // mount can pick up where normal-mode left off). Without those props we
  // fall back to internal state — backwards-compat for any existing caller
  // that doesn't (yet) wire the lift.
  const isControlled = selectedDocId !== undefined && selectedDocId !== null && onSelectDoc != null
    ? true
    : selectedDocId !== undefined && onSelectDoc != null;
  const [internalSelected, setInternalSelected] = useState<string | null>(null);
  const effectiveSelected = isControlled ? selectedDocId : internalSelected;
  const setSelected = useCallback(
    (id: string): void => {
      if (isControlled && onSelectDoc) {
        onSelectDoc(id);
      } else {
        setInternalSelected(id);
      }
    },
    [isControlled, onSelectDoc],
  );
  const [addOpen, setAddOpen] = useState(false);
  // Inline tab rename (double-click the label). Works for both document tabs
  // (document.rename) and drawing tabs (drawing.rename).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  // 拼装 tab 列表 —— **完全从目录扫描结果派生**，documents 就是那张权威
  // 清单（progress 第一，其余按标签名排序）。
  //
  // 绘图文件在这里补上 drawings 行的 id / 缩略图：标签就是文件名去掉扩展名，
  // 所以按 label 就能和 drawings.title 对上。对不上的（用户直接丢进目录的
  // .excalidraw）drawingId 为 null —— 照样占一个 tab，不藏起来。
  const tabs: Tab[] = useMemo(() => {
    const byLabel = new Map<string, DrawingMeta>();
    for (const d of drawings) if (d.title) byLabel.set(d.title, d);
    return documents.map((f) => {
      const hit = f.kind === 'drawing' ? byLabel.get(f.label) : undefined;
      return {
        kind: f.kind,
        fileName: f.fileName,
        label: f.label,
        drawingId: hit?.id ?? null,
        thumb: hit?.thumbPath ?? null,
      };
    });
  }, [documents, drawings]);

  const tabId = (t: Tab): string => (t.drawingId ? `g:${t.drawingId}` : `d:${t.fileName}`);

  // Auto-select the progress doc (first, ord 0) when the list loads or the
  // selection is no longer present (e.g. after a delete). Skip the
  // auto-pick when controlled and the parent hasn't picked yet — the
  // parent may intentionally be holding for a re-render; we don't want to
  // race it and write a default back into its state.
  useEffect(() => {
    if (tabs.length === 0) return;
    if (!effectiveSelected || !tabs.some((t) => tabId(t) === effectiveSelected)) {
      const first = tabs[0]!;
      setSelected(tabId(first));
    }
  }, [tabs, effectiveSelected, setSelected]);

  const refreshAll = useCallback(() => {
    void refresh();
    void refreshDrawings();
  }, [refresh, refreshDrawings]);

  // --- inline tab rename (double-click label → input) ---
  const startEdit = useCallback((tab: Tab): void => {
    const id = tabId(tab);
    setEditingId(id);
    setEditDraft(tab.label);
  }, []);

  // Focus + select on entry so typing replaces the old label.
  useEffect(() => {
    if (editingId) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingId]);

  const commitEdit = useCallback(async (): Promise<void> => {
    if (!editingId) return;
    const id = editingId;
    const next = editDraft.trim();
    setEditingId(null);
    if (!next) return;
    const tab = tabs.find((t) => tabId(t) === id);
    if (!tab) return;
    if (next === tab.label) return;
    // 改名 = 搬文件。绘图走 DrawingStore（它管映射和缩略图），其余直接搬。
    if (tab.kind === 'drawing' && tab.drawingId) {
      const res = await window.todoList.drawing.rename(tab.drawingId, next);
      if (res.ok) {
        await refreshDrawings();
        await refresh();
      }
      return;
    }
    // progress.md 名字固定，main 会原样返回旧名 —— 这里跟着刷新即可。
    const res = await window.todoList.document.rename(todoId, tab.fileName, next);
    if (res.ok) await refresh();
  }, [editingId, editDraft, tabs, todoId, refresh, refreshDrawings]);

  const cancelEdit = useCallback((): void => {
    setEditingId(null);
  }, []);

  // 新建文档：main 分配不撞名的文件名（文档 → 文档_1 → …），返回的就是
  // 实际落地的那个文件，标签跟着它走。
  const addNote = useCallback(async (): Promise<void> => {
    setCreateError(null);
    const res = await window.todoList.document.create({ todoId, title: '文档' });
    if (res.ok) {
      await refresh();
      setSelected(`d:${res.data.fileName}`);
    } else {
      setCreateError(res.message ?? '新增文档失败');
    }
    setAddOpen(false);
  }, [todoId, refresh, setSelected]);

  // 绘图: create the drawing in-place, refresh the tab list, and select it.
  // The Excalidraw editor mounts directly inside the tab body — no separate
  // page navigation. (DrawingPane still exists for deep-link back-compat.)
  // 标题交给 main 端的 DrawingStore 决定（默认「绘图」）：在这里写死一个
  // '新绘图' 会让磁盘文件名变成 新绘图.excalidraw，和默认规则对不上。
  const addDrawing = useCallback(async (): Promise<void> => {
    const res = await window.todoList.drawing.save(todoId, { elements: [], appState: {} });
    if (res.ok) {
      await refreshDrawings();
      const d = res.data as { id: string };
      setSelected(`g:${d.id}`);
    }
    setAddOpen(false);
  }, [todoId, refreshDrawings, setSelected]);

  // Close the add menu on outside click.
  useEffect(() => {
    if (!addOpen) return;
    const onDown = (e: MouseEvent): void => {
      const el = e.target as HTMLElement | null;
      if (!el?.closest('.docs-workspace__add')) setAddOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [addOpen]);

  const selected = tabs.find((t) => tabId(t) === effectiveSelected) ?? null;

  // Push the document/drawing focus to main on every tab change so the AI's
  // `app.currentContext` tool knows what's open. We push the most-specific
  // focus we can; App.tsx pushes a broader task-level focus that gets
  // replaced by this one once the user picks a tab.
  const focus: AppFocus | null = useMemo(() => {
    if (!selected) return null;
    // 有 drawings 行的绘图报 drawing 焦点（AI 有 drawing_* 工具可调）；
    // 其余文档按文件名指过去，AI 用 content_* / document.write 操作。
    if (selected.kind === 'drawing' && selected.drawingId) {
      return {
        kind: 'drawing',
        todoId,
        drawingId: selected.drawingId,
        drawingTitle: selected.label,
        taskTitle: taskTitle ?? null,
      };
    }
    return {
      kind: 'document',
      todoId,
      documentFileName: selected.fileName,
      documentKind: selected.kind,
      documentTitle: selected.label,
      taskTitle: taskTitle ?? null,
    };
  }, [selected, todoId, taskTitle]);
  useFocusSync(focus);

  return (
    <div className="docs-workspace docs-workspace--tabs">
      <div className="docs-workspace__tabbar">
        <div className="docs-workspace__tabs" role="tablist">
          {tabs.map((t) => {
            const Icon = KIND_ICON[t.kind]!;
            const id = tabId(t);
            const title = t.label;
            const isEditing = editingId === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={id === effectiveSelected}
                className={`docs-workspace__tab${id === effectiveSelected ? ' is-active' : ''}${isEditing ? ' is-editing' : ''}`}
                onClick={() => setSelected(id)}
                onDoubleClick={(e) => { e.stopPropagation(); startEdit(t); }}
                title={title}
              >
                <Icon size={14} />
                {isEditing ? (
                  <input
                    ref={editInputRef}
                    type="text"
                    className="docs-workspace__tab-input"
                    value={editDraft}
                    aria-label="重命名"
                    onChange={(e) => setEditDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); void commitEdit(); }
                      else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                    }}
                    onBlur={() => { void commitEdit(); }}
                  />
                ) : (
                  <span className="docs-workspace__tab-label">{title}</span>
                )}
                {!isEditing && t.kind !== 'progress' && (
                  <span
                    role="button"
                    className="docs-workspace__tab-close"
                    aria-label="删除"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeTab(t, todoId, refreshAll);
                    }}
                  >
                    <IconClose size={12} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="docs-workspace__add">
          {/* 重新扫描目录。文档就是文件，用户在应用外丢进来的 .md / 删掉
              的文件不会触发任何 IPC 广播 —— 这个按钮清掉 main 的扫描缓存
              后重读，变化就显出来了。放在 tab 栏右侧、全屏按钮之前。 */}
          <button
            type="button"
            className="docs-workspace__add-btn"
            onClick={() => void refreshFromDisk()}
            title="重新扫描目录（显示在应用外新建 / 删除的文件）"
            aria-label="重新扫描目录"
          >
            <IconRefresh size={16} />
          </button>
          {onFullscreen && selected && (
            <button
              type="button"
              className="docs-workspace__add-btn"
              onClick={onFullscreen}
              title="全屏编辑 (隐藏任务列表，保留 AI 助手)"
              aria-label="全屏编辑"
            >
              <IconFullscreen size={16} />
            </button>
          )}
          <button
            type="button"
            className="docs-workspace__add-btn"
            onClick={() => setAddOpen((v) => !v)}
            title="新增文档"
            aria-label="新增文档"
          >
            <IconPlus size={16} />
          </button>
          {addOpen && (
            <div className="docs-workspace__add-menu">
              <button type="button" onClick={addNote}>
                <IconDoc size={14} /> Markdown文档
              </button>
              <button type="button" onClick={addDrawing}>
                <IconDrawing size={14} /> 绘图
              </button>
            </div>
          )}
        </div>
      </div>

      {(error || createError) && <div role="alert">文档操作失败：{createError ?? error}</div>}
      <div className="docs-workspace__editor">
        {selected ? (
          selected.kind === 'drawing' ? (
            selected.drawingId ? (
              <DrawingView key={selected.drawingId} todoId={todoId} drawingId={selected.drawingId} />
            ) : (
              <UnclaimedDrawingView key={selected.fileName} todoId={todoId} tab={selected} />
            )
          ) : (
            <DocEditor key={selected.fileName} todoId={todoId} tab={selected} />
          )
        ) : (
          <div className="docs-workspace__empty">选择上方标签开始编辑</div>
        )}
      </div>
      {promptNode}
    </div>
  );
};
