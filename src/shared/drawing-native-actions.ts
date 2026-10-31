import { z } from 'zod';

/** Installed Excalidraw 0.18.1 ActionName inventory. Runtime registration is authoritative. */
export const DECLARED_NATIVE_ACTIONS = `copy cut paste copyAsPng copyAsSvg copyText sendBackward bringForward sendToBack bringToFront copyStyles selectAll pasteStyles gridMode zenMode objectsSnapMode stats changeStrokeColor changeBackgroundColor changeFillStyle changeStrokeWidth changeStrokeShape changeSloppiness changeStrokeStyle changeArrowhead changeArrowType changeOpacity changeFontSize toggleCanvasMenu toggleEditMenu undo redo finalize changeProjectName changeExportBackground changeExportEmbedScene changeExportScale saveToActiveFile saveFileToDisk loadScene duplicateSelection deleteSelectedElements changeViewBackgroundColor clearCanvas zoomIn zoomOut resetZoom zoomToFit zoomToFitSelection zoomToFitSelectionInViewport changeFontFamily changeTextAlign changeVerticalAlign toggleFullScreen toggleShortcuts group ungroup goToCollaborator addToLibrary changeRoundness alignTop alignBottom alignLeft alignRight alignVerticallyCentered alignHorizontallyCentered distributeHorizontally distributeVertically flipHorizontal flipVertical viewMode exportWithDarkMode toggleTheme increaseFontSize decreaseFontSize unbindText hyperlink bindText unlockAllElements toggleElementLock toggleLinearEditor toggleEraserTool toggleHandTool selectAllElementsInFrame removeAllElementsFromFrame updateFrameRendering setFrameAsActiveTool setEmbeddableAsActiveTool createContainerFromText wrapTextInContainer commandPalette autoResize elementStats searchMenu copyElementLink linkToElement cropEditor wrapSelectionInFrame`.split(' ');

const color = z.string().min(1).max(64);
const parameterized = {
  changeStrokeColor: { schema: z.object({ currentItemStrokeColor: color }).strict(), example: { currentItemStrokeColor: '#1e1e1e' } },
  changeBackgroundColor: { schema: z.object({ currentItemBackgroundColor: color }).strict(), example: { currentItemBackgroundColor: '#ffc9c9' } },
  changeViewBackgroundColor: { schema: z.object({ viewBackgroundColor: color }).strict(), example: { viewBackgroundColor: '#ffffff' } },
  changeFillStyle: { schema: z.enum(['solid', 'hachure', 'cross-hatch', 'zigzag']), example: 'solid' },
  changeStrokeWidth: { schema: z.number().min(.1).max(20), example: 2 },
  changeSloppiness: { schema: z.number().min(0).max(3), example: 1 },
  changeStrokeStyle: { schema: z.enum(['solid', 'dashed', 'dotted']), example: 'dashed' },
  changeOpacity: { schema: z.number().min(0).max(100), example: 80 },
  changeFontSize: { schema: z.number().min(8).max(256), example: 24 },
  changeFontFamily: { schema: z.object({ currentItemFontFamily: z.number().int().min(1).max(100) }).strict(), example: { currentItemFontFamily: 5 } },
  changeTextAlign: { schema: z.enum(['left', 'center', 'right']), example: 'center' },
  changeVerticalAlign: { schema: z.enum(['top', 'middle', 'bottom']), example: 'middle' },
  changeRoundness: { schema: z.enum(['round', 'sharp']), example: 'round' },
  changeArrowhead: { schema: z.object({ position: z.enum(['start', 'end']), type: z.enum(['arrow', 'bar', 'dot', 'triangle', 'circle', 'circle_outline', 'triangle_outline', 'diamond', 'diamond_outline', 'crowfoot_one', 'crowfoot_many', 'crowfoot_one_or_many']).nullable() }).strict(), example: { position: 'end', type: 'arrow' } },
  changeArrowType: { schema: z.enum(['sharp', 'round', 'elbow']), example: 'elbow' },
  changeProjectName: { schema: z.string().min(1).max(240), example: '流程图' },
  changeExportBackground: { schema: z.boolean(), example: true },
  changeExportEmbedScene: { schema: z.boolean(), example: false },
  changeExportScale: { schema: z.number().positive().max(10), example: 2 },
  exportWithDarkMode: { schema: z.boolean(), example: false },
  toggleTheme: { schema: z.enum(['light', 'dark']).nullish(), example: 'dark' },
  goToCollaborator: { schema: z.object({ socketId: z.string().max(128).optional(), username: z.string().max(240).optional(), isCurrentUser: z.boolean().optional() }).strict(), example: {} },
} satisfies Record<string, { schema: z.ZodTypeAny; example: unknown }>;

export function nativeActionGuidance(name: string) {
  const parameter = parameterized[name as keyof typeof parameterized];
  const ui = ['loadScene', 'saveToActiveFile', 'saveFileToDisk', 'hyperlink', 'linkToElement', 'toggleShortcuts', 'toggleCanvasMenu', 'toggleEditMenu', 'commandPalette', 'searchMenu', 'cropEditor', 'toggleLinearEditor', 'setFrameAsActiveTool', 'setEmbeddableAsActiveTool'].includes(name);
  const prerequisite = name === 'bindText' ? '选中一个未绑定文字和一个可绑定容器'
    : name === 'unbindText' ? '选中含绑定文字的容器'
    : name === 'unlockAllElements' ? '清空选区，画布中至少有一个锁定元素'
    : name === 'autoResize' ? '选中一个 autoResize=false 的文字'
    : name === 'copyText' ? '选中文字或带绑定文字的容器，并允许剪贴板写入'
    : name === 'saveToActiveFile' ? '先用原生 loadScene 打开带文件句柄的场景，或用 saveFileToDisk 保存；不能处于查看模式'
    : name === 'ungroup' ? '选中已分组元素'
    : name.startsWith('distribute') ? '至少三个选中元素'
    : name.startsWith('align') || name === 'group' ? '至少两个选中元素'
    : name.includes('Frame') ? '按动作选择真实框架或目标元素'
    : name === 'cropEditor' ? '选中一张图片'
    : name === 'toggleLinearEditor' ? '选中一条线或箭头'
    : name === 'goToCollaborator' ? '只能引用真实协作者；空对象表示停止跟随'
    : '以当前实时选区和原生动作前提为准';
  return { value: parameter ? { example: parameter.example, required: !['toggleTheme'].includes(name) } : { example: null, required: false },
    prerequisite, interaction: ui ? '可能打开原生界面/文件选择器或进入编辑模式；按返回状态提示用户继续，不得假装已完成交互' : '执行原生动作；检查结果、实际场景变化和错误' };
}

export function validateNativeActionValue(name: string, value: unknown): unknown {
  const parameter = parameterized[name as keyof typeof parameterized];
  if (parameter) return parameter.schema.parse(value);
  if (value !== null && value !== undefined) throw Error(`动作 ${name} 不接受 value，请先读取 get_actions 的输入说明`);
  return null;
}
