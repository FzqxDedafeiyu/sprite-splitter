# V10 Interaction Manager 与 Reactive Store 技术规格

> 文档版本：V1.1
> 文档状态：修订设计基线（Implementation Blueprint）
> 目标：从根本上解决 V9 多布尔交互模式冲突、指针生命周期不完整、数据更新后面板不同步的问题。
> 约束：真实交互会话与项目数据分离；业务数据修改必须通过 Command；Reactive Store 是项目数据与可观察应用状态的权威来源。

## 0. V1.1 修订记录

本版根据两份独立 Agent 审查报告修订，明确：
1. Interaction Manager 是真实 pointer / gesture runtime state 的唯一所有者；Store 的 InteractionSnapshot 仅供 UI 观察，不参与真实状态控制。
2. Command.undo 为必填；不可撤销的内部操作不进入项目 History。
3. 引入 CompositeCommand / TransactionCommand，保证批量操作一次提交、一次撤销、失败整体回滚。
4. Animation PlaybackState 与 Interaction Gesture 解耦；校准拖拽默认自动暂停播放，并按策略恢复。
5. 统一坐标空间命名为 spriteLocal、clipCanvas、sceneWorld、viewport。
6. SpriteAsset.contentVersion 作为像素 / 几何派生缓存失效版本。

## 1. 设计目标

Interaction Manager 负责「用户当前正在做什么」，Reactive Store 负责「项目当前是什么状态」及 UI 需要观察的应用状态。

两者必须分离：
- Interaction Manager 管理工具选择到手势执行的运行时状态、拖拽会话、指针捕获、临时手势、draft 和取消。
- Reactive Store 管理 Project 数据、UI 状态、只读 InteractionSnapshot 和可订阅派生状态。
- Command Bus 负责将用户意图转化为正式数据修改。
- History Manager 负责记录和撤销已提交的修改。
- Animation System 独立管理 PlaybackState；播放不是一种 Pointer Gesture。

禁止把 addMode、lassoMode、refineMode 等独立布尔值继续作为交互主状态。

## 2. Interaction Manager 状态模型

### 2.1 顶层 Gesture 状态

建议使用互斥的 InteractionState：

```ts
type InteractionState =
  | { type: "idle" }
  | { type: "pan"; pointerId: number; start: Point; last: Point }
  | { type: "drag-sprite"; pointerId: number; spriteId: string; start: Point; draft: Point }
  | { type: "resize-sprite"; pointerId: number; spriteId: string; handle: ResizeHandle; start: Point }
  | { type: "draw-rect"; pointerId: number; start: Point; current: Point }
  | { type: "draw-polygon"; points: Point[]; pointerId?: number }
  | { type: "lasso"; pointerId: number; points: Point[] }
  | { type: "refine-brush"; pointerId: number; stroke: Point[] }
  | { type: "move-pivot"; pointerId: number; clipId: string; frameId: string; start: Point }
  | { type: "move-frame-offset"; pointerId: number; clipId: string; frameId: string; start: Point }
  | { type: "timeline-reorder"; pointerId: number; clipId: string; frameId: string; targetIndex: number };
```

实际状态可扩展，但同一时刻只能存在一个主指针 Gesture。辅助键修饰行为应作为当前状态的参数或临时覆盖，不得同时激活两个互斥工具。

重要：以上 InteractionState 是 Interaction Manager 内部运行时对象，不复制到 Store，也不由 UI 组件直接读取或修改。

### 2.2 工具选择与 Gesture 状态分离

工具选择（Select、Rect、Polygon、Brush、Pan 等）是用户偏好；当前 Gesture（Dragging、Drawing、Resizing 等）是一次操作会话。

- activeTool 存储在 UI / workspace state。
- activeGesture 由 Interaction Manager 独占管理。
- 工作区切换时取消当前 Gesture。
- Gesture 先产生 draft，再提交 Command；不得直接修改 Project。
- UI 通过 Store 的只读快照观察 gestureType / isInteracting，不得以修改快照的方式启动或结束 Gesture。

## 3. 状态转换协议

所有转换经由统一入口：
- activateTool(tool)
- beginGesture(eventContext)
- updateGesture(eventContext)
- commitGesture()
- cancelGesture(reason)
- handlePointerCaptureLost(pointerId)
- handleWindowBlur()

