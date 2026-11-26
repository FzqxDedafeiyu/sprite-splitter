# V9 Feature Inventory — Phase 0

> 检查日期：2026-11-26
> 范围：main 基线 `473931a1109d118f1acfb3c4d91f349f2ac22873` 中的 V9 HTML 与 V9 使用说明
> 证据类型：静态源码/UI 检查；尚未进行浏览器行为验收

## 状态定义

- **存在（源码确认）**：存在可见 UI 入口及实现代码；不代表运行时已通过。
- **部分存在**：能力存在但受限、需手工步骤或未覆盖完整工作流。
- **未发现**：在当前 HTML 中未发现对应实现。
- 主要源码行号按当前 838 行文件计，后续若文件变更必须重新定位。

## 功能清单

| 功能 | 存在性 / UI 入口 | 主要实现位置 | 依赖关系 | 已知限制 / 迁移注意 |
|---|---|---|---|---|
| 图片导入 | 存在；左栏「① 导入素材」文件选择器 `#file`，支持 PNG/WebP/JPG | `#file.onchange`，约 L580 | 浏览器 File、Image、Canvas、Object URL | 每次载入清空 sprites；没有工程自动保存；需确认 URL 生命周期与大图内存 |
| Alpha 自动识别 | 存在；「② 自动识别」模式 Alpha / 自动判断，Alpha 阈值 | `autoDetect()` L310-L355 | Canvas ImageData、连通域 flood fill | 自动判断以是否存在 alpha<255 为准；阈值影响半透明边缘；小区域可能被面积阈值过滤 |
| 自动切分 | 存在；「自动识别区域」按钮 `#detect` | `autoDetect()` L310-L355 | Alpha 或边缘浅色背景掩码、4/8 邻域、面积阈值、外扩边距 | 基于像素连通，不理解语义；接触物体可能合并；自动结果需人工复核 |
| 不透明浅色背景抠除 | 存在；自动/浅色背景模式、亮度阈值 |
| 独立整图背景抠除按钮 | 未发现独立入口；当前只有自动识别时的边缘浅色背景排除，以及针对当前选区的 GrabCut 精修 | `autoDetect()` L310-L355、`runGrabCut()` L367-L420 | Canvas 像素分析 / OpenCV.js | 不应把两种局部能力宣传为任意背景的一键去除 | `autoDetect()` L310-L355 | Canvas 像素读取、从边缘 flood-fill | 仅边缘连通且高亮、低饱和像素被当作背景；不是通用抠图；内含白色区域通常受保护但仍需测 |
| 手动矩形选区 | 存在；`#add`「手动追加矩形选区」 | 主 Canvas pointerdown/move/up，约 L606-L655 | Canvas 坐标换算、drag 状态 | 需核实 addMode 状态切换和点击/拖动边界；自动切分后允许继续追加 |
| 多边形选区 | 存在；`#lasso`「多边形抠选」 | lassoMode / lassoPoints、Canvas 事件约 L606-L655；`cropCanvas()` L357 起 | 指针事件、点集、Canvas destination-in | 双击闭合；多边形外像素透明；复杂自交/极小多边形未验收 |
| 选区移动 | 存在；Canvas 选中框拖动 | 主 Canvas pointer 事件约 L606-L655 | selected、drag、screenToImage | 源图裁切坐标会随移动改变；需验证拖动边界与指针取消 |
| 选区缩放 | 存在；选区边缘/控制点拖动（源码 drag resize 分支） | 主 Canvas pointermove 的 resize 分支，约 L634-L655 | drag 状态、边界限制 | 需实测最小尺寸、边界与手柄命中区域 |
| 选区修正 / 删除 | 存在；`#delete`、属性面板 X/Y/W/H +「应用坐标」 | `select()` L302 起；事件绑定约 L580 以后 | sprites 数组、selected、history | 属性面板是单个选区；修改需检查是否有 snapshot 及列表同步 |
| 精灵命名 / 分类 / 描述 | 存在；右侧「选中区域属性」 | `select()` L302 起；输入绑定与刷新逻辑约 L580 以后 | selected、sprites | 以自由文本为主；未发现受控分类字典 |
| 精灵列表 | 存在；右侧「⑦ 精灵列表」 | `refreshList()` L286 起 | sprites、selected、裁切缩略图 | 列表项选择与主属性面板通过 select 刷新 |
| 背景精修 / 智能抠边 | 部分存在；「单独精修面板」、保留/排除笔刷、「运行智能收边」 | `openRefinePanel()`、`runGrabCut()` L367-L420 | OpenCV.js CDN、前景/背景笔迹、Canvas、mask | OpenCV 需联网；需要前景和背景各一笔；只对当前 sprite；不是整图背景一键移除 |
| 重叠区域分析与清理 | 存在；「分析重叠并预览」及确认弹窗 | `overlapComponents()`、`proposeOverlapCleanup()` L500-L560 左右 | 源图 Alpha、矩形交集、连通域、mask | 归属不确定区域保护并提示；算法仍需用相邻/交叠素材测试 |
| Agent 任务包导出 | 存在；「导出 Agent 任务包」 | `agentTask()`、`exportAgentTask()` L420-L455 | 原图 Canvas PNG、JSON、ZIP store 实现 | 输出 source.png、agent_task.json、AGENT_PROMPT.txt；需核对 ZIP 完整性 |
| Agent JSON 导入 | 存在；「导入 Agent 标注」 | `importAgentResultData()`、`parseAgentJsonText()` L455-L522 | 文件读取、JSON parse、sprite_id 对应 | 支持 spatial-scene-agent-result/v2 和 sprite-agent-result/v1；按 sprite 编号映射，不能假定任意 UUID |
| 属性面板 | 存在；名称、分类、描述、X/Y/W/H、场景属性 | `select()` L302 起；`syncSceneControls()` L665 起 | selected 与 sprites | 多处手工刷新；需回归验证列表/面板/画布一致性 |
| 场景布局标注 | 存在；工具栏「场景布局标注」及右侧场景区域 | `syncSceneControls()`、`toggleLayoutMode()` L665-L680 | layer、parallax、anchor、zIndex、depth | 场景坐标与 sourceRect 语义不同；V10 迁移必须保留差异 |
| 场景位置、缩放、旋转 | 存在；场景检视工作台右侧属性和画布拖动 | `scenePos/sceneScale/sceneRotation`、`drawInspectorSprite()` L685-L705；检视事件 L790-L835 | Canvas transform、sceneX/Y、scale、rotation | 缩放/旋转围绕 sprite 中心；绘制定位使用 sceneX/Y 回退到 x/y |
| 场景视差检视 | 存在；「打开场景检视 / 局部调整」 | `drawParallax()`、`openParallax()` L730-L790 | layer/parallax、camera、Canvas | 视差为检视模拟；不是完整引擎运行时或真实相机系统 |
| 图层/层级管理 | 部分存在；场景工作台部件列表的 ↑/↓、层级选择、显隐/锁定 | `renderInspectList()`、`drawParallax()` L705-L770 | zIndex、layer、visible、locked | ↑/↓ 与显隐/锁定的更新路径需核对历史快照和状态同步 |
| 分组与批量属性 | 存在；场景检视列表勾选、组名、编组、统一应用组属性 | `createInspectGroup` 与 `applyInspectGroup` 事件，约 L750-L770 | group、inspectMultiSelection、属性面板 | 批量应用层级/视差/深度/Z/缩放/旋转；不批量设置位置、锚点 |
| PNG 导出 | 存在；「逐张下载 PNG」 | `cropCanvas()`、`cropBlob()`、`exportPngs()` L356-L360、L579-L581 | Canvas、Blob、浏览器下载 | 多文件下载可能被浏览器拦截；透明边缘/多边形/mask需实测 |
| JSON 导出 | 存在；「导出 JSON」 | `manifest()`、`exportJson()` L560-L580 | Manifest schema、JSON.stringify | 导出的是布局清单，不含 PNG 像素资源 |
| ZIP 导出 | 存在；「导出 ZIP（PNG + JSON）」 | `zipStore()`、`exportZip()` L560-L579 | Canvas PNG、CRC32、ZIP store、自定义 UTF-8 文件名 | 需用实际解压工具验证 ZIP 标准兼容与中文文件名 |
| 撤销 | 存在；快捷键 Ctrl/Cmd+Z、精修面板「撤销精修」 | `snapshot()`、`undo()` L252-L253；`undoMask` | history 快照、mask、seed 数据 | 最多 60 个快照；需检查所有变更路径是否都调用 snapshot |
| 重做 | 未发现 | 未发现 redo 函数或 UI 入口 | — | 不应在功能清单中声称支持重做 |
| 持久化 / 自动保存 | 未发现 | 未发现 localStorage、IndexedDB、sessionStorage | — | README 明确写无工程自动保存；刷新行为需按无持久化预期验证 |
| 快捷键 / 视图控制 | 存在；滚轮、空格/中键平移、Delete、Ctrl/Cmd+Z、缩放按钮 | window keydown/keyup、wheel、Canvas handlers | DOM 事件 | 主 Canvas pointercancel/lostpointercapture 清理不完整，需重点测试 |

## 迁移注意事项（从实际源码观察）

1. 主状态以闭包变量 `img`、`sprites`、`selected`、多个模式布尔值、`drag`、`history` 为中心；这不是 V10 的领域模型。
2. `sprites` 对象混合裁切几何、mask、名称分类、场景布局、变换、分组和 UI 语义；V10 应按冻结规格拆分领域对象。
3. V9 场景绘制位置使用 `sceneX ?? x`、`sceneY ?? y`；`anchor` 是原图坐标参考点，不应直接解释为 Animation Pivot。
4. V9 没有完整持久化项目文件；PNG / Manifest ZIP 不能被假设包含原始整图或未导出的内存 mask。
5. 源码存在 `pointercancel` 的场景工作台局部处理，但主 Canvas 未发现对应取消处理，也未发现 `lostpointercapture` 处理。
6. V9 使用 OpenCV CDN；其他主要流程以浏览器 Canvas 和原生 JavaScript 实现。

## 验收状态

本清单是源码/UI 存在性盘点。所有功能的运行时结果均标记为「尚未执行」，详见 `V9-Regression-Checklist.md`。
