# AI 文件访问与 Agent Skills

在「设置 → AI 文件与技能」配置外部文件读取和技能目录。

默认受限模式可直接读取工作区、技能目录和显式填写的只读白名单，其他路径默认逐次确认。
外部 read、read_image、grep、glob 调用会显示当前路径的审批卡，每次调用单独确认；用户可以在对话内批准这次读取。显式选择禁止外部读取后才直接拒绝。Auto 在逐次确认选项下也会确认 Shell 命令，因为命令可自行读取外部文件。原有 Auto 的 Shell 策略仍在未启用此选项时生效；文件工具白名单并不是 Shell 的操作系统沙箱。

完全访问会话允许外部读写和命令，仍保留应用自身工作空间配置的保护规则。受限模式的外部写入继续受 DSH 沙箱控制；模型需通过工具支持的 sandbox_permissions 和 justification 请求一次性提升权限。只读白名单不会授予写入权限。

目录必须是绝对路径或 `~/` 开头的用户目录。目录联接与符号链接按真实路径判断，不能通过白名单内部的链接读取无关目录。白名单修改立即生效。

用户级共享技能目录是 `~/.agents/skills`，Windows 中通常为 `%USERPROFILE%\.agents\skills`。同时加载 `~/.codex/skills`（或 `CODEX_HOME/skills`）、`~/.claude/skills` 和 `~/.dsh/skills`（或 `DSH_HOME/skills`）。项目级是工作区所属项目的 `.agents/skills`。额外目录每行填写一个包含技能子目录的路径，重启应用后发现。

AI 助手标题栏的技能图标提供搜索清单和安装入口；安装时选择包含有效 `SKILL.md` 的本地技能目录，验证后安装到共享目录。对话中询问“有哪些技能”时使用 `skill_list` 读取真实清单；`skill` 只加载清单中的真实技能名称，不能把 `skills` 当作技能名称。

每个技能子目录包含 `SKILL.md`，其 YAML frontmatter 必须有 `name` 和 `description`。先发现技能元数据，使用时再加载正文；`references/`、`scripts/`、`assets/` 可按需读取。读取技能目录不会自动授权脚本执行或写入。链接到其他位置的资源仍要符合真实路径白名单或逐次确认规则。

本次修复明确设置 DSH 的 agentsHome：旧配置的空字符串被当前插件解析成进程目录，导致用户级技能未被发现。

依据：[Agent Skills 格式规范](https://agentskills.io/specification)与[官方接入目录约定](https://agentskills.io/client-implementation/adding-skills-support)。格式规范定义 SKILL.md 内容，项目级和用户级目录是客户端之间的共享约定。
