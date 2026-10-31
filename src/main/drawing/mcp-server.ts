import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { drawingApplyFields, drawingEngineId, drawingOutcomeFields, drawingRestoreFields, drawingNativeActionFields } from '../../shared/drawing-engine-schema';
import { DECLARED_NATIVE_ACTIONS, nativeActionGuidance } from '../../shared/drawing-native-actions';
import type { DrawingCanvasHost } from './canvas-host';
import type { DrawingStore } from '../files/drawings';
import { getFocus } from '../app-context';

export interface DrawingMcpService { url: string; token: string; close(): Promise<void> }
export interface DrawingMcpDependencies { host: DrawingCanvasHost; drawings: DrawingStore }

const response = (value: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) });
const readAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const editAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

function createDrawingMcp(deps: DrawingMcpDependencies): McpServer {
  const server = new McpServer({ name: 'todo-live-drawing', version: '1.0.0' });
  const drawing = (requested?: string) => {
    const focus = getFocus();
    const drawingId = requested ?? deps.host.activeDrawingId() ?? (focus?.kind === 'drawing' && deps.host.isLive(focus.drawingId) ? focus.drawingId : undefined);
    if (!drawingId) throw Error('没有当前绘图，请指定 drawing_list 返回的真实 drawingId');
    const meta = deps.drawings.get(drawingId);
    if (!meta) throw Error(`找不到绘图：${drawingId}`);
    return meta;
  };
  const context = async (requested?: string) => {
    const meta = drawing(requested);
    const result = await deps.host.readContext(meta.todoId, meta.id);
    if (!result.ok) throw Error(result.error);
    return { meta, context: result.context };
  };
  // Recoverable tool errors are explicit MCP errors, not exceptions escaping the HTTP lifecycle.
  const safe = <T extends unknown[]>(fn: (...args: T) => Promise<CallToolResult>) => async (...args: T): Promise<CallToolResult> => {
    try { return await fn(...args); }
    catch (cause) { return response({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }, true); }
  };
  server.registerTool('get_actions', {
    description: '读取当前 Excalidraw 实际注册的全部原生 action、可用前提和 value 示例。包括组合/解组、对齐/分布、层级、复制/粘贴、原生撤销/重做、文字/颜色/连线样式、框架、锁定、缩放、菜单、导入/导出等。此清单来自实际引擎，不是固定子集；enabled/available 反映当前选区与配置。需要用户交互的动作会打开其原生界面。先查询清单再 execute_action，不能猜动作名或退回 JSON 文件操作。',
    inputSchema: { drawingId: drawingEngineId.optional() }, annotations: readAnnotations,
  }, safe(async ({ drawingId }: { drawingId?: string }) => {
    const meta = drawing(drawingId);
    const result = await deps.host.readContext(meta.todoId, meta.id, undefined, true);
    if (!result.ok) throw Error(result.error);
    if (!result.context.nativeActions) throw Error('编辑器没有返回原生 action 清单，请更新构建');
    const registered = new Set(result.context.nativeActions.map(action => action.name));
    return response({ engineVersion: '0.18.1', drawingId: meta.id, revision: result.context.revision,
      selectedElementIds: result.context.selectedElementIds,
      actions: result.context.nativeActions.map(action => ({ ...action, ...nativeActionGuidance(action.name) })),
      declaredButNotRegistered: DECLARED_NATIVE_ACTIONS.filter(name => !registered.has(name)),
      unexpectedRegistered: [...registered].filter(name => !DECLARED_NATIVE_ACTIONS.includes(name)) });
  }));
  server.registerTool('execute_action', {
    description: '在同一个实时 Excalidraw 中执行 get_actions 清单里的任意原生 action。elementIds 可指定真实目标，省略使用当前选区；value 严格遵循 get_actions 的示例，没有输入的动作省略 value。baseRevision 来自最新实时查询，opId 唯一且重试复用。原生 UI/导入/导出/剪贴板动作可能要求用户继续操作或返回 no-scene-update；必须报告真实结果，不能假装完成。超时查询原 opId，禁止重放。正常绘图失败仅修正引擎请求，禁止读写完整场景 JSON 降级。',
    inputSchema: drawingNativeActionFields, annotations: { ...editAnnotations, openWorldHint: true },
  }, safe(async args => {
    const meta = drawing(args.drawingId);
    const result = await deps.host.runEngineCommand(meta.todoId, { kind: 'native-action', ...args });
    return response(result, !result.ok);
  }));
  server.registerTool('get_context', {
    description: '读取用户当前嵌入式绘图的实时上下文，包括未保存元素、真实选中元素 ID、视口和 revision。省略 drawingId 时使用当前打开的绘图。仅查询，不修改或保存。修改前先调用此工具；不要用文件内容代替实时场景。',
    inputSchema: { drawingId: drawingEngineId.optional() }, annotations: readAnnotations,
  }, safe(async ({ drawingId }: { drawingId?: string }) => {
    const { meta, context: live } = await context(drawingId);
    const index = live.elements.map(value => {
      const element = value as Record<string, unknown>;
      return Object.fromEntries(['id', 'type', 'x', 'y', 'width', 'height', 'text', 'originalText', 'containerId', 'startBinding', 'endBinding', 'locked'].filter(key => key in element).map(key => [key, element[key]]));
    });
    const selected = new Set(live.selectedElementIds);
    const listed = [...index.filter(element => selected.has(element.id as string)), ...index.filter(element => !selected.has(element.id as string))].slice(0, 2000);
    return response({ drawing: meta, revision: live.revision, selectedElementIds: live.selectedElementIds, viewport: live.viewport, elementCount: index.length, elements: listed, truncated: listed.length !== index.length });
  }));
  server.registerTool('read_elements', {
    description: '按真实元素 ID 读取当前画布完整元素，并包含其绑定文字、容器和连线端点。ids 省略时读取当前选区。返回该批数据对应的 revision。',
    inputSchema: { drawingId: drawingEngineId.optional(), ids: z.array(z.string().min(1).max(128)).min(1).max(100).optional() }, annotations: readAnnotations,
  }, safe(async ({ drawingId, ids }: { drawingId?: string; ids?: string[] }) => {
    const { meta, context: live } = await context(drawingId);
    const wanted = new Set(ids ?? live.selectedElementIds);
    if (!wanted.size) throw Error('没有选中元素，请先读取 get_context 后指定 ids');
    const elements = live.elements as Array<Record<string, unknown> & { id: string }>;
    const index = new Map(elements.map(element => [element.id, element]));
    for (const key of wanted) if (!index.has(key)) throw Error(`绘图元素不存在：${key}`);
    for (const key of [...wanted]) {
      const element = index.get(key)!;
      if (typeof element.containerId === 'string') wanted.add(element.containerId);
      for (const binding of [element.startBinding, element.endBinding] as Array<{ elementId?: string } | null>) if (binding?.elementId) wanted.add(binding.elementId);
      for (const bound of (element.boundElements ?? []) as Array<{ id: string }>) wanted.add(bound.id);
    }
    return response({ drawingId: meta.id, revision: live.revision, elements: elements.filter(element => wanted.has(element.id)) });
  }));
  server.registerTool('apply_operations', {
    description: '对当前嵌入式画布执行一批增量修改：add 创建矩形/椭圆/菱形/文字；update 修改真实元素的文字、位置或样式；connect 连接真实节点（也可引用本批新增节点）；delete 删除指定元素并清理绑定。新增绑定文字可用 add text 的 containerId 指向真实容器，支持 textAlign=left/center/right、verticalAlign=top/middle/bottom；容器已有文字时用 update 容器的 text，不可重复绑定。组合/层级等用 execute_action 原生操作，不要传内部字段。baseRevision 必须来自 get_context/read_elements；opId 唯一，重试复用。整批校验，冲突不应用，不覆盖无关元素。durable=true 才表示已保存；超时查询 get_operation，禁止盲目重放。',
    inputSchema: drawingApplyFields, annotations: editAnnotations,
  }, safe(async args => {
    const meta = drawing(args.drawingId);
    const result = await deps.host.runEngineCommand(meta.todoId, { kind: 'apply', ...args });
    return response(result, !result.ok);
  }));
  server.registerTool('get_operation', {
    description: '只读查询原 opId 的执行结果，必要时向原画布查询缓存。pending/unknown 不代表失败或未执行；继续查询并读取场景核实，禁止盲目重放修改。',
    inputSchema: drawingOutcomeFields, annotations: readAnnotations,
  }, safe(async args => {
    const meta = drawing(args.drawingId);
    return response(await deps.host.runEngineCommand(meta.todoId, { kind: 'outcome', ...args }));
  }));
  server.registerTool('restore_checkpoint', {
    description: '撤销一批 AI 修改。checkpointId 必须来自之前的 apply_operations 结果，baseRevision 来自最新实时查询；如果之后有其他编辑则拒绝撤销，绝不覆盖用户后续修改。返回 durable=true 才表示已保存。每个画布仅保留最近 3 个快照，关闭画布后快照失效。',
    inputSchema: drawingRestoreFields, annotations: editAnnotations,
  }, safe(async args => {
    const meta = drawing(args.drawingId);
    const result = await deps.host.runEngineCommand(meta.todoId, { kind: 'restore', ...args });
    return response(result, !result.ok);
  }));
  server.registerTool('render_snapshot', {
    description: '将当前真实画布（含未保存修改及视口外内容）渲染为 PNG，返回本地 PNG 路径和 MCP 图片。仅图像输入模型能进行视觉检查；文本模型请使用 read_elements，不要声称看过图片。',
    inputSchema: { drawingId: drawingEngineId.optional() }, annotations: readAnnotations,
  }, safe(async ({ drawingId }: { drawingId?: string }) => {
    const meta = drawing(drawingId);
    const image = await deps.host.exportDrawing(meta.todoId, meta.id);
    if (!image.ok || !image.dataUrl?.startsWith('data:image/png;base64,')) throw Error(image.error ?? '画布没有返回 PNG');
    if (image.dataUrl.length > 28 * 1024 * 1024) throw Error('绘图导出过大');
    const data = image.dataUrl.slice('data:image/png;base64,'.length);
    const path = deps.drawings.saveRender(meta.id, Buffer.from(data, 'base64'));
    return { content: [...response({ drawingId: meta.id, path, width: image.width, height: image.height }).content, { type: 'image' as const, mimeType: 'image/png', data }] };
  }));
  return server;
}

