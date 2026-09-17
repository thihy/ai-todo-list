# AI 工具（fs / shell）跨平台验证清单

> 配套 plan §8.23；win32/macOS/Linux 各跑一遍 read/write/bash/pwsh + 始终/本次会话授权撤销。
> 自动化不能替代手动 e2e —— sandbox 走的是 OS 内核特性（Windows ACL / macOS Seatbelt / Linux Landlock+bwrap），
> 只有真机才能确认 fall-closed。下面把 10 个 step 排成可勾选清单 + 关键观察点。

## 环境前置

```text
- 启动:  npm run dev  （electron-vite dev 走 dsh-runtime boot）
- workspace 落点：<dataDir>/dsh_workspace/   (Windows: %APPDATA%/AI待办/dsh_workspace)
                macOS: ~/Library/Application Support/AI待办/dsh_workspace
                Linux: ~/.config/AI待办/dsh_workspace
- env:  process.env.DSH_WORKSPACE_ROOT 必须 = 上面这条路径
       （src/main/index.ts 在 import DSH container 之前 set，
        见 resources/dsh/cordis.yml sandbox-policy.workspaceRoot）
- 关键依赖（已装，node_modules 全部到位）：
    dsh-tool-fs / dsh-tool-pwsh / dsh-tool-bash / dsh-tool-fs-search
    dsh-sandbox-policy / dsh-sandbox-windows-acl / dsh-sandbox-local
    dsh-fs-sandbox / dsh-pwsh-sandbox / dsh-bash-sandbox
    dsh-fs-observation-policy / dsh-subprocess / dsh-subprocess-local
    dsh-spill / dsh-spill-local
```

## 步骤

- [ ] **1. workspace 创建** — 启动后检查 `<dataDir>/dsh_workspace/` 存在；`process.env.DSH_WORKSPACE_ROOT` 已设（main/index.ts 启动日志里有）。
- [ ] **2. read auto（workspace 内）** — AI 提示："请读 dsh_workspace/README.md" → 直接返回，无弹窗。
- [ ] **3. read 越界（workspace 外）** — AI 提示："用 read 读 /etc/passwd" → 工具抛 `PATH_OUTSIDE_WORKSPACE`（pre-execute deny），红色错误卡。
- [ ] **4. write 触发审批** — AI 提示："用 write 创建 dsh_workspace/test.txt 内容 hello" → PendingApprovalCard 弹出，预览含 file_path + content 长度 + 前 200 字符。
- [ ] **5. edit 触发审批** — AI 提示："用 edit 把 test.txt 的 hello 改成 world" → 弹窗。
- [ ] **6. shell 触发审批** —
  - Windows:  "用 pwsh 跑 Get-Location" → 弹窗 + preview 显示命令
  - macOS/Linux: "用 bash 跑 pwd" → 弹窗 + preview 显示命令
- [ ] **7. shell path 越界被 sandbox 二次拒绝** — 弹窗允许后执行：
  - Windows: `Get-Content C:\Windows\System32\drivers\etc\hosts` → ACL 拒绝；输出含 `[sandbox: file access denied under workspace-write mode]`
  - macOS:   `cat /etc/passwd`                → Seatbelt 拒绝；输出含 `[sandbox: file access denied under workspace-write mode]`
  - Linux:   `cat /etc/passwd`                → Landlock/bwrap 拒绝；同上
- [ ] **8. 始终允许 持久化** — write 弹窗 → 点"始终允许此工具" → 再次 write 无弹窗 → 关 app 重启 → 仍然无弹窗 → 打开 settings → AI → 工具授权 → 看到"始终允许（持久化）"段有 write → 点撤销 → 下次 write 重新弹窗。
- [ ] **9. 本次会话允许 内存态** — write 弹窗 → 点"本次会话允许" → 再次 write 无弹窗 → 关 app 重启 → 重新弹窗（不持久化）。
- [ ] **10. grep / glob 直通** — AI 提示："用 grep 搜 dsh_workspace 里所有含 TODO 的文件" → 直通返回 SearchBlock 列表，无审批。

## 平台差异

| 平台 | sandbox executor | shell tool | 备注 |
|------|------------------|------------|------|
| win32 | `dsh-sandbox-windows-acl` (restricted-token + ACL) | `pwsh` | `bash` 工具**未注册**（cordis.yml 注释 bash-sandbox / tool-bash 整段 # 掉了） |
| macOS | `dsh-sandbox-local` (Seatbelt / sandbox-exec) | `bash` | 需要切换 cordis.yml：`sandbox` → `@deepseek-ai/dsh-sandbox-local`；启用 `bash-sandbox` + `tool-bash`；注释掉 `pwsh-sandbox` + `tool-pwsh` |
| linux | `dsh-sandbox-local` (bwrap + Landlock)        | `bash` | 同 macOS 切换；bwrap 不可用时回退 Landlock-only |

> 当前默认 `resources/dsh/cordis.yml` 是 win32 配置：macOS / Linux 上跑 dev 前需要手动切换 sandbox executor + shell 工具。
> 计划里 §2 写了切换说明（"POSIX 用 '@deepseek-ai/dsh-sandbox-local' + bash-sandbox"），
> 但 cordis.yml 不支持表达式分支 —— 切换靠手动编辑并 git commit。

## 视觉验证（不依赖平台）

- [ ] PendingApprovalCard 三档按钮（允许一次 / 本次会话允许 / 始终允许此工具）布局美观、与 DSH RiskConfirmation 视觉对齐
- [ ] read → ReadBlock 卡片（不是 JsonBlock 退化）
- [ ] write / edit → DiffBlock 卡片（含 file_path + newText 高亮）
- [ ] bash / pwsh → TerminalBlock 卡片（output + exitCode + signal）
- [ ] grep → SearchBlock matches 卡片（按 file 分组）
- [ ] glob → SearchBlock paths 卡片

## 单元测试覆盖（已通过 66 / 66）

```
tests/unit/path-guard.spec.ts        — 13 / 13 ✓   workspace 路径越界 + symlink 越界 + Windows 大小写 + ENOENT 回落
tests/unit/ai-grants.spec.ts         — 13 / 13 ✓   session grant Map 隔离 + 撤销 + 清空
tests/unit/tool-presentation.spec.ts — 40 / 40 ✓   read → ReadBlock / write → DiffBlock / bash → TerminalBlock / grep / glob 投影
```

## 已知未覆盖（需要手动 e2e）

- DSH sandbox 内核级 fall-closed —— 必须真机跑 step 7 三个平台的越界命令
- ACL / Seatbelt / Landlock 各自的权限报告格式（输出文本与计划中 `[sandbox: file access denied under workspace-write mode]` 字面值可能略有出入，以 sandbox 包的实际输出为准）
- 进程重启后 settings.aiGrantedTools 仍生效（step 8 第二段）

## 已知遗留（pre-existing，不在本计划 scope）

- `src/main/dsh/llm-adapter.ts:147,190,229,281` —— `modelErrors` 不在 `ResolvedPiAiProviderProfile` 类型里。已与 0.1.5-rc.2 类型签名脱节，等 DSH pi-ai 包发布修正版本再 align。
- `tests/unit/{boot-probe,data-layer,task-appearance,updater,warmup-dsh-runtime}.spec.ts` —— 5 个 spec 在 main 上同样失败，跟本计划无关。