// MIME / filename helpers shared between the IPC inbox handler
// (main/index.ts) and the AI tool surface (dsh-runtime.ts). Kept out of
// main/index.ts so the AI tool module can import these without dragging
// in the whole Electron app entry point (which would crash in test envs
// that don't mock electron-updater / app paths).

/** Map a MIME type to a default file extension. Returns "bin" for unknown
 *  image types. Used when writing a pasted-image blob to disk. */
export function mimeExt(mime: string): string {
  const m = /image\/([a-z0-9.+-]+)/i.exec(mime);
  if (!m) return 'bin';
  if (m[1] === 'jpeg') return 'jpg';
  return m[1];
}

/** Windows 保留设备名 —— 用这些名字建文件会被文件系统直接拒绝。 */
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/** Sanitize a user-supplied filename for safe use on disk (and on every OS the
 *  user might be on). 保留中文和常见标点，只剔除真正有风险的部分。
 *
 *  为什么不是纯 ASCII 白名单：附件名是用户自己起的（「设计稿-终版.png」）。
 *  旧实现把 `[^\x00-\x7F]` 全打成 `_`，于是中文名在磁盘上变成
 *  `__-___.png` —— 用户在文件管理器里完全认不出自己的附件。
 *
 *  剔除清单：
 *   - Windows 非法字符 `< > : " / \ | ? *`（其中 `/ \ :` 还会破坏路径层级）
 *   - 用户点名的高风险字符 `[]` 以及控制字符
 *   - 首尾的 '.' 和空格（Windows 视末尾的点为非法，且大小写不敏感）
 *   - 连续空白压缩成单个空格（避免 `a   b.png` 这种从显示上像重复的怪名字）
 *
 *  保留：汉字、字母、数字、空格，以及中文标点（，。！？、（）等）和
 *  `- _ . # @ +` 这类常用符号。
 *
 *  长度上限 60 个码点 —— 加上 ULID 前缀和扩展名后仍远低于 NTFS 的 255 字节
 *  限制（一个汉字 UTF-8 占 3 字节）。 */
export function sanitizeName(s: string): string {
  const cleaned = s
    // 控制字符 + Windows 非法字符 + 用户点名要剔除的方括号
    // eslint-disable-next-line no-control-regex -- \x00-\x1f 正是这里要清洗掉的控制字符
    .replace(/[\x00-\x1f<>:"/\\|?*[\]]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  const capped = Array.from(cleaned).slice(0, 60).join('').replace(/[.\s]+$/g, '');
  if (!capped) return '';
  // 保留名加后缀避开（只在整个名字就是保留名时才需要）
  const dot = capped.lastIndexOf('.');
  const stem = dot > 0 ? capped.slice(0, dot) : capped;
  if (WINDOWS_RESERVED.test(stem)) return `${capped}_`;
  return capped;
}
