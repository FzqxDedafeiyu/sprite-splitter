# V10 Animation System 技术规格

> 文档版本：V1.5
> 文档状态：冻结设计基线（Frozen Implementation Baseline）
> 范围：动作组、动画帧、枢轴预设、自动校准、预览、质量检查和导出。
> 关键决策：角色与物体共用动画系统；组级与单帧级双向校准；自动校准支持预览和自动应用；导出支持 PNG 序列 + JSON 与 Sprite Sheet。

## 0. V1.5 修订记录

本版在 V1.4 基础上将 Source Trim 与 Atlas Trim 的字段、坐标空间和所属层级彻底分离；明确 pivotLocal 始终是 SpriteAsset 当前 PNG 的 spriteLocal，Atlas 裁切 Pivot 使用独立 pivotAtlasLocal；补充 AnimationSet / PivotPreset revision，并统一资源哈希与并发契约。

V1.5 冻结决策：
- sourceTrimOrigin / Rᵢ 属于 Sprite 来源裁切层，坐标为 sourceLocal；它由 sourceRect.origin 派生，用于 sourceLocal → spriteLocal 转换。
- atlasTrimOffset 属于 Atlas Pack 导出层，坐标为 spriteLocal；它是 Atlas 裁切矩形在完整 Sprite PNG 中的左上角偏移，不参与 sourceLocal 转换。
- 内部 AnimationFrame.pivotLocal 永远是当前 SpriteAsset PNG 的 spriteLocal。Atlas 裁切后若目标引擎需要裁切图局部枢轴，另行输出 pivotAtlasLocal = pivotLocal - atlasTrimOffset。
- Atlas 图像是不可变导出资源，必须输出 SHA-256 contentHash 与 byteLength；重建产生新哈希，不原地覆盖既有导出资源。
- AnimationSet / PivotPreset 具有独立 revision；具体递增与 expected 来源遵循总体架构 Revision Matrix 和 Interaction / Store 冲突契约。

V1.4 关键决策：
- Source Local 表示未裁切源画布坐标；Sprite Local 表示当前 Sprite PNG 的实际像素坐标。若 sourceLocal 裁切原点为 Rᵢ，则 Pᵢ = Qᵢ - Rᵢ；Pᵢ 一旦转换为 spriteLocal，渲染公式不得再次减去 Trim。
- PivotPreset 几何候选默认直接从当前 Sprite PNG 的 Alpha 数据计算，输出 spriteLocal；只有来源明确提供 sourceLocal 坐标时才执行一次 sourceLocal → spriteLocal 转换。
- Atlas Pack Trim 与 SpriteAsset 本身的裁切是不同层级；Atlas Trim 只影响图集存储与重建，不改变动画领域的 Pᵢ / T / Oᵢ。
- 自动校准默认跳过 calibrationSource=manual / imported 的帧；只有显式包含受保护帧并二次确认，才允许覆盖。
- 自动计算结果与 Command 提交均校验 Project、Clip、目标 Frame 与资源 revision；冲突必须拒绝，不得静默覆盖。
- V9 的 scene anchor 是场景标注，不是动画枢轴；不得从 `anchor - sourceRect.origin` 直接推导 animation pivotLocal。
- V9 的 `spatial-scene-layout/v2` 不包含 AnimationSet / Clip / Frame 序列定义；仅凭场景 Manifest 不得自动生成动画组或动画帧。
- 若用户或独立 Agent 明确提供了动作组、帧顺序和动作语义，可建立待确认的 AnimationSet / Clip；来源数据未提供可靠 pivot / offset 时，使用几何候选并将 offset 初始化为 (0,0)。
- 按唯一公式 Dᵢ = T - Pᵢ + Oᵢ，组级 Pivot 对齐由 T - Pᵢ 自动完成；Offset 只表达额外的视觉修正，不能用 Pᵢ - T 代替。
- V9 场景 Sprite 的 position / Scene Anchor 迁移规则以总体架构 §9.4 为准；动画坐标不引用 sceneWorld。

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
7. 所有导出字段使用 camelCase；Sprite 外键统一为 spriteId。

## 2. 核心术语与坐标空间

### 2.1 Source Local（sourceLocal）
未裁切 SourceImage 原始画布坐标，左上角为 (0,0)，单位为源像素。若同一项目存在多张 SourceImage，sourceLocal 坐标必须同时关联 sourceImageId，不可跨图像直接比较。