状态转换应具备：
1. 明确允许的来源状态。
2. 明确目标状态。
3. 进入时初始化临时数据。
4. 退出时提交或清理临时数据。
5. 取消时恢复到开始前状态。
6. 统一释放 pointer capture。
7. 发出可观测事件供 Store 更新只读快照、UI 更新。
8. 过期事件或非当前 pointerId 事件不得修改活动 Gesture。

建议转换图：

```text
Idle
 ├── pointerdown on sprite → DragSprite
 ├── pointerdown on handle → ResizeSprite
 ├── pointerdown on canvas + Rect tool → DrawRect
 ├── pointerdown + Pan gesture → Pan
 ├── pointerdown + Brush tool → RefineBrush
 └── animation pivot tool → MovePivot

Active Gesture
 ├── pointermove → update draft
 ├── pointerup → commit command → Idle
 ├── pointercancel → cancel → Idle
 ├── lostpointercapture → cancel safely → Idle
 ├── window blur → cancel safely → Idle
 └── workspace switch / modal open → cancel safely → Idle
```

## 4. 指针生命周期与误触防护

必须统一处理：
- pointerdown
- pointermove
- pointerup
- pointercancel
- lostpointercapture
- window blur
- canvas unmount / workspace switch

要求：
1. pointerdown 后按需 setPointerCapture。
2. 每个 Gesture 记录 pointerId，只响应对应指针。
3. pointerup 正常提交一次 Command。
4. pointercancel / lostpointercapture / blur 不得留下 drag、lasso、seedStroke 等残留状态。
5. 取消后清理辅助线、临时选区和 draft。
6. 对触控与鼠标统一使用 Pointer Events。
7. 画布坐标转换集中实现，不能每个工具自己计算 CSS 缩放和设备像素比。
8. 防止 pointerdown 穿透 UI 控件；属性面板、按钮、时间轴与画布操作区域有清晰事件边界。

### 4.1 误触规则
- 锁定的 Sprite 不可被拖动；应显示明确反馈。
- 隐藏 Sprite 不参与命中检测，除非用户开启隐藏对象选择。
- 拖拽起点落在控制柄上时，Resize 优先于 Move。
- 点击交互控件不应启动画布手势。
- 选区绘制工具激活时，不应意外移动已有 Sprite。
- 自动识别、导入、切换工作区前统一取消当前 Gesture。
- 快捷键在输入框、文本域、可编辑控件聚焦时不抢占。

## 5. Gesture Draft 与 Command 提交

连续拖动期间不应每个 pointermove 都写入正式 Project，也不应每次写入 History。

推荐流程：
1. beginGesture：记录起始数据和目标实体版本。
2. updateGesture：更新临时 draft，仅驱动画布预览。
3. commitGesture：将最终差异转换为一个 Command。
4. cancelGesture：丢弃 draft，恢复原始画面。

对于极高频笔刷，可使用专用 stroke buffer，完成后一次性提交 mask command；若笔刷需要实时持久化，则必须有节流策略和事务边界。

一次用户可识别的连续操作只形成一个历史项：
- 连续拖动：pointerup 时一次提交。
- 笔刷笔迹：stroke 完成时一次提交。
- 框选 / 套索：完成时按操作语义提交一次。
- 取消的 Gesture 不产生历史项。

## 6. Reactive Store 设计

### 6.1 Store 分区

建议至少区分：

```ts
interface RootState {
  project: ProjectState;
  ui: UIState;
  interaction: InteractionSnapshot; // 只读 UI 快照，不是 runtime state
  animationUI: AnimationUIState; // 播放状态等可观察 UI 状态
  derived: DerivedState;
}

interface ProjectState {
  document: ProjectDocument;
  revision: number;
}

interface UIState {
  activeWorkspace: WorkspaceId;
  activeToolByWorkspace: Record<string, string>;
  selectedSpriteIds: string[];
  selectedAnimationSetId?: string;
  selectedClipId?: string;
  selectedFrameId?: string;
  inspectorTab?: string;
  panels: Record<string, boolean>;
  viewportByWorkspace: Record<string, ViewportState>;
}

interface InteractionSnapshot {
  activeTool?: string;
  gestureType: string; // 例如 "idle" / "drag-sprite" / "move-pivot"
  isInteracting: boolean;
  // 不包含 pointerId、stroke buffer、draft 对象或真实状态机引用
}

interface AnimationUIState {
  playbackState: "stopped" | "playing" | "paused";
  // 其他播放 UI 快照；播放时钟由 Animation Playback Controller 管理
}

interface DerivedState {
  // 通过 selectors 计算，不作为独立可编辑数据源
}
```

