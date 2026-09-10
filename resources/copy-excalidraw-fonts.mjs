// 把 @excalidraw/excalidraw 包的字体从 node_modules 拷贝到 Vite 的 public 目录，
// 让构建产物可以本地提供字体服务，避免渲染进程从 esm.sh 下载字体。
//
// excalidraw 在初始化时会用 ASSETS_FALLBACK_URL（esm.sh）作为字体加载的兜底
// URL；通过预先设置 window.EXCALIDRAW_ASSET_PATH（见 ExcalidrawEditor.tsx）
// 把字体基址指向 /excalidraw/fonts/，就能强制走本地 app:// 协议。
//
// 注意：src/renderer/public/ 已经被 .gitignore 排除（参见 /public/ 条目），
// 这里拷贝出来的 woff2 文件不进版本库。

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const src = join(repoRoot, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts');
const dst = join(repoRoot, 'src/renderer/public/excalidraw/fonts');

if (!existsSync(src)) {
  // 没装包就不报错——开发时可能 pnpm 安装未完成；运行时若仍找不到字体，
  // excalidraw 会回退到默认 fallback 字体（系统字体），不会崩溃。
  process.exit(0);
}

mkdirSync(dst, { recursive: true });

let copied = 0;
let skipped = 0;
for (const family of readdirSync(src)) {
  const familySrc = join(src, family);
  const familyStat = readdirSync(familySrc, { withFileTypes: true });
  for (const entry of familyStat) {
    if (!entry.isFile() || !entry.name.endsWith('.woff2')) continue;
    const from = join(familySrc, entry.name);
    const to = join(dst, family, entry.name);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied++;
  }
}
void skipped;
console.log(`[copy-excalidraw-fonts] copied ${copied} woff2 files to ${dst}`);