### 2.2 Sprite Local（spriteLocal）
当前 Sprite PNG 实际像素画布的局部坐标，左上角为 (0,0)。AnimationFrame.alignment.pivotLocal、Sprite 多边形 points 与 Mask 均以此空间为基准。Sprite 宽高等于当前 PNG 的实际像素宽高。

### 2.3 Clip Canvas（clipCanvas）
一个 Animation Clip 的规范画布坐标系，原点位于画布左上角。所有帧最终都在这个坐标系中合成。Clip 具有 canvas.width / canvas.height；该字段表示 clipCanvas 尺寸。

### 2.4 Source Trim Origin（sourceTrimOrigin / Rᵢ）
Source Trim Origin 属于 Sprite 来源裁切层。它表示当前 SpriteAsset PNG 左上角在原始 SourceImage 的 sourceLocal 中的位置，坐标空间为 sourceLocal。若 Sprite 是从 sourceLocal 矩形 (x,y,width,height) 裁切而来，则 sourceTrimOriginᵢ = Rᵢ = (x,y)，由 SpriteAsset.sourceRect.origin 派生，不重复存储为另一份可变字段。来源未知时 Rᵢ 未知，禁止猜测。

Rᵢ 只用于 sourceLocal → spriteLocal：Pᵢ = Qᵢ − sourceTrimOriginᵢ。它不描述 Atlas 图集内部裁切。

### 2.5 Source Pivot（Qᵢ）与 Frame Pivot Local（Pᵢ）
Qᵢ 是明确以 sourceLocal 表达的枢轴点；Pᵢ 是同一枢轴点转换到当前 Sprite PNG 后的 spriteLocal 坐标。转换关系仅执行一次：

```text
Pᵢ = Qᵢ - sourceTrimOriginᵢ
Qᵢ = Pᵢ + sourceTrimOriginᵢ
```

若输入本身已提供 spriteLocal 的 Pᵢ，则直接使用，不得再减 Rᵢ。若裁切后 Qᵢ 落在当前 Sprite PNG 范围之外，该点不能作为当前 Sprite 的有效 Pivot；必须报告超界并要求确认，不得 clamp 后伪装为原值。

### 2.6 Clip Pivot Target（T）
动作组在 clipCanvas 中的统一目标位置。播放时，各帧的 Frame Pivot Local 映射到 T。预览视图可以把 T 固定在 viewport 的参考位置。

### 2.7 Frame Offset（Oᵢ）
每帧相对于组级对齐结果的微调向量，单位为像素，表达在 clipCanvas 坐标空间。它是 Pivot 对齐完成后的额外平移修正量，不是 Sprite 几何中心偏移，也不是以统一画布中心为原点的绝对坐标。

### 2.8 Scene Anchor
场景布局系统中的 sceneWorld 空间参考标记。V9 Anchor 不参与 Sprite 绘制定位，也不代表角色脚底、骨盆、物体铰链等动画语义点。它不参与 Animation Clip 的帧对齐计算，也不与 T / Pᵢ / Oᵢ 共用字段。

### 2.9 唯一渲染位置公式

设当前帧 pivotLocal 为 Pᵢ=(pᵢx,pᵢy)，Clip 目标枢轴为 T=(tx,ty)，Frame Offset 为 Oᵢ=(ox,oy)，则 Sprite 在 clipCanvas 中的左上角位置 Dᵢ 为：

```text
Dᵢ = T - Pᵢ + Oᵢ
drawX = tx - pᵢx + ox
drawY = ty - pᵢy + oy
```

Sprite 像素坐标 (u,v) 对应 clipCanvas 位置 (drawX+u, drawY+v)。

**Trim 只负责坐标转换，不在渲染公式中重复补偿。** 若来源 Pivot 是 sourceLocal，先计算 Pᵢ=Qᵢ-sourceTrimOriginᵢ，再代入 Dᵢ=T-Pᵢ+Oᵢ；若 Pᵢ 已经是 spriteLocal，直接代入公式。Offset 只表达额外的用户 / 来源修正；无额外修正时 Oᵢ=(0,0)。

该公式已经将 Sprite 局部枢轴换算为图像左上角位置。不得再根据 Wᵢ/Hᵢ 自动追加半宽、半高或几何中心修正。也不得在 Pᵢ 转换时减过 Rᵢ 后，又在 Dᵢ 计算或 Oᵢ 中重复减 / 加同一 Trim。

