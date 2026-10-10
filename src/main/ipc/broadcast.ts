// 内容作用域的数据变更广播。
//
// tab 列表现在是**按目录扫描**出来的（TaskFileIndex），所以任何改动磁盘文件
// 集合的操作——新建 / 删除 / 改名绘图或文档、增删附件、恢复版本——都必须
// 广播一次，订阅了 `useDataVersion(['content'])` 的列表才会重新拉取。
//
// 漏掉广播的症状很隐蔽：文件确实写进磁盘了，git 也提交了，但用户要手动点
// 刷新按钮才能在 UI 上看到刚建的东西。绘图的新建就踩过这个坑，所以这里拆成
// 独立模块，让 content-handlers 和 document-handlers 共用同一个实现，避免
// 各自复制一份又漏掉。

import { BrowserWindow } from 'electron';

/** 通知所有窗口某个作用域的数据变了。已销毁的窗口直接跳过。 */
export function broadcastDataChanged(scope: 'content'): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('app:data-changed', { scope });
  }
}