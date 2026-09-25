// 拖放载荷提取 —— 从一个 HTML5 drop 事件里读出「一段文字 + 若干文件」。
//
// 三个拖放入口（桌面宠物 / AI 输入框 / 备忘录）都需要同一套解析，所以抽在
// 这里而不是各写一份：
//   - 文本优先级：text/plain → text/uri-list（从浏览器地址栏拖链接时只有
//     后者带值）
//   - 磁盘来源的文件用 webUtils.getPathForFile 拿绝对路径（preload 暴露的
//     pathForFile）；这个路径**只发给主进程**，渲染层自己从不读盘
//   - 没有路径的文件（浏览器里直接拖出的图片）退化成 data: URL，由主进程
//     解码落盘
//
// 形状与 PetFileRef / MemoFileRef 一致 —— 两者定义相同，pet.* 与 memo.*
// 都能收。

import type { PetFileRef } from '../../shared/todo-list-api';

export interface DropPayload {
  text: string;
  files: PetFileRef[];
}

/** File → data: URL。用于没有磁盘路径的 web 来源文件。 */
function fileToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * 解析一个 drop 事件。抛错时 message 直接可以展示给用户（已带上是哪个
 * 文件读失败了）。
 *
 * 调用方负责 `e.preventDefault()` —— 这里不碰事件对象，只读载荷。
 */
export async function readDropPayload(dt: DataTransfer): Promise<DropPayload> {
  const text = dt.getData('text/plain') || dt.getData('text/uri-list') || '';
  const files = Array.from(dt.files ?? []);
  const refs: PetFileRef[] = [];
  for (const f of files) {
    const path = window.todoList.pathForFile(f);
    if (path) {
      refs.push({ name: f.name || 'file', path });
    } else {
      const dataUrl = await fileToDataUrl(f);
      refs.push({
        name: f.name || 'file',
        mime: f.type || 'application/octet-stream',
        dataUrl,
        size: f.size,
      });
    }
  }
  return { text, files: refs };
}