### 2.10 Atlas Pack Trim（独立于 Source Trim）
Atlas Pack Trim 属于导出图集层，只为减少图集透明像素，不改变 SpriteAsset 本身的像素画布和动画语义。

| 字段 | 坐标空间 | 所属层级 | 精确定义 |
|---|---|---|---|
| sourceSize | spriteLocal 画布尺寸 | Atlas 导出帧元数据 | 完整、未经过 Atlas Pack Trim 的 SpriteAsset PNG 宽高 |
| spriteSourceSize | spriteLocal | Atlas 导出帧元数据 | Atlas 实际存储的裁切矩形在完整 SpriteAsset PNG 中的位置与尺寸 |
| atlasTrimOffset | spriteLocal 向量 | Atlas Pack | spriteSourceSize 的左上角 (x,y)，即 Atlas 裁切矩形相对完整 SpriteAsset PNG 原点的偏移 |
| frameRect | atlasImage 像素坐标 | Atlas Pack | 裁切像素在 Atlas 图像中的实际矩形；不是 Sprite 或 clipCanvas 坐标 |
| pivotLocal | spriteLocal | AnimationFrame 权威数据 | 当前 SpriteAsset PNG 中的 Pivot，Atlas Pack 不得改写 |
| pivotAtlasLocal | Atlas 裁切图局部坐标 | Atlas 导出适配字段 | 仅当目标引擎需要裁切图局部 Pivot 时输出，等于 pivotLocal - atlasTrimOffset |

规则：
- sourceTrimOrigin / Rᵢ 描述 SourceImage → SpriteAsset 的来源裁切；atlasTrimOffset 描述 SpriteAsset → Atlas 子矩形的导出裁切。二者不得互换、相加或写入同一个 trimOffset 字段。
- AnimationFrame.pivotLocal 始终以当前 SpriteAsset PNG 为基准，即 spriteLocal；不得称为“未 Trim 原始 SourceImage 坐标”。
- Atlas 裁切后如需重建完整 SpriteAsset PNG，将裁切图像放回 sourceSize 指定画布的 atlasTrimOffset 位置，再按 Dᵢ 合成。
- 不得把 Atlas frameRect.x / frameRect.y 当成 clipCanvas 位置或 sourceTrimOrigin。
- 所有权威 Pivot / Offset 在计算与存储阶段保留浮点精度；像素风预览取整只发生在最终 Canvas 绘制阶段，使用项目 renderSnap 策略。预览取整不得回写项目数据。
- 导出器必须声明输出像素对齐策略；同一策略下预览与导出应一致。

## 3. 领域模型

以下为建议 TypeScript 类型，字段语义为跨模块契约。实现可扩展，但不得改变坐标和身份语义。

