// 探针：在**真实 Electron + 真实 DSH boot** 下验证权限预设服务。
//
// 为什么必须用 Electron 而不是 vitest/tsx：bootDsh() 读 app.isPackaged 来
// 定位 cordis.yml，纯 Node 环境里 electron 的 app 是 undefined。
//
// 跑法：
//   pnpm exec electron resources/probe-permission-preset.cjs
//
// 验证链（每步都对应 UI 依赖的一个前提）：
//   1. permissionPresets 服务挂上了 → ctx.get('permissionPresets') 非空
//   2. 选项表可达 → names 恰好是 4 个，defaultPreset='auto'
//   3. 真实会话 pin 上默认预设 → 建 session 后 current() === 'auto'
//   4. set() 真的改折叠值 → set(session,'read-only') 后 current() 变
//      'read-only'（这是整个选择器 UI 的承重前提）
//   5. 投影事件真的落盘 → session 日志里有 permission/preset 事件
//
// 注意：本探针直接用 dsh-app-boot + cordis.yml，不走 bootDsh() —— 后者
// 依赖 electron-vite 的构建产物和一堆 app 级 deps。这里验证的是**服务层
// 契约**，也就是我的 runtime 方法包装的那一层。

const { app } = require('electron');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const root = resolve(__dirname, '..');
const scratch = mkdtempSync(join(tmpdir(), 'todo-list-preset-probe-'));
process.env.DSH_SESSIONS_ROOT = join(scratch, 'sessions');
process.env.DSH_WORKSPACE_ROOT = join(scratch, 'ws');
app.setPath('userData', scratch);

const log = (m) => console.log(`[PROBE] ${m}`);
let failed = false;
function check(cond, label) {
  if (cond) log(`PASS  ${label}`);
  else { failed = true; log(`FAIL  ${label}`); }
}

const timeout = setTimeout(() => {
  console.error('[PROBE] timed out after 90s');
  app.exit(1);
}, 90_000);

app.whenReady().then(async () => {
  let ctx;
  try {
    const { boot } = await import(pathToFileURL(join(
      root, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
    )).href);

    log('booting DSH from resources/dsh/cordis.yml ...');
    ctx = await boot(
      'preset-probe',
      join(root, 'resources/dsh/cordis.yml'),
      undefined,
      undefined,
      new URL('.', pathToFileURL(join(root, 'node_modules/@deepseek-ai/dsh-app-boot/lib/')).href).href,
    );
    log('boot OK');

    // 1. 服务挂载
    const svc = ctx.get('permissionPresets');
    check(!!svc, "ctx.get('permissionPresets') 非空");
    if (!svc) return;

    // 2. 选项表
    const names = [...svc.names].sort();
    check(
      JSON.stringify(names) === JSON.stringify(['auto', 'danger-full-access', 'read-only', 'workspace-write']),
      `names = [${names.join(', ')}]`,
    );
    check(svc.defaultPreset === 'auto', `defaultPreset = ${svc.defaultPreset}`);

    // 2b. UI 下拉要渲染的字段：每个预设都得有非空 name（没有就退化成显示
    //     raw value，界面会变成 "workspace-write" 这种机器串）。
    const labels = names.map((n) => {
      const o = svc.optionOf(n);
      return `${o.value}=${o.name}`;
    });
    check(
      names.every((n) => {
        try { return !!svc.optionOf(n).name; } catch { return false; }
      }),
      `optionOf().name 全非空: [${labels.join(', ')}]`,
    );
    // 'custom' 是旋钮值与任何预设都不匹配时派生的伪预设，用户没法"选"它。
    // 我的 permissionPresetCatalog() 直接列 names，所以这里确认它不在表里。
    check(!names.includes('custom'), "names 不含派生伪预设 'custom'");

    // 3. 真实会话 —— 走 sessions.create，跟 bootDsh 的 agents.create 同源
    const session = ctx.sessions.create('probe-conv-1', { meta: { cwd: process.env.DSH_WORKSPACE_ROOT } });
    check(svc.current(session) === 'auto', `新会话 current() = ${svc.current(session)}（期望 auto）`);

    // 3b. 关键时序：pinPermissionPreset() 是在 ensureAgent() 里、**首轮之前**
    //     跑的。所以 set() 必须在一个还没跑过任何 turn 的裸会话上生效 ——
    //     下面这条就是验证那个时刻。
    check(
      ctx.sessions.get('probe-conv-1') === session,
      'sessions.get(id) 拿到的就是 create() 那个 session（pin 路径靠它定位）',
    );

    // 4. set() 改折叠值
    svc.set(session, 'read-only');
    check(svc.current(session) === 'read-only', `set(read-only) 后 current() = ${svc.current(session)}`);
    svc.set(session, 'danger-full-access');
    check(svc.current(session) === 'danger-full-access', `set(danger-full-access) 后 current() = ${svc.current(session)}`);
    svc.set(session, 'auto');
    check(svc.current(session) === 'auto', `set(auto) 后 current() = ${svc.current(session)}`);

    // 5. 事件真的落进 session 日志（不是只在内存里）
    const events = session.events ?? session.log ?? [];
    const presets = [...events].filter((e) => e?.type === 'permission/preset');
    check(presets.length >= 3, `permission/preset 事件数 = ${presets.length}（期望 ≥3）`);
    const modes = [...events].filter((e) => e?.type === 'sandbox/mode');
    log(`sandbox/mode 事件数 = ${modes.length}`);

  } catch (err) {
    log(`探针抛异常: ${err?.stack ?? err}`);
    failed = true;
  } finally {
    clearTimeout(timeout);
    try { await ctx?.fiber?.dispose(); } catch {}
    try { rmSync(scratch, { recursive: true, force: true }); } catch {}
    log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
    app.exit(failed ? 1 : 0);
  }
});
