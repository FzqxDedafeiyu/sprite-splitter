# V10 Animation System 技术规格

> 文档状态：设计基线（Implementation Blueprint）
> 范围：动作组、动画帧、枢轴预设、自动校准、预览、质量检查和导出。
> 关键决策：角色与物体共用动画系统；组级与单帧级双向校准；自动校准支持预览和自动应用；导出支持 PNG 序列 + JSON 与 Sprite Sheet。

## 1. 目标与基本原则

Animation System 让切割后的 Sprite Asset 可以被组装成可预览、可校准、可导出的动画。

必须支持：
- 角色动作组和物体动作组。
- 一个 Sprite 被多个动画帧引用。
- 动作类型驱动枢轴默认建议。
- 组级与单帧级双向校准。
- 自动校准预览与自动应用。
- 手工校准保护。
- 帧顺序、帧时长、FPS、循环。
- 固定参考点播放、逐帧、洋葱皮。
- PNG 序列 + JSON Manifest、Sprite Sheet 两种导出路径。

核心原则：
1. Sprite 原始像素和裁切几何不可被动画校准修改。
2. Scene Anchor 与 Animation Pivot 完全分离。
3. 组级 Pivot 和每帧局部 Pivot 必须采用明确坐标语义。
4. 预览、QA、导出共用同一套几何计算。
5. 自动结果必须可预览、可追溯、可撤销。
6. 不把 AI 语义识别作为基础自动校准的必要条件。

## 2. 核心术语与坐标空间

### 2.1 Sprite Local Space
单个 Sprite 裁切图像左上角为 (0,0)，单位为源像素。Sprite 的宽高为 sourceWidth / sourceHeight。

### 2.2 Clip Canvas Space
一个 Animation Clip 的规范画布坐标系，原点位于画布左上角。所有帧最终都在这个坐标系中合成。Clip 具有 canvas.width / canvas.height。

### 2.3 Frame Pivot Local
每帧在 Sprite Local Space 中的枢轴坐标，记为 Pᵢ。它描述「这个 Sprite 上哪个像素点对应动作语义锚点」，例如脚底中心、骨盆或物体铰链。

### 2.4 Clip Pivot Target
动作组在 Clip Canvas Space 中的统一目标位置，记为 T。播放时，各帧的 Frame Pivot Local 都映射到 T。预览视图可以把 T 固定在视口的参考位置。

### 2.5 Frame Offset
每帧相对于组级对齐结果的微调量 Oᵢ = (offsetX, offsetY)，单位为像素。它用于修正算法残差或有意的动作偏移，不等同于 Pivot。

### 2.6 Scene Anchor
场景布局系统中的世界空间摆放参考点。它不参与 Animation Clip 的帧对齐计算，也不与 T / Pᵢ / Oᵢ 共用字段。

### 2.7 渲染位置公式

设：
- Sprite 图像尺寸为 Wᵢ × Hᵢ。
- 当前帧局部枢轴为 Pᵢ = (pᵢx, pᵢy)。
- Clip 目标枢轴为 T = (tx, ty)。
- 帧偏移为 Oᵢ = (ox, oy)。

则 Sprite 在 Clip Canvas Space 的左上角位置为：

`drawX = tx - pᵢx + ox`
`drawY = ty - pᵢy + oy`

Sprite 像素坐标 (u,v) 对应画布位置为：
`(drawX + u, drawY + v)`

如果用户拖动某帧图像而非 Pivot，交互层应把拖动量写入 Oᵢ；如果用户拖动 Pivot 标记，则修改 Pᵢ。两种操作在 UI 上必须有不同工具状态，不能混淆。

Clip Pivot Target 是规范画布中的固定对齐目标；组级调整应通过明确命令修改目标或批量重算帧 Pᵢ / Oᵢ。执行坐标变换时必须保持渲染结果连续，不能因切换组级 / 单帧级模式导致整组突然跳位。

## 3. 领域模型

建议 TypeScript 类型如下，具体实现可扩展，但不得改变字段语义：