项目数据与临时 UI 状态必须分离：
- 项目数据：Sprite、Scene Layout、Animation Set、Clip、Frame、Pivot Preset 等。
- UI 状态：当前工作区、选中项、面板开合、缩放和平移。
- Interaction runtime：真实 Gesture、pointerId、临时草稿和指针会话，只存在 Interaction Manager。
- InteractionSnapshot：只供 UI 观察的只读摘要。
- Animation UI：PlaybackState 等播放状态，不属于 Interaction Gesture。
- Derived 状态：列表分组、命中索引、质量检查摘要等派生值。

是否持久化 UI 状态由产品设置决定；Interaction runtime gesture 永不持久化。PlaybackState 与当前播放时钟也不写入项目文件。

### 6.2 读写规则
- 组件通过 selector 读取所需状态。
- 组件不得直接 mutate Project 对象。
- Project 更新通过 Command Bus。
- UI 状态可通过独立 UI actions 更新。
- InteractionSnapshot 只能由 Interaction Manager 事件适配器更新，UI 不可写入。
- PlaybackState 由 Animation Playback Controller 更新，不得伪装成 InteractionState。
- 派生数据通过 selector 或缓存服务计算。
- Store 更新必须产生明确 revision / change notification。
- 深层对象不得通过共享引用在组件间被修改。

### 6.3 Selector
建立稳定、可测试的 selectors，例如：
- selectSpriteById(id)
- selectSelectedSprites()
- selectVisibleSprites()
- selectAnimationClip(id)
- selectSelectedFrame()
- selectInspectorModel()
- selectSceneRenderModel()
- selectAnimationPreviewModel()
- selectInteractionSnapshot()
- selectPlaybackState()
- selectAnimationSetClips(setId)（由 AnimationClip.setId 派生）

selector 应尽量返回稳定引用或使用 memoization，避免无关状态变化触发全部工作区重绘。

## 7. Command Bus 与 History Manager

### 7.1 修改入口

项目数据修改必须走 Command：
- CreateSprite / UpdateSpriteGeometry / DeleteSprite
- UpdateSceneLayout / ReorderSceneLayers
- CreateAnimationSet / UpdateClip / ReorderFrames
- SetFramePivot / SetFrameOffset
- LockFrameCalibration
- CopyCalibrationToFrames
- RebasePivotTarget
- ApplyCalibrationResult
- ImportAgentData
- DeleteOverlapComponents

禁止组件直接写入 sprites、animationSets 或 sceneLayout。

### 7.2 Command 接口

所有进入项目 History 的 Command 必须提供完整撤销语义：

```ts
interface Command<TPayload = unknown> {
  id: string;
  type: string;
  payload: TPayload;
  label: string;
  affectedIds: string[];
  execute(context: CommandContext): CommandResult;
  undo(context: CommandContext): void;
}
```

- undo 是必填，不允许 optional。
- Command 执行前应准备可逆所需的旧值 / inverse patch。
- execute 失败不得留下部分数据变更。
- 确实无需撤销的内部维护动作（例如纯缓存预热）不是 Project Command，不进入 History。
- 不得通过给 Command 标注“不可撤销”来绕过业务数据撤销要求。

Command 可以采用纯 reducer + inverse patch，而不一定使用类；关键是有统一输入、输出、影响范围和撤销语义。

### 7.3 CompositeCommand / TransactionCommand

批量数据修改必须包装为单个 CompositeCommand / TransactionCommand：

```ts
interface CompositeCommand extends Command {
  commands: Command[];
  // execute: 按顺序执行子命令
  // undo: 按逆序撤销已成功执行的子命令
}
```

事务规则：
1. execute 按确定顺序执行子命令。
2. 任一子命令失败，立即按逆序 undo 已成功子命令，整体回滚。
3. 只有全部成功后，父事务才作为一个 History 项提交。
4. 父事务 undo 按逆序撤销全部子命令。
5. 父事务 redo 重新执行全部子命令。
6. 子命令不单独进入顶层 History，避免一次批量操作产生多条撤销记录。
7. 自动校准、AI 建议批量应用、批量属性修改、批量导入均遵守该规则。