```ts
type AssetType = "character" | "object";

type PivotPresetType =
  | "foot" | "body" | "action" | "center"
  | "bottom" | "hinge" | "custom";

type CalibrationSource =
  | "default"
  | "geometry_auto"
  | "manual"
  | "ai_suggested"
  | "accepted_ai"
  | "imported";

type CalibrationMode = "preview" | "apply";

interface Point {
  x: number;
  y: number;
}

interface AnimationSet {
  id: string;
  revision: number; // Set 自身名称、类型、成员变化时递增
  name: string;
  assetType: AssetType;
  spriteIds: string[];
  // clipIds 是派生索引，不持久化；通过 AnimationClip.setId 查询。
  createdAt: string;
  updatedAt: string;
}

interface AnimationClip {
  id: string;
  revision: number; // Clip 任一持久化字段变化时递增
  setId: string; // 所属 Set 的权威外键
  name: string;
  actionType: string;
  fps: number;
  loop: boolean;
  canvas: { width: number; height: number }; // clipCanvas 像素尺寸
  pivotPresetId: string;
  pivotTarget: Point; // clipCanvas
  frames: AnimationFrame[];
  metadata?: Record<string, unknown>;
}

interface AnimationFrame {
  id: string;
  revision: number; // 本 Frame 任一持久化字段变化时递增
  spriteId: string;
  duration: number; // 帧时长倍率；播放秒数 = duration / fps
  alignment: {
    pivotLocal: Point; // spriteLocal
    offset: Point; // clipCanvas 平移向量
    pivotSource: CalibrationSource;
    offsetSource: CalibrationSource;
    confidence?: number;
    locked?: boolean;
    algorithmVersion?: string;
    calibratedAt?: string;
    algorithmParameters?: Record<string, unknown>;
  };
  metadata?: Record<string, unknown>;
}

interface PivotPreset {
  id: string;
  revision: number; // 预设定义变化时递增
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
- duration 是相对帧时长倍率；实际播放时长 = duration / fps 秒。不得在同一字段混用毫秒与倍率。
- AnimationClip.setId 是权威关系；AnimationSet.clipIds 由 selector 从 Clip 集合派生，避免双向重复维护。
- 所有 JSON 字段使用 camelCase；禁止 sprite_id、texture_uuid 等并行别名，sprite 引用统一为 spriteId。

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
- 锁定 / 解锁当前帧校准。
- 重置当前帧到组级规则。
- 复制校准到指定帧或相邻帧。

### 5.3 双向切换语义
必须提供：
- 以当前帧为基准，重新计算整个动作组。
- 将组级预设应用到未手工锁定的帧。
- 仅重算自动生成结果。
- 保留手工结果，仅更新组级设置。
- 强制覆盖全部帧（明确二次确认）。

切换组级参数时，必须通过 RebasePivotTarget 命令保持所有帧最终 Dᵢ 连续。不得直接把 frame offset 清零或简单覆盖 pivotLocal。

### 5.4 来源与保护策略

来源：
- default：初始默认。
- geometry_auto：几何算法生成。
- manual：用户手工修改。
- ai_suggested：AI 候选，尚未确认时不得成为生效数据。
- accepted_ai：用户明确确认并应用的 AI 建议。
- imported：从外部项目导入。

默认覆盖规则：
- default 可覆盖。
- geometry_auto 可重新计算。
- manual 默认锁定保护。
- imported 默认保护。
- 自动校准默认跳过 manual / imported 帧；这项保护独立于普通“强制覆盖”选项。
- ai_suggested 仅为候选，不改变生效数据。
- 用户确认 AI 建议后，来源标记为 accepted_ai；用户后续直接手工调整该值时，来源改为 manual。

强制覆盖规则：
- 普通“强制覆盖”仍不得越过 manual / imported 保护。
- 只有用户额外勾选“包含手工 / 导入帧”并完成二次确认，才允许覆盖这些帧；实现参数应显式表达为 includeProtectedSources=true，不得仅依赖含义模糊的 force=true。
- 被跳过、被覆盖、被保护的帧都必须在结果摘要中分别列出。
- 锁定帧优先级高于自动覆盖策略；若要覆盖锁定帧，必须显式解除锁定并二次确认。

## 6. 自动校准引擎

### 6.1 输入
- AnimationClip 与对应 Sprite 像素 / Alpha 信息。
- PivotPreset。
- 校准模式 preview / apply。
- 覆盖策略。
- 用户锁定帧集合。
- 当前 Project revision、目标 Clip revision，以及本次将读取 / 修改的 Frame revision 快照。

### 6.2 输出
CalibrationResult：
- clipId。
- 建议的 pivotLocal。
- 建议 offset。
- 每帧 confidence。
- 每帧异常说明。
- 将被更新 / 跳过 / 保护的帧列表。
- algorithmVersion、计算时间与参数摘要。
- 计算时的目标 revision 快照：projectRevision、clipRevision、frameRevisions（frameId → revision），用于精确过期结果校验。

### 6.3 预览模式
- 纯计算，不修改正式项目状态。
- 展示校准前后叠加、固定 Pivot 播放和偏移数值。
- 用户可接受全部、接受选中帧、继续手工修正或放弃。
- 预览结果不得进入正式导出，除非明确应用。

### 6.4 自动应用模式
- 将 CalibrationResult 转换为一个 CompositeCommand / TransactionCommand。
- 遵守来源保护策略。
- 一次提交，一次撤销。
- 记录 algorithmVersion、时间、参数、修改帧和跳过帧。
- 应用失败时整批回滚。
- 执行前校验 Project / Clip / 目标 Frame revision 快照，并逐一校验本次将修改的 Frame revision 与计算快照一致；资源输入同时校验 resourceId、resource revision 与 contentHash；持久化阶段还必须执行 Project revision compare-and-swap。
- 无关 Frame 的修改不应使整组结果自动过期；被修改目标 Frame 的 revision 变化则对应结果过期。若 Project revision 因其他事务变化，先由持久化层拒绝旧快照提交；应用层可重新读取并验证受影响实体后重新生成 / 确认命令，不得直接 last-write-wins。
- Project revision 用于诊断和整体快照追踪，不单独作为唯一失效条件，避免无关项目编辑导致结果全部作废。
- 用户确认应用过期结果时，必须重新展示差异，并通过 Command 校验目标实体仍存在；不得静默覆盖新值。

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
- FPS 调整；FPS 属于项目数据，拖动滑块或连续键盘调整期间只更新 UI draft，pointerup / change commit / Enter / blur 时提交一个 UpdateClipFPS Command；取消编辑则丢弃 draft。
- 一次连续调整只产生一个 History 项，不得每个滑块刻度或 key-repeat 都生成独立撤销记录。
- Loop 开关。
- 单帧停留。
- 固定参考点播放。
- 透明背景、棋盘格、纯色背景。
- 1x / 2x / 4x / 8x 像素缩放。
- 洋葱皮前后帧。
- 当前帧与上一帧并排或叠加比较。

### 7.2 PlaybackState 与 Interaction Gesture
PlaybackState 是独立于 Interaction Manager 的动画播放维度：
```ts
type PlaybackState = "stopped" | "playing" | "paused";
```

- PlaybackState 不属于 InteractionState，不参与单一主 Gesture 互斥判断。
- 播放调度不得依赖每次渲染都递增一帧的简单计数；应使用累计时间和帧 duration 计算当前帧，避免浏览器掉帧后动画速度漂移。
- 播放中开始 Drag Pivot / Drag Offset 时，默认 AUTO_PAUSE，并记录此前 PlaybackState。
- pointerup 提交后，默认恢复此前 Playing 状态；用户可配置为保持暂停。
- pointercancel、lostpointercapture、window blur 必须先结束或取消 Gesture，再按恢复策略处理播放状态。
- 切换 Clip、切换工作区、页面失焦时必须明确处理播放时钟。
- 播放状态、当前帧、鼠标 hover 等临时状态不写入项目文件；FPS、loop 和帧时长属于项目数据。
- FPS 连续调整在编辑手势期间使用临时 draft，提交时通过单个可撤销 Command 写入 Clip，并递增 Clip.revision 与 ProjectDocument.revision。

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
4. pivotLocal 与 clipCanvas 尺寸是否异常。
5. 单帧 offset 是否明显偏离组内分布。
6. 帧尺寸变化是否可能造成视觉跳动。
7. Loop 首尾边界是否存在明显位移（只作启发式提示）。
8. 是否有空帧、全透明帧或重复帧。
9. 导出坐标、图集尺寸、文件引用是否完整。
10. Trim 元数据能否将裁切图像还原到原始 Sprite 画布。

检查必须考虑动作语义：Jump 中脚底高度变化、Open 中边界变化、Attack 中武器伸展都可能是合理动作，不应仅凭几何差异判错。

每条问题应带 clipId、frameId、规则 ID、严重级别和可执行定位动作。

## 9. 导出协议

### 9.1 PNG Sequence + JSON Manifest

V10 动画导出与 V9 场景导出分离。动画 Manifest 的协议标识固定为字符串：
```json
{
  "format": "sprite-anim-manifest/v1"
}
```
format 是协议标识，不是整数版本，不与 projectSchemaVersion 比较，也不替代 V9 的 spatial-scene-layout/v2。

建议 ZIP 目录：
```text
<project>_anim_<clip>.zip
├── anim/
│   └── manifest.json
└── frames/
    ├── frame_000.png
    └── frame_001.png
