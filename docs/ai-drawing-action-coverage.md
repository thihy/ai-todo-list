# Excalidraw 原生动作覆盖

验证版本：Excalidraw 0.18.1。实际注册 93 项，本轮逐项尝试 93 项。使用真实 Electron、原生 action.perform、画布状态和任务文件保存路径。

OS 剪贴板使用隔离的 W3C ClipboardItem/Blob，文件选择器使用受控 File/句柄；没有依赖用户剪贴板内容或写入用户选择的外部文件。部分动作打开原生对话框或改变工具/选区，因此场景未变化也是有效结果。动作不满足原生条件时会明确拒绝。

类型中声明但当前引擎未注册的名称：`changeStrokeShape`、`toggleFullScreen`、`createContainerFromText`、`commandPalette`、`elementStats`。这些名称单独报告，不冒充可执行动作。

| 原生动作 | 执行结果 | 场景变化 | 已持久化 |
| --- | --- | --- | --- |
| setEmbeddableAsActiveTool | 成功 | 否 | 是 |
| deleteSelectedElements | 成功 | 是 | 是 |
| sendBackward | 成功 | 是 | 是 |
| bringForward | 成功 | 是 | 是 |
| sendToBack | 成功 | 是 | 是 |
| bringToFront | 成功 | 是 | 是 |
| selectAll | 成功 | 否 | 是 |
| duplicateSelection | 成功 | 是 | 是 |
| changeStrokeColor | 成功 | 否 | 是 |
| changeBackgroundColor | 成功 | 是 | 是 |
| changeFillStyle | 成功 | 否 | 是 |
| changeStrokeWidth | 成功 | 否 | 是 |
| changeSloppiness | 成功 | 是 | 是 |
| changeStrokeStyle | 成功 | 是 | 是 |
| changeOpacity | 成功 | 是 | 是 |
| changeFontSize | 成功 | 是 | 是 |
| decreaseFontSize | 成功 | 是 | 是 |
| increaseFontSize | 成功 | 是 | 是 |
| changeFontFamily | 成功 | 是 | 是 |
| changeTextAlign | 成功 | 是 | 是 |
| changeVerticalAlign | 成功 | 是 | 是 |
| changeRoundness | 成功 | 是 | 是 |
| changeArrowhead | 成功 | 否 | 是 |
| changeArrowType | 成功 | 是 | 是 |
| changeViewBackgroundColor | 成功 | 否 | 是 |
| clearCanvas | 成功 | 是 | 是 |
| zoomIn | 成功 | 否 | 是 |
| zoomOut | 成功 | 否 | 是 |
| resetZoom | 成功 | 否 | 是 |
| zoomToFitSelectionInViewport | 成功 | 否 | 是 |
| zoomToFitSelection | 成功 | 否 | 是 |
| zoomToFit | 成功 | 否 | 是 |
| toggleTheme | 成功 | 否 | 是 |
| toggleEraserTool | 成功 | 否 | 是 |
| toggleHandTool | 成功 | 否 | 是 |
| finalize | 成功 | 否 | 是 |
| changeProjectName | 成功 | 否 | 是 |
| changeExportScale | 成功 | 否 | 是 |
| changeExportBackground | 成功 | 否 | 是 |
| changeExportEmbedScene | 成功 | 否 | 是 |
| saveToActiveFile | 成功 | 否 | 是 |
| saveFileToDisk | 成功 | 否 | 是 |
| loadScene | 成功 | 是 | 是 |
| exportWithDarkMode | 成功 | 否 | 是 |
| copyStyles | 成功 | 否 | 是 |
| pasteStyles | 成功 | 否 | 是 |
| toggleCanvasMenu | 成功 | 否 | 是 |
| toggleEditMenu | 成功 | 否 | 是 |
| toggleShortcuts | 成功 | 否 | 是 |
| group | 成功 | 是 | 是 |
| ungroup | 成功 | 是 | 是 |
| goToCollaborator | 成功 | 否 | 是 |
| addToLibrary | 成功 | 否 | 是 |
| alignTop | 成功 | 是 | 是 |
| alignBottom | 成功 | 是 | 是 |
| alignLeft | 成功 | 是 | 是 |
| alignRight | 成功 | 是 | 是 |
| alignVerticallyCentered | 成功 | 是 | 是 |
| alignHorizontallyCentered | 成功 | 是 | 是 |
| distributeHorizontally | 成功 | 是 | 是 |
| distributeVertically | 成功 | 是 | 是 |
| flipHorizontal | 成功 | 是 | 是 |
| flipVertical | 成功 | 是 | 是 |
| copy | 成功 | 否 | 是 |
| paste | 成功 | 是 | 是 |
| cut | 成功 | 是 | 是 |
| copyAsSvg | 成功 | 否 | 是 |
| copyAsPng | 成功 | 否 | 是 |
| copyText | 成功 | 否 | 是 |
| gridMode | 成功 | 否 | 是 |
| zenMode | 成功 | 否 | 是 |
| objectsSnapMode | 成功 | 否 | 是 |
| stats | 成功 | 否 | 是 |
| unbindText | 成功 | 是 | 是 |
| bindText | 成功 | 是 | 是 |
| wrapTextInContainer | 成功 | 是 | 是 |
| hyperlink | 成功 | 否 | 是 |
| toggleElementLock | 成功 | 是 | 是 |
| unlockAllElements | 成功 | 是 | 是 |
| copyElementLink | 成功 | 否 | 是 |
| linkToElement | 成功 | 否 | 是 |
| toggleLinearEditor | 成功 | 否 | 是 |
| searchMenu | 成功 | 否 | 是 |
| cropEditor | 成功 | 否 | 是 |
| viewMode | 成功 | 否 | 是 |
| selectAllElementsInFrame | 成功 | 否 | 是 |
| removeAllElementsFromFrame | 成功 | 是 | 是 |
| updateFrameRendering | 成功 | 否 | 是 |
| setFrameAsActiveTool | 成功 | 否 | 是 |
| wrapSelectionInFrame | 成功 | 是 | 是 |
| autoResize | 成功 | 是 | 是 |
| undo | 成功 | 是 | 是 |
| redo | 成功 | 是 | 是 |

附加验证：原生 PNG 复制后粘贴，图片元素及二进制内容实际保存；拒绝剪贴板写入时，剪切返回失败并保留原元素，后续操作继续执行。图片 status 字段属于上游协同上传标记，本地保存以实际 files 和文件内容为准。

原始记录：打包产物目录中的 dist/validation/native-action-coverage.json。