### 7.4 History
- 支持 undo / redo。
- 每次成功提交形成历史项。
- 连续拖动形成一个历史项。
- 批量校准、Agent 导入、批量属性修改形成一个 CompositeCommand 历史项。
- 失败事务不进入历史。
- redo 栈在新命令提交后清空。
- 历史项记录 label、时间、affectedIds、数据 revision。
- 历史容量可配置；大图 mask 应评估快照内存，必要时使用差异记录或压缩快照。
- undo / redo 必须同时恢复业务数据与来源标记、锁定标记等关联字段。

### 7.5 事务 API
事务支持：
- beginTransaction(label)
- dispatch(command)
- commitTransaction()
- rollbackTransaction()

批量操作必须原子化：要么全部成功，要么恢复到执行前状态。事务提交前不对其他订阅者暴露半成品 Project 状态；若实现采用暂存状态，只有 commit 后才发布一次正式 revision。

## 8. Store 与渲染同步

各工作区从 Store 订阅所需状态：
- 主画布订阅 Sprite Render Model。
- 列表订阅 Sprite Summary。
- Inspector 订阅当前选中实体属性。
- Scene Workspace 订阅 Scene Render Model。
- Animation Workspace 订阅 Clip / Frame / Preview Model。
- Agent 面板订阅导入预览状态。
- 播放控制 UI 订阅 PlaybackState。
- 手势状态提示 UI 订阅只读 InteractionSnapshot。

不得依赖业务代码手工记住调用 draw()、refreshList()、syncInspectorProperties() 等多个刷新函数。可以保留局部渲染 API，但更新触发源应来自订阅状态变化。

高频画布拖动可用临时 draft 绘制，不应触发整个 Store 树和所有面板重渲染。真实 draft 保留在 Interaction Manager，渲染器可通过受控接口读取当前预览快照，但不得把它写回 Project Store。

## 9. 坐标与命中测试

统一使用以下坐标空间名称：
- viewport：屏幕视口坐标，含视口缩放和平移。
- sceneWorld：场景世界坐标。
- spriteLocal：Sprite 裁切图局部像素坐标。
- clipCanvas：动画 Clip 规范画布坐标。

建立统一坐标工具：
- clientToViewport()
- viewportToSceneWorld()
- sceneWorldToViewport()
- spriteLocalToViewport()
- viewportToSpriteLocal()
- clipCanvasToViewport()
- viewportToClipCanvas()
- getSpriteTransformedBounds()
- hitTestSprite()
- hitTestHandle()

禁止用含义不明的 canvas / world 作为跨模块坐标参数。所有工具使用同一变换矩阵和像素比例定义。

场景旋转、缩放、平移后的绘制与命中检测必须共享变换模型。不得出现绘制使用旋转矩阵而命中检测仍用未旋转矩形的情况。

命中测试应明确：
- Z 顺序 / 层级优先级。
- 锁定和隐藏行为。
- 透明像素是否参与命中。
- 控制柄命中半径与屏幕缩放关系。

## 10. 性能与稳定性

- Store selector 细粒度订阅。
- 时间轴和列表避免每次变化全量重建。
- 拖动预览使用局部 draft。
- Alpha / hit-test / thumbnail 等昂贵结果缓存，并按 SpriteAsset.contentVersion 失效。
- contentVersion 在像素来源、Alpha / mask 或裁切几何等影响缓存结果的修改后递增；纯 UI 变化不递增。
- 指针事件不触发不必要的持久化写入。
- 异步任务携带 Project revision / 目标实体 revision，过期结果不得覆盖新数据。
- 工作区卸载时取消异步任务与交互会话。
- 所有异常路径都保证 Gesture 清理。

## 11. 迁移策略

### Step 1：封装旧交互入口
先保留 V9 UI，将现有 pointer 逻辑集中到 Interaction Manager 适配层，不改变算法。

### Step 2：引入互斥状态
将 addMode / lassoMode / refineMode / drag 等映射为明确 tool 与 Gesture。设置统一 activateTool / cancelGesture。