```ts
type AssetType = "character" | "object";

type PivotPresetType =
  | "foot"
  | "body"
  | "action"
  | "center"
  | "bottom"
  | "hinge"
  | "custom";

type CalibrationSource =
  | "default"
  | "geometry_auto"
  | "manual"
  | "ai_suggested"
  | "imported";

type CalibrationMode = "preview" | "apply";

interface Point {
  x: number;
  y: number;
}

interface AnimationSet {
  id: string;
  name: string;
  assetType: AssetType;
  spriteIds: string[];
  clipIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface AnimationClip {
  id: string;
  setId: string;
  name: string;
  actionType: string;
  fps: number;
  loop: boolean;
  canvas: { width: number; height: number };
  pivotPresetId: string;
  pivotTarget: Point;
  frames: AnimationFrame[];
  metadata?: Record<string, unknown>;
}

interface AnimationFrame {
  id: string;
  spriteId: string;
  duration: number;
  alignment: {
    pivotLocal: Point;
    offset: Point;
    pivotSource: CalibrationSource;
    offsetSource: CalibrationSource;
    confidence?: number;
    locked?: boolean;
  };
  metadata?: Record<string, unknown>;
}

interface PivotPreset {
  id: string;
  name: string;
  assetType: AssetType | "both";
  actionTypes: string[];
  strategy:
    | "bbox_center"
    | "alpha_centroid"
    | "bottom_center"
    | "bottom_contact"
    | "semantic_point"
    | "custom";
  normalizedPoint?: Point;
  description?: string;
}
```

说明：
- AnimationSet 表示一个角色或物体的动画资源集合。
- AnimationClip 表示一个动作，如 Idle、Walk、Jump、Open、Spin。
- AnimationFrame 表示某个 Sprite 在该动作中的一次使用，不复制 Sprite 像素。
- 同一个 Sprite 可以被多个 Frame 引用。
- Frame ID 与 Sprite ID 是不同身份。
- Clip 的帧顺序由 frames 数组顺序表达，但不改变 Sprite 列表顺序。
- duration 是相对帧时长倍率；实际播放时长 = duration / fps 秒。若未来需要毫秒级时长，可通过 schema 版本升级，不可在同一字段混用单位。

## 4. Pivot Preset System

### 4.1 默认映射

| 资产类型 | 动作类型 | 默认预设 | 说明 |
|---|---|---|---|
| character | idle / walk / run | foot | 地面动作默认脚底中心 |
| character | jump / fall / fly | body | 默认骨盆或身体根节点 |
| character | attack / cast | action | 身体根节点、手部或道具握持点 |
| character | spin | center | 几何中心或自定义旋转点 |
| object | spin / rotate | center | 旋转中心 |
| object | open / close | hinge | 铰链或转轴 |
| object | idle | bottom / center | 根据摆放方式选择 |
| both | unknown | custom | 需要用户确认 |

动作类型映射是建议，不是限制。用户可随时切换预设。

### 4.2 几何候选策略
- bbox_center：Alpha 有效像素包围盒中心。
- alpha_centroid：Alpha 加权质心。
- bottom_center：包围盒底边中心。
- bottom_contact：分析底部连续接触像素区，取接触区中心。
- semantic_point：外部 AI / Agent 建议的语义点，必须确认。
- custom：用户手工点选。

几何算法不能声称能从像素轮廓可靠识别骨盆、手部握持点或铰链语义。语义点必须来自用户指定或 AI 建议。

### 4.3 项目级预设
用户可以创建、编辑、复制、删除自定义 Pivot Preset。删除被引用的预设时必须提示并要求替换，不得留下悬空引用。

## 5. 组级与单帧级双向校准

### 5.1 组级校准
用户选择动作类型与 Pivot Preset，系统对每帧计算 pivotLocal 候选，再将每帧映射到同一 Clip Pivot Target。系统可计算初始 offset，使自动结果在视觉上尽可能稳定。

组级操作：
- 选择 / 更改预设。
- 设置 Clip Pivot Target。
- 重新计算整组候选。
- 应用当前帧作为组级参考。
- 批量重算未锁定帧。

### 5.2 单帧校准
用户可单独修改当前帧：
- 拖动 Pivot：修改该帧 pivotLocal。
- 拖动图像：修改 offset。
- 输入 X/Y。
- 锁定当前帧校准。
- 重置当前帧到组级规则。
- 复制校准到指定帧或相邻帧。