/** SDK Streamable HTTP on loopback, authenticated by a per-process secret. */
export async function startDrawingMcpServer(deps: DrawingMcpDependencies): Promise<DrawingMcpService> {
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  const active = new Set<McpServer>();
  let expectedHost = '';
  const http = createServer((req, res) => {
    void (async () => {
      const authorization = Buffer.from(req.headers.authorization ?? '');
      if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) { res.writeHead(401).end(); return; }
      if (req.headers.host !== expectedHost || req.headers.origin) { res.writeHead(403).end(); return; }
      if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      let bytes = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 1_048_576) { res.writeHead(413).end(); return; }
        chunks.push(Buffer.from(chunk));
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { res.writeHead(400).end(); return; }
      const server = createDrawingMcp(deps);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      active.add(server);
      res.once('close', () => { active.delete(server); void server.close().catch(() => {}); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  http.requestTimeout = 20_000; http.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', () => { http.off('error', reject); resolve(); }); });
  const address = http.address();
  if (!address || typeof address === 'string') throw Error('绘图 MCP 没有本地端口');
  expectedHost = `127.0.0.1:${address.port}`;
  return { url: `http://${expectedHost}/mcp`, token,
    async close() {
      await Promise.allSettled([...active].map(server => server.close()));
      await new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); });
    },
  };
}
