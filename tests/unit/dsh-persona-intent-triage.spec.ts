import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// cordis.yml 的 persona 是手写的 YAML 块标量，没有编译期保护：改坏了不会
// typecheck 报错，只会在用户面前表现为「AI 不建任务了」或者「AI 调了个不
// 存在的工具」。这里把它当契约钉住：
//   1. 意图判断章节必须在，且排在「工作原则」之前（每轮第一步）；
//   2. 闭环相关硬约束必须在（闭环不新建 / 不确定就问 / 普通聊天不静默创建）；
//   3. 提示词里不得再出现点号工具名（注册名是 todo_list，不是 todo.list），
//      只允许作为「别这么写」的反例出现；
//   4. 提示词点名的每个领域工具都必须在 dsh-runtime.ts 里真的注册过。

const cordis = readFileSync(resolve('resources/dsh/cordis.yml'), 'utf8');
const runtime = readFileSync(resolve('src/main/dsh/dsh-runtime.ts'), 'utf8');

function extractPersona(): string {
  const lines = cordis.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === 'persona: |-');
  expect(start, 'cordis.yml 必须保留 system-prompt.persona 块标量').toBeGreaterThanOrEqual(0);
  const base = (lines[start].match(/^ */) as RegExpMatchArray)[0].length + 2;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^- id: /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines
    .slice(start + 1, end)
    .map((l) => (l.trim() ? l.slice(base) : ''))
    .join('\n');
}

const persona = extractPersona();
const registeredTools = new Set(
  [...runtime.matchAll(/name: '([A-Za-z_]+)'/g)].map((m) => m[1]),
);

describe('DSH persona — 意图判断契约', () => {
  it('declares the four-way intent triage ahead of the working principles', () => {
    const triageAt = persona.indexOf('## 意图判断');
    const principlesAt = persona.indexOf('## 工作原则');
    expect(triageAt).toBeGreaterThanOrEqual(0);
    expect(principlesAt).toBeGreaterThanOrEqual(0);
    // 意图判断是「每轮第一步」，必须排在通用工作原则之前，否则模型会先
    // 读到「优先调工具作答」再决定要不要建任务。
    expect(triageAt).toBeLessThan(principlesAt);

    for (const cls of ['A 闭环收尾', 'B 新增事项', 'C 调整改期', 'D 闲聊咨询']) {
      expect(persona, `缺少意图分类 ${cls}`).toContain(cls);
    }
  });

  it('keeps the close-loop hard constraints that stop "搞定了" from creating a task', () => {
    // 这三条是本次改动的核心：闭环收尾走更新而不是新建；判不准就问；
    // 普通聊天里判为「新增」也必须先确认，不静默创建。
    expect(persona).toContain('闭环不新建');
    expect(persona).toContain('不确定就问');
    expect(persona).toContain('普通聊天不静默创建');
    // 焦点优先 + 检索匹配 + 多命中询问，三段判别流程。
    expect(persona).toContain('app_currentContext');
    expect(persona).toContain('todo_search');
    expect(persona).toContain('命中多条');
    expect(persona).toContain('ask_user_question');
  });

  it('still lets an explicit create-task envelope create directly', () => {
    // 表单路径靠显式封套，不走「先问再建」——否则每次建任务都要多点一次。
    expect(persona).toContain('带 create-task 封套的轮次才是直接创建');
    expect(persona).toContain('parentId 必须来自');
    expect(persona).toContain('todo_create');
  });

  it('never advertises dotted tool names outside the counter-example', () => {
    const dotted = persona
      .split('\n')
      .filter((l) => /\b(?:todo|content|drawing|inbox|conversation|ai|subtasks|app)\.[a-z]/.test(l));
    expect(persona).toContain('不要自己拼成');
    for (const line of dotted) {
      // 唯一允许出现的点号写法是「别这么写」的反例本身。
      expect(line, `点号工具名只能出现在反例里：${line.trim()}`).toContain('不要自己拼成');
    }
  });

  it('only names domain tools that are actually registered in dsh-runtime', () => {
    const named = new Set(
      [...persona.matchAll(/\b((?:todo|content|drawing|inbox|conversation|ai|subtasks|app)_[A-Za-z]+)\b/g)]
        .map((m) => m[1]),
    );
    expect(named.size).toBeGreaterThan(0);
    for (const name of named) {
      expect(registeredTools.has(name), `提示词点名了未注册的工具 ${name}`).toBe(true);
    }
  });
});
