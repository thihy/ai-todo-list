import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as nativeMcpClient from '@deepseek-ai/dsh-mcp-client';
import { startDrawingMcpServer, type DrawingMcpService } from '../../src/main/drawing/mcp-server';
import type { DrawingStore } from '../../src/main/files/drawings';
import type { DrawingCanvasHost } from '../../src/main/drawing/canvas-host';

let service: DrawingMcpService | undefined; let client: Client | undefined; let ctx: Context | undefined;
afterEach(async () => { await ctx?.fiber.dispose(); await client?.close(); await service?.close(); ctx = undefined; client = undefined; service = undefined; });
async function setup() {
  const host = {
    activeDrawingId: () => 'drawing', isLive: () => true,
    readContext: vi.fn().mockResolvedValue({ ok: true, context: { drawingId: 'drawing', revision: 'live', selectedElementIds: ['a'], viewport: { scrollX: 1, scrollY: 2, zoom: 1 }, elements: [{ id: 'a', type: 'rectangle', x: 4, y: 5, text: '未保存', boundElements: [{ id: 'label', type: 'text' }] }, { id: 'label', type: 'text', containerId: 'a', text: '选区文字' }] } }),
    runEngineCommand: vi.fn().mockResolvedValue({ drawingId: 'drawing', opId: 'once', state: 'completed', ok: true, durable: true }),
    exportDrawing: vi.fn().mockResolvedValue({ ok: true, width: 1, height: 1, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=' }),
  };
  service = await startDrawingMcpServer({ host: host as unknown as DrawingCanvasHost, drawings: { get: (id: string) => id === 'drawing' ? { id, todoId: 'todo', title: '测试绘图' } : null, saveRender: () => '/tmp/drawing.png' } as unknown as DrawingStore });
  return host;
}

it('uses actual SDK HTTP initialize/list/call and enforces bearer and browser-origin boundaries', async () => {
  const host = await setup();
  expect((await fetch(service!.url, { method: 'POST', body: '{}' })).status).toBe(401);
  expect((await fetch(service!.url, { method: 'POST', headers: { Authorization: `Bearer ${service!.token}`, Origin: 'https://foreign.invalid' }, body: '{}' })).status).toBe(403);
  client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(service!.url), { requestInit: { headers: { Authorization: `Bearer ${service!.token}` } } }));
  const tools = await client.listTools();
  expect(tools.tools.map(tool => tool.name)).toEqual(['get_actions', 'execute_action', 'get_context', 'read_elements', 'apply_operations', 'get_operation', 'restore_checkpoint', 'render_snapshot']);
  const live = await client.callTool({ name: 'get_context', arguments: { drawingId: 'drawing' } });
  expect(JSON.parse((live.content as any)[0].text)).toMatchObject({ revision: 'live', selectedElementIds: ['a'] });
  const read = await client.callTool({ name: 'read_elements', arguments: { drawingId: 'drawing' } });
  expect(JSON.parse((read.content as any)[0].text).elements).toHaveLength(2);
  const invalid = await client.callTool({ name: 'apply_operations', arguments: { drawingId: 'drawing', opId: 'once', baseRevision: 'live', operations: [{ kind: 'update', id: 'a', changes: { version: 5 } }] } });
  expect(invalid.isError).toBe(true); expect(host.runEngineCommand).not.toHaveBeenCalled();
  const snapshot = await client.callTool({ name: 'render_snapshot', arguments: { drawingId: 'drawing' } });
  expect(snapshot.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image', mimeType: 'image/png' })]));
  expect((snapshot.content as any)[0].text).toContain('/tmp/drawing.png');
});

it('discovers and executes via the actual DSH native MCP client and tool registry', async () => {
  const host = await setup();
  ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, { mode: 'native' });
  await ctx.plugin(nativeMcpClient, { transport: 'streamable-http', serverName: 'drawing', url: service!.url, headers: { Authorization: `Bearer ${service!.token}` }, toolCallTimeoutMs: 5000, failOnStartupError: true });
  const tools = ctx.get('tools') as ToolRuntime;
  expect(tools.schemas().map(tool => tool.name)).toContain('mcp__drawing__apply_operations');
  const result = await tools.execute({ callId: 'mcp-test' as never, name: 'mcp__drawing__get_context', arguments: { drawingId: 'drawing' }, signal: new AbortController().signal });
  expect(result.isError).toBe(false);
  expect(JSON.parse((result.content[0] as any).text)).toMatchObject({ revision: 'live' });
  const edit = await tools.execute({ callId: 'mcp-edit' as never, name: 'mcp__drawing__apply_operations', arguments: { drawingId: 'drawing', opId: 'once', baseRevision: 'live', operations: [{ kind: 'update', id: 'a', changes: { text: '新文案' } }] }, signal: new AbortController().signal });
  expect(edit.isError).toBe(false);
  expect(host.runEngineCommand).toHaveBeenCalledWith('todo', expect.objectContaining({ kind: 'apply', operations: [{ kind: 'update', id: 'a', changes: { text: '新文案' } }] }));
  const snapshot = await tools.execute({ callId: 'mcp-render' as never, name: 'mcp__drawing__render_snapshot', arguments: { drawingId: 'drawing' }, signal: new AbortController().signal });
  expect(snapshot.isError).toBe(false);
  // With no model/attachment service this degrades explicitly, while canonical MCP blocks survive.
  expect(JSON.stringify(snapshot.content)).toContain('image unavailable');
  expect(JSON.stringify(snapshot.content)).toContain('/tmp/drawing.png');
  expect((snapshot as any).value.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image' })]));
  await ctx.fiber.dispose(); ctx = undefined;
  expect(tools.schemas()).toHaveLength(0);
});