```

Manifest 示例：
```json
{
  "format": "sprite-anim-manifest/v1",
  "projectId": "project-uuid",
  "clipId": "clip-uuid",
  "clipName": "walk",
  "assetType": "character",
  "canvas": { "width": 64, "height": 64 },
  "pivotTarget": { "x": 32, "y": 52 },
  "fps": 8,
  "loop": true,
  "frames": [
    {
      "frameId": "frame-uuid-0",
      "spriteId": "sprite-uuid-0",
      "imagePath": "frames/frame_000.png",
      "duration": 1,
      "pivotLocal": { "x": 16, "y": 46 },
      "offset": { "x": 0, "y": 0 }
    }
  ]
}
```

规范：
- 所有字段使用 camelCase。
- Sprite 外键统一为 spriteId；禁止 sprite_id、texture_uuid 等混合命名。
- 帧序号从 0 开始；文件名 frame_000.png。
- 坐标单位为像素；pivotLocal 属于 spriteLocal，pivotTarget / offset 属于 clipCanvas。
- 对从 V9 迁移的 Sprite，Frame 可选携带 `legacySpriteId`（如 sprite_001），只用于关联冻结的 V9 场景 Manifest；权威外键仍为 UUID `spriteId`。
- Atlas Trim 元数据必须保留 sourceSize（完整 SpriteAsset PNG 宽高）、spriteSourceSize（Atlas 裁切矩形在 spriteLocal 中的 x/y/width/height）与 atlasTrimOffset（等于 spriteSourceSize 左上角的 spriteLocal 偏移）。
- pivotLocal 始终是当前 SpriteAsset PNG 的 spriteLocal。若引擎要求 Atlas 裁切图局部 Pivot，按 pivotAtlasLocal = pivotLocal - atlasTrimOffset 转换；不得覆盖或改写权威 pivotLocal。
- Manifest 必须包含 format、projectId、Clip ID、Frame ID、UUID spriteId、imagePath、画布尺寸、pivotTarget、frame pivotLocal、offset、duration、fps、loop。
- 对迁移素材可选导出 legacySpriteId，作为 V9 场景 Manifest 的关联键；不得用 legacySpriteId 替代 spriteId。
- Atlas Trim 模式下每帧必须包含 sourceSize、spriteSourceSize、atlasTrimOffset；非 Trim 模式可省略这些字段或显式标记 atlasTrimmed=false，具体结构在 Schema 校验器中固定。sourceTrimOrigin 不属于 Atlas 元数据；它只在来源坐标转换时使用。
- V10 动画 ZIP 使用独立文件命名和 anim/manifest.json 路径；V9 场景 ZIP 继续使用 sprites/NNN_名称.png + manifest.json，不互相覆盖。

### 9.2 Sprite Sheet

Atlas 导出资源采用不可变内容寻址描述：

```ts
interface AtlasImageResource {
  assetRef: string;        // 当前导出包内路径
  contentHash: string;     // sha256:<64 lowercase hex>，对完整 PNG 字节计算
  byteLength: number;
  mimeType: "image/png";
}

interface AtlasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface AtlasFrameExport {
  atlasImage: AtlasImageResource;
  frameRect: AtlasRect;    // atlasImage 像素坐标
  sourceSize: { width: number; height: number }; // 完整 SpriteAsset spriteLocal 画布尺寸
  spriteSourceSize: AtlasRect; // atlasTrimOffset 所在的 spriteLocal 裁切矩形
  atlasTrimOffset: Point;  // spriteLocal
  pivotLocal: Point;       // 权威 spriteLocal
  pivotAtlasLocal?: Point; // 裁切图局部坐标，仅适配器需要时输出
  pivotTarget: Point;      // clipCanvas
  frameOffset: Point;      // clipCanvas
  duration: number;
  clipId: string;
  frameId: string;
  spriteId: string;
}
```

Atlas 图像不使用可变 revision：一次导出生成一个 contentHash；重新打包即生成新的 hash 与输出路径，禁止覆盖仍被既有 Manifest 引用的字节。加载 / 导入时必须验证 byteLength 与 SHA-256 contentHash。

Atlas Packer 支持：
- 每个动作独立图集。
- 多个动作合并图集。
- 最大宽高。
- Padding / Extrusion。
- 多图集分页。
- 保留原始画布或透明边界 Trim。
- 像素素材默认禁止旋转图块，可由用户显式开启。

每个图集帧元数据至少包含：
- atlasImage：AtlasImageResource，包含 assetRef、contentHash（sha256）、byteLength、mimeType。该图像为不可变导出资源，每次重新打包生成新 contentHash / 输出路径，不使用可变 revision。
- frameRect。
- sourceSize。
- spriteSourceSize。
- atlasTrimOffset（spriteLocal）。
- pivotLocal / pivotTarget。
- frameOffset。
- duration。
- clipId / frameId / spriteId。

Trim 后必须保留原始偏移，保证重建结果与未 Trim 的预览一致。Atlas 打包不能改变动画帧的语义位置。Atlas rect 只用于定位图集像素，不可作为动画画布坐标。

### 9.3 引擎适配器
内部通用 Manifest 是动画导出的权威数据格式。Godot 等适配器读取通用 Manifest 并转换，不在核心 AnimationClip 中混入引擎专属字段。

### 9.4 导出前检查
- 所有 spriteId 可解析。
- 所有 PNG 可生成。
- 帧坐标合法。
- Atlas 尺寸符合配置。
- Manifest schema 合法，Frame 的 spriteId 必须引用存在的 Sprite UUID。
- legacySpriteId 仅作为兼容关联信息；若存在，必须能在 migrationMetadata.idMap 中找到对应 UUID。
- Atlas Trim 模式下 sourceSize / spriteSourceSize / atlasTrimOffset 三项齐全且互相一致；atlasImage.contentHash 与导出图像字节 SHA-256 一致。
- Trim 元数据完整。
- 预览与导出抽样渲染一致。

本版本不定义动画 Manifest 重新导入器，因此不把“可重新导入并复现位置”列为验收承诺。导出验收以 schema、引用、坐标与抽样渲染一致性为准。

## 10. 持久化与版本兼容

- AnimationSet / Clip / Frame 纳入 Project schema。
- 项目根版本使用 projectSchemaVersion: 10。
- 动画导出协议使用 format: sprite-anim-manifest/v1。
- V9 场景 Manifest 继续识别 format: spatial-scene-layout/v2。
- 生成的校准结果必须持久化。
- 播放时当前帧、临时选区、鼠标 hover 不持久化。
- 删除 Sprite 前检查动画引用；提供删除引用帧、替换 Sprite 或取消操作。
- 删除动作组不应删除其引用的原始 Sprite。
- 导入未知 Manifest 字段时保留扩展字段。

### 10.1 V9 动画迁移边界

V9 的 `spatial-scene-layout/v2` 是场景布局协议，不定义动画动作组、Clip、帧顺序、帧时长或动画枢轴。因此：
1. 仅导入 V9 场景 Manifest 时，只创建 SpriteAsset 与 SceneLayout，不创建 AnimationSet / AnimationClip / AnimationFrame。
2. 不得根据 Sprite 名称相似、文件相邻、数组顺序、groupName 或 sceneAnchor 自动推断动作组与帧序列。
3. V9 `anchor` 是 source-image 全局场景参考标记，不能作为 pivotLocal；不得直接执行 `pivotLocal = anchor - sourceRect.origin`。
4. 如用户明确指定某些 Sprite 构成动作组，系统可建立待校准 Clip；pivotLocal 由对应 PivotPreset 的几何算法生成候选，并标记 geometry_auto / default；offset 初始为 (0,0)。
5. 只有外部来源明确提供动画帧关系、帧顺序、帧时长、pivotLocal 与 offset 的坐标语义时，才允许作为 imported 校准数据写入。缺失字段不补造 confidence。
6. Agent 提供的动画分组建议必须先进入预览与确认流程；未经确认不得生成正式动画数据。

### 10.2 Offset 迁移算例

设组目标枢轴 T=(57,83)，第二帧 pivotLocal P₂=(51,81) 已经是当前裁切 PNG 的 spriteLocal，且来源没有额外帧偏移。则：
```text
D₂ = T - P₂ + O₂
   = (57,83) - (51,81) + (0,0)
   = (6,2)
