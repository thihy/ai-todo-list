// DSH skills — `todo.*` / `content.*` / `drawing.*` are exposed as DSH-compatible
// tools via the registry in `tools.ts`. This file groups them into named "skills"
// the user can opt into from settings.

export interface DshSkill {
  id: string;
  name: string;
  description: string;
  tools: string[];
  /** Optional prompt fragment prepended to the system prompt. */
  promptFragment?: string;
  enabledByDefault: boolean;
}

export const SKILLS: DshSkill[] = [
  {
    id: 'todo-ops',
    name: 'TODO 操作',
    description: '列出、搜索、创建、修改 TODO',
    tools: ['todo.list', 'todo.get', 'todo.search', 'todo.stats', 'todo.create', 'todo.update', 'todo.delete'],
    promptFragment: '你可以读取和修改用户的 TODO；删除是不可恢复的，需要走权限闸门。',
    enabledByDefault: true,
  },
  {
    id: 'content-ops',
    name: '内容编辑',
    description: '读写 Markdown 正文，查看与还原历史版本',
    tools: ['content.readBody', 'content.writeBody', 'content.history', 'content.restoreVersion'],
    promptFragment: '你可以阅读和编辑每条 TODO 的 Markdown 正文；编辑会自动产生历史版本。',
    enabledByDefault: true,
  },
  {
    id: 'drawing-ops',
    name: '绘图',
    description: '列出、读取、创建 Excalidraw 绘图',
    tools: ['drawing.list', 'drawing.read', 'drawing.save', 'drawing.delete', 'drawing.setThumb'],
    promptFragment: '你可以读取和保存 Excalidraw 绘图；绘图以 JSON scene 形式存储。',
    enabledByDefault: false,
  },
  {
    id: 'analysis',
    name: '数据分析',
    description: '基于 TODO 数据的统计分析',
    tools: ['todo.list', 'todo.stats', 'todo.search'],
    promptFragment: '你可以对用户的 TODO 数据做汇总和趋势分析。',
    enabledByDefault: true,
  },
];

export function enabledToolsFor(skillIds: string[]): string[] {
  const set = new Set<string>();
  for (const id of skillIds) {
    const skill = SKILLS.find((s) => s.id === id);
    if (!skill) continue;
    for (const t of skill.tools) set.add(t);
  }
  return [...set];
}

export function defaultEnabledSkills(): string[] {
  return SKILLS.filter((s) => s.enabledByDefault).map((s) => s.id);
}

export function composeSystemPrompt(skillIds: string[]): string {
  const fragments = SKILLS
    .filter((s) => skillIds.includes(s.id))
    .map((s) => s.promptFragment)
    .filter((f): f is string => !!f);
  if (fragments.length === 0) return '';
  return ['Skills in effect:', ...fragments.map((f) => `- ${f}`)].join('\n');
}