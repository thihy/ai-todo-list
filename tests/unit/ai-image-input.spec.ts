// Image-input plumbing for the AI assistant.
//
// Two independent gates decide whether a pasted image can ever reach a model
// as a real image block (native vision) instead of being OCR'd by the model
// shelling out to `pwsh`:
//
//   1. `read_image` must be REGISTERED — dsh-tool-fs registers it inside
//      `ctx.inject(['attachments'], …)`, so resources/dsh/cordis.yml has to
//      mount an attachment service. Without it the tool simply does not exist.
//   2. the routed model must DECLARE image input — `read_image` calls
//      `llm.resolveModelInfo()` and refuses unless `inputModalities` contains
//      'image'. pi-ai catalog routes read that from the catalog; the `custom`
//      route hand-writes its model profile, so the value comes from the user's
//      `supportsImageInput` setting.
//
// Both are silent failure modes: a missing tool makes the model improvise, and
// a missing modality declaration makes the tool refuse. Pin them here.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SettingsStore } from '../../src/main/settings/store';

vi.mock('electron', () => ({
  app: { getPath: () => '.', getAppPath: () => '.' },
  BrowserWindow: { getAllWindows: () => [] },
}));

const CORDIS_YML = resolve(__dirname, '../../resources/dsh/cordis.yml');

describe('cordis composition: attachment service', () => {
  it('挂载 dsh-attachment-local —— read_image 的注册前提', () => {
    const yml = readFileSync(CORDIS_YML, 'utf8');
    expect(yml).toContain("'@deepseek-ai/dsh-attachment-local'");
  });

  it('给附件库钉死 dshHome，避免 fall back 到 ~/.dsh', () => {
    const yml = readFileSync(CORDIS_YML, 'utf8');
    // 不给 dshHome，dsh-attachment-local 会把桌面应用的数据写进用户家目录。
    expect(yml).toContain('DSH_ATTACHMENT_HOME');
  });

  it('附件服务排在 tool-fs 之前（inject 会自解析，但顺序读起来才是因果）', () => {
    const yml = readFileSync(CORDIS_YML, 'utf8');
    // 比的是 `name:` 注册行，不是注释里的提及 —— 注释里 tool-fs 出现得更早。
    const attachAt = yml.indexOf("name: '@deepseek-ai/dsh-attachment-local'");
    const toolFsAt = yml.indexOf("name: '@deepseek-ai/dsh-tool-fs'");
    expect(attachAt).toBeGreaterThan(-1);
    expect(toolFsAt).toBeGreaterThan(-1);
    expect(attachAt).toBeLessThan(toolFsAt);
  });
});

describe('package manifest', () => {
  it('dsh-attachment-local 必须是显式依赖，不能靠传递依赖', () => {
    // 这正是「read_image 不在工具集里」的历史根因：包在 node_modules 里躺着，
    // 但 package.json 没声明，pnpm 严格布局下一次干净的 install 就没了。
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'));
    expect(pkg.dependencies['@deepseek-ai/dsh-attachment-local']).toBe('0.1.5-rc.2');
  });
});

describe('custom route image declaration', () => {
  const build = async (supportsImageInput?: boolean) => {
    const { createLlmAdapters } = await import('../../src/main/dsh/llm-adapter');
    const { real } = createLlmAdapters({
      getEndpoint: () => ({ baseUrl: 'https://example.test/v1', apiKey: 'k' }),
      getCustomProviders: () => [
        {
          id: 'a',
          name: 'gw',
          protocol: 'openai' as const,
          baseUrl: 'https://example.test/v1',
          apiKey: 'k',
          model: 'qwen2.5-vl',
          supportsImageInput,
        },
      ],
      getCustomProviderId: () => 'a',
      getUserAgent: () => '',
      getAttachments: () => undefined,
    });
    return real.resolveModel('custom', 'qwen2.5-vl');
  };

  it('勾选视觉能力时 inputModalities 含 image', async () => {
    const info = await build(true);
    expect(info.inputModalities).toContain('image');
  });

  it('未勾选时只有 text —— read_image 应当 fail-closed 拒绝', async () => {
    // 少写 'image' 是刻意的：把图片发给纯文本模型只会换来一个 400，
    // 不如让 read_image 明确拒绝、AI 如实提示用户换模型。
    const info = await build(false);
    expect(info.inputModalities).toEqual(['text']);
    expect(info.inputModalities).not.toContain('image');
  });

  it('旧配置（没有这个字段）退化成纯文本，不改变改动前的行为', async () => {
    const info = await build(undefined);
    expect(info.inputModalities).toEqual(['text']);
  });
});

describe('能力声明的归属：模型，不是实例', () => {
  // 视觉能力是模型的属性。同一个自定义实例换模型时继承旧勾选，等于把图片
  // 发给纯文本模型换 400，所以 store 必须在 model 变化时重置。
  let dir: string;
  let store: SettingsStore;
  const inst = {
    id: 'a',
    name: 'gw',
    protocol: 'openai' as const,
    baseUrl: 'https://example.test/v1',
    apiKey: 'k',
    model: 'qwen2.5-vl',
    supportsImageInput: true,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'todo-list-imgcap-'));
    store = new SettingsStore(dir);
    store.mergeCustomProviders([inst]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('模型不变时保留视觉声明', () => {
    const v = store.get();
    expect(v.customProviders[0]?.model).toBe('qwen2.5-vl');
    expect(v.customProviders[0]?.supportsImageInput).toBe(true);
  });

  it('模型一换，视觉声明重置为 false（fail-closed）', () => {
    store.mergeCustomProviders([{ ...inst, model: 'qwen2.5-text' }]);
    const v = store.get();
    expect(v.customProviders[0]?.model).toBe('qwen2.5-text');
    expect(v.customProviders[0]?.supportsImageInput).toBe(false);
  });
});

describe('ai_models 报告解析后的能力，而不是读设置原始值', () => {
  it('工具源码必须从 llm seam 解析，而不是回读 settings 的勾选框', () => {
    const src = readFileSync(resolve(__dirname, '../../src/main/dsh/dsh-runtime.ts'), 'utf8');
    const body = src.slice(src.indexOf("name: 'ai_models'"), src.indexOf("name: 'ai_stats'"));
    expect(body).toContain('resolveModel');
    expect(body).toContain('canReadImages');
    // 勾选框只是喂给 llm 层的输入；这里若回读 settings，就成了第二条真值链。
    expect(body).not.toContain('settings.get().customProviders');
  });
});

describe('prompt 不再教模型绕路', () => {
  it('cordis.yml 不再把 pwsh 写成读图的可用退路', () => {
    const yml = readFileSync(CORDIS_YML, 'utf8');
    // 旧文案把 pwsh 写成「工具集里没有 read_image 就用它」的备选方案，
    // 那条退路就是模型跑去 Windows OCR 的原因。
    expect(yml).not.toContain('工具集里没有就用 pwsh');
    expect(yml).not.toContain('按格式解 PNG / JPEG');
  });

  it('明确禁止 OCR，并说明纯文本模型该换模型而不是绕路', () => {
    const yml = readFileSync(CORDIS_YML, 'utf8');
    expect(yml).toContain('不要用 OCR');
    // `Windows.Media.Ocr` 只允许作为「不要这么做」的举例出现，必须紧邻禁令。
    const idx = yml.indexOf('Windows.Media.Ocr');
    expect(idx).toBeGreaterThan(-1);
    expect(yml.slice(Math.max(0, idx - 60), idx)).toContain('不要用');
  });
});