```
此时第二帧的局部枢轴映射到 T，已经完成对齐。若再写入 O₂=(-6,-2)，则有效枢轴变为 (51,81)，偏离目标 T。因此，迁移报告中仅由两个 Pivot 坐标相减得到的 (-6,-2) 不能作为自动导入 Offset；除非它被明确证明是额外的 clipCanvas 视觉修正量。

**Trim 坐标辨析算例：** 若外部来源给出的枢轴 Q₂=(51,81) 明确属于 sourceLocal，且裁切原点 R₂=(6,2)，则先转换为 P₂=(45,79) spriteLocal，再计算 D₂=(57,83)-(45,79)=(12,4)。这与“P₂=(51,81) 已是 spriteLocal”的前一算例不是同一输入。不得仅凭数值相同的 `pivot` 字段猜测坐标空间；来源未声明时必须标记坐标语义未知并要求确认，不能自动减 Trim。

## 11. 命令与历史记录

至少实现以下命令：
- CreateAnimationSet
- RenameAnimationSet
- CreateClip
- ReorderFrames
- AddFrame / RemoveFrame / DuplicateFrame
- UpdateClipSettings
- UpdatePivotPreset
- SetFramePivot
- SetFrameOffset
- LockFrameCalibration
- CopyCalibrationToFrames
- RebasePivotTarget
- ApplyCalibrationResult
- ResetFrameCalibration
- ApplyFrameAsGroupReference

所有正式数据修改经 Command API。Command 的 undo 必须实现；所有批量自动校准、AI 建议应用、批量属性修改必须包装为单个 CompositeCommand / TransactionCommand，作为一个 History 项提交。拖动时间轴排序和连续画布拖动在交互结束时形成单一事务。

## 12. 性能要求

- 播放时不重复计算 Alpha 连通域。
- Alpha 分析结果按 SpriteAsset.contentVersion 缓存。
- contentVersion 在像素来源、Alpha / mask 或裁切几何等影响缓存内容的修改后递增。
- 时间轴缩略图按需生成并缓存。
- 播放过程中只更新必要的 Canvas 区域或帧，不重建整个时间轴 DOM。
- 大批量校准可异步计算，但必须提供取消和结果过期校验。
- 异步结果应用前确认目标 Clip、目标 Frame 与所读取 Sprite / Mask 资源的 revision / contentHash 快照仍匹配；Project CAS 冲突与实体 / 资源冲突的处理遵循《03-Interaction-Manager与Reactive-Store技术规格》。

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
- 不同 Sprite 宽高下，公式 Dᵢ = T - Pᵢ + Oᵢ 计算无额外中心补偿。
- Trim 测试覆盖 R=(0,0)、非零正偏移、负 / 超界输入、sourceLocal Pivot 转换一次、spriteLocal Pivot 不重复转换，以及 sourceRect 未知时阻断转换。
- 同一帧以 sourceLocal Q-R 与预先换算的 spriteLocal P 输入时，最终渲染位置完全一致。
- Source Trim 的 sourceTrimOrigin 与 Atlas Trim 的 atlasTrimOffset 使用不同坐标空间；改变其中一个不得改变另一个。
- Atlas 导出以 sourceSize / spriteSourceSize / atlasTrimOffset 重建完整 SpriteAsset PNG，结果与未 Trim 预览逐像素一致。
- pivotLocal 保持 spriteLocal；pivotAtlasLocal = pivotLocal - atlasTrimOffset，导出适配值不得回写权威 Frame。
- AtlasImageResource 的 byteLength 与 SHA-256 contentHash 必须和实际 PNG 字节一致；重新打包生成新 hash，不覆盖仍被引用的旧产物。
- Source Trim 的 sourceTrimOrigin 与 Atlas Trim 的 atlasTrimOffset 使用不同坐标空间；改变其中一个不得改变另一个。
- Atlas 导出以 sourceSize / spriteSourceSize / atlasTrimOffset 重建完整 SpriteAsset PNG，结果与未 Trim 预览逐像素一致。
- pivotLocal 保持 spriteLocal；pivotAtlasLocal = pivotLocal - atlasTrimOffset，导出适配值不得回写权威 Frame。
- Trim 后 Pivot 超出当前 Sprite 范围时产生明确 QA 错误，不得静默 clamp。
- 自动校准默认跳过 manual / imported；显式包含受保护帧需二次确认并在结果摘要中列出覆盖对象。
- 目标 Frame revision 变化时拒绝旧校准结果；无关 Frame 变化不使目标帧结果无条件过期。
- V9 sceneAnchor 不被误读为 animationPivot。
- 仅有 V9 场景 Manifest 时不自动创建 AnimationSet / Clip / Frame。
- 无来源偏移时所有新导入帧 offset=(0,0)；不得将 Pᵢ-T 或 T-Pᵢ 重复写入 Offset。
- 单帧偏移只影响当前 Frame。
- 单帧 Pivot 覆盖可撤销。
- 以当前帧为标准重算组级结果，渲染位置连续。
- 自动预览不改变项目数据。
- 自动应用遵守手工保护并可一次撤销全部帧变更。
- AI 建议未确认前不改变正式数据；确认后来源为 accepted_ai。
- 强制覆盖手工 / 导入帧需要显式勾选并二次确认。
- 播放中拖动 Pivot 自动暂停，结束后按策略恢复；取消操作不会留下 Gesture 或播放死锁。
- 播放、逐帧、Loop、FPS 与帧时长一致。
- FPS 连续滑动一次提交一个 History 项，撤销后恢复原 FPS；无关帧修改不导致异步校准结果误判过期。
- PNG 序列 Manifest 使用 format 与 camelCase spriteId。
- Sprite Sheet Trim / 非 Trim 两种方式均可复现相同画面。
- 导出抽样渲染与工作区预览一致。