### Step 3：统一指针生命周期
增加 pointercancel、lostpointercapture、blur、workspace switch 的清理与测试。

### Step 4：引入 Store
先迁移选中项、工作区、Sprite 列表和 Inspector，再迁移 Scene Layout，最后迁移动画数据。InteractionSnapshot 只读，真实 Gesture 不搬进 Store。

### Step 5：引入 Command / History
优先覆盖删除、几何修改、属性修改、场景操作、Agent 导入；动画工作区开放前必须覆盖帧和校准操作。Command.undo 必须存在，批量操作通过 CompositeCommand 提交。

### Step 6：接入 Animation Playback
PlaybackState 由 Animation Playback Controller 独立管理；Interaction Manager 通过明确事件请求 AUTO_PAUSE / RESUME，不将播放状态并入 Gesture 状态机。

### Step 7：删除旧状态入口
确认无模块依赖旧布尔值和直接 mutate 后，再删除兼容层。

## 12. 测试与验收

### 12.1 状态机测试
- 任何时刻最多一个主 Gesture。
- 非法转换被拒绝或安全取消。
- 工作区切换取消当前 Gesture。
- 自动识别不会遗留旧工具状态。
- pointercancel 后可立即开始下一次操作。
- Store InteractionSnapshot 不能反向改变 Interaction Manager 真实状态。
- PlaybackState 不占用 InteractionState 主 Gesture 状态。

### 12.2 指针测试
- pointerdown -> move -> up 正常提交一次。
- pointerdown -> move -> cancel 不修改正式数据。
- lostpointercapture 能清理。
- window blur 能清理。
- 多指针事件只处理当前 pointerId。
- 控件点击不触发画布手势。
- 锁定对象不移动。
- Resize 与 Move 命中优先级正确。

### 12.3 Store 测试
- 一次 Sprite 更新能同步画布、列表和 Inspector。
- 无关 UI 状态变化不触发全量重绘。
- selector 输出与 Project 数据一致。
- 组件无法直接修改 Project。
- 旧 revision 异步结果不能覆盖新状态。
- InteractionSnapshot 只反映状态，不包含真实 pointer session 或可变 draft。

### 12.4 History 测试
- 每次手势只生成一个历史项。
- cancel 不生成历史项。
- 所有进入 History 的 Command 均有 undo。
- 批量操作一次撤销全部恢复。
- CompositeCommand 中途失败时已执行子命令全部回滚，且不产生 History 项。
- undo 后 redo 恢复相同数据。
- 新操作提交后 redo 栈清空。
- undo / redo 恢复 calibrationSource、locked 等关联字段。

### 12.5 播放与交互协作测试
- 播放中拖动 Pivot 自动暂停。
- pointerup 后默认恢复此前 Playing 状态。
- 配置保持暂停时，pointerup 后不恢复。
- pointercancel / lostpointercapture / blur 不造成播放死锁。
- 切换 Clip / 工作区按规则停止或暂停播放时钟。

### 12.6 回归场景
1. 切换套索、矩形、精修后执行自动识别。
2. 自动识别后立即手工追加选区。
3. 拖动时切换工作区或窗口失焦。
4. 场景中旋转、缩放对象并点击边界。
5. 连续修改属性并检查所有面板。
6. 删除 / 排序 Sprite 后检查动画引用。
7. 动画 Pivot 拖动中取消指针。
8. 自动校准应用后整体撤销。
9. 播放过程中拖动 Pivot 并恢复播放。
10. CompositeCommand 子命令失败后验证完全回滚。

## 13. 完成标准

- 交互 Gesture 互斥且状态转换可追踪。
- Interaction Manager 独占真实 Pointer Session / Gesture。
- Store 只暴露只读 InteractionSnapshot。
- 所有指针异常路径能恢复。
- 所有业务数据修改经 Command。
- 所有进入 History 的 Command 都可撤销。
- 批量事务原子执行、一次撤销。
- Store 成为 Project 数据的唯一权威来源。
- Canvas、列表、Inspector、Scene、Animation 订阅同步。
- 高频操作不会导致全界面无意义重绘。
- 撤销 / 重做覆盖所有正式数据修改。
- 动画工作区不再建立独立的交互状态管理机制；PlaybackState 与 Gesture 保持解耦。