### 5.3 双向切换语义
必须提供：
- 以当前帧为基准，重新计算整个动作组。
- 将组级预设应用到未手工锁定的帧。
- 仅重算自动生成结果。
- 保留手工结果，仅更新组级设置。
- 强制覆盖全部帧（明确二次确认）。

切换组级参数时，必须通过转换命令保证渲染位置连续。不能直接把 frame offset 清零或简单覆盖 pivotLocal。

### 5.4 来源与保护策略
来源：
- default：初始默认。
- geometry_auto：几何算法生成。
- manual：用户手工修改。
- ai_suggested：AI 候选，尚未确认时不得成为生效数据。
- imported：从外部项目导入。

默认覆盖规则：
- default 可覆盖。
- geometry_auto 可重新计算。
- manual 默认锁定保护。
- imported 默认保护。
- ai_suggested 仅在用户确认后应用，并转为 manual 或 accepted suggestion 状态。

自动应用前展示受影响帧数量、手工锁定帧数量和低置信度帧数量。

## 6. 自动校准引擎

### 6.1 输入
- AnimationClip 与对应 Sprite 像素 / Alpha 信息。
- PivotPreset。
- 校准模式 preview / apply。
- 覆盖策略。
- 用户锁定帧集合。

### 6.2 输出
CalibrationResult：
- clipId。
- 建议的 pivotLocal。
- 建议 offset。
- 每帧 confidence。
- 每帧异常说明。
- 将被更新 / 跳过 / 保护的帧列表。
- 算法版本与参数摘要。

### 6.3 预览模式
- 纯计算，不修改正式项目状态。
- 展示校准前后叠加、固定 Pivot 播放和偏移数值。
- 用户可接受全部、接受选中帧、继续手工修正或放弃。
- 预览结果不得进入正式导出，除非明确应用。

### 6.4 自动应用模式
- 将 CalibrationResult 转换为一个批量 Command / Transaction。
- 遵守来源保护策略。
- 一次提交，一次撤销。
- 记录算法版本、时间、参数、修改帧和跳过帧。
- 应用失败时整批回滚。

### 6.5 置信度
建议分级：
- 高：Alpha 边界完整，候选点清晰，组内结构可比。
- 中：姿态变化明显或接触区不完整。
- 低：遮挡、透明边界异常、候选点不稳定或语义无法判断。

置信度是算法对自身结果的估计，不是动作正确性的保证。低置信度应提示人工确认。

## 7. 预览与播放

### 7.1 必备功能
- 播放 / 暂停。
- 首帧 / 末帧 / 上一帧 / 下一帧。
- 当前帧编号。
- FPS 调整。
- Loop 开关。
- 单帧停留。
- 固定参考点播放。
- 透明背景、棋盘格、纯色背景。
- 1x / 2x / 4x / 8x 像素缩放。
- 洋葱皮前后帧。
- 当前帧与上一帧并排或叠加比较。

### 7.2 播放时钟
播放调度不得依赖每次渲染都递增一帧的简单计数。应使用累计时间和帧 duration 计算当前帧，避免浏览器掉帧后动画速度漂移。

暂停、切换 Clip、切换工作区、页面失焦时必须明确处理播放状态。播放状态属于临时 UI 状态，不写入项目文件；FPS、loop 和帧时长属于项目数据。

### 7.3 统一渲染
预览、洋葱皮、质量检查截图和导出必须调用同一套 frame layout / render transform 函数，禁止各自重复实现坐标计算。

## 8. 动画质量检查

检查分级：
- error：资源缺失、非法坐标、无效帧引用、导出无法完成。
- warning：Pivot 超出合理范围、偏移突变、尺寸异常、循环衔接可能跳变。
- info：重复帧、长时间停留、动作类型与预设不匹配等提示。

检查项目：
1. spriteId 引用存在。
2. Frame ID 唯一。
3. duration > 0，fps 在允许范围内。
4. pivotLocal 与 canvas 尺寸是否异常。
5. 单帧 offset 是否明显偏离组内分布。
6. 帧尺寸变化是否可能造成视觉跳动。
7. Loop 首尾边界是否存在明显位移（只作启发式提示）。
8. 是否有空帧、全透明帧或重复帧。
9. 导出坐标、图集尺寸、文件引用是否完整。

检查必须考虑动作语义：Jump 中脚底高度变化、Open 中边界变化、Attack 中武器伸展都可能是合理动作，不应仅凭几何差异判错。

每条问题应带 clipId、frameId、规则 ID、严重级别和可执行定位动作。

## 9. 导出协议

### 9.1 PNG Sequence + JSON Manifest
输出每个 Frame 对应的 PNG，以及描述帧序、帧时长、枢轴、偏移、画布、FPS、Loop 的 Manifest。

建议目录：
```text
export/
├── manifest.json
├── character/
│   ├── idle/
│   │   ├── frame_000.png
│   │   └── frame_001.png
│   └── walk/
│       ├── frame_000.png
│       └── frame_001.png
└── objects/
```

Manifest 必须包含 schemaVersion、资源 ID、Clip ID、帧 ID、图像路径、画布尺寸、pivotTarget、frame pivotLocal、offset、duration、fps、loop。坐标单位明确为像素；帧序号从 0 开始。

### 9.2 Sprite Sheet
Atlas Packer 支持：
- 每个动作独立图集。
- 多个动作合并图集。
- 最大宽高。
- Padding / Extrusion。
- 多图集分页。
- 保留原始画布或透明边界 Trim。
- 像素素材默认禁止旋转图块，可由用户显式开启。

每个图集帧元数据至少包含：
- atlas image path。
- frame rect。
- source size。
- sprite source size。
- trim offset。
- pivotLocal / pivotTarget。
- frame offset。
- duration。
- clipId / frameId。

Trim 后必须保留原始偏移，保证重建结果与未 Trim 的预览一致。Atlas 打包不能改变动画帧的语义位置。

### 9.3 引擎适配器
内部通用 Manifest 是唯一权威数据格式。Godot 等适配器读取通用 Manifest 并转换，不在核心 AnimationClip 中混入引擎专属字段。

### 9.4 导出前检查
- 所有 spriteId 可解析。
- 所有 PNG 可生成。
- 帧坐标合法。
- Atlas 尺寸符合配置。
- Manifest schema 合法。
- 导出结果可重新解析。
- 预览与导出抽样渲染一致。

## 10. 持久化与版本兼容

- AnimationSet / Clip / Frame 纳入 Project schema。
- 生成的校准结果必须持久化。
- 播放时当前帧、临时选区、鼠标 hover 不持久化。
- 删除 Sprite 前检查动画引用；提供删除引用帧、替换 Sprite 或取消操作。
- 删除动作组不应删除其引用的原始 Sprite。
- 导入未知 Manifest 字段时保留扩展字段。

## 11. 命令与历史记录

至少实现：
- CreateAnimationSet
- RenameAnimationSet
- CreateClip
- ReorderFrames
- AddFrame / RemoveFrame / DuplicateFrame
- UpdateClipSettings
- UpdatePivotPreset
- SetFramePivot
- SetFrameOffset
- ApplyCalibrationResult
- ResetFrameCalibration
- ApplyFrameAsGroupReference

拖动时间轴排序和连续画布拖动应在交互结束时形成单一事务。自动应用校准必须形成一个批量事务。

## 12. 性能要求

- 播放时不重复计算 Alpha 连通域。
- Alpha 分析结果按 Sprite 内容版本缓存。
- 时间轴缩略图按需生成并缓存。
- 播放过程中只更新必要的 Canvas 区域或帧，不重建整个时间轴 DOM。
- 大批量校准可异步计算，但必须提供取消和结果过期校验。
- 异步结果应用前确认目标 Clip 仍存在且版本未变化。

## 13. 验收测试

使用至少五组真实素材：
1. 角色 Idle。
2. 角色 Walk。
3. 角色 Jump。
4. 物体 Open / Close。
5. 物体 Spin。

必须通过：
- 同一个 Sprite 可被多个 Clip 引用。
- 组级校准后各帧 Pivot 对齐。
- 单帧偏移只影响当前 Frame。
- 单帧 Pivot 覆盖可撤销。
- 以当前帧为标准重算组级结果。
- 自动预览不改变项目数据。
- 自动应用遵守手工保护并可一次撤销。
- 播放、逐帧、Loop、FPS 与帧时长一致。
- PNG 序列 + JSON 可重新导入并复现位置。
- Sprite Sheet Trim / 非 Trim 两种方式均可复现相同画面。
- 导出预览与工作区预览一致。
