# V10 Interaction Manager 与 Reactive Store 技术规格

> 文档状态：设计基线（Implementation Blueprint）
> 目标：从根本上解决 V9 多布尔交互模式冲突、指针生命周期不完整、数据更新后面板不同步的问题。
> 约束：交互状态与项目数据分离；业务数据修改必须通过 Command；Store 是唯一权威状态源。

## 1. 设计目标

Interaction Manager 负责「用户当前正在做什么」，Reactive Store 负责「项目当前是什么状态」。

两者必须分离：
- Interaction Manager 管理工具模式、拖拽会话、指针捕获、临时手势和取消。
- Reactive Store 管理 Project 数据、选中项、工作区状态及可订阅派生状态。
- Command Bus 负责将用户意图转化为正式数据修改。
- History Manager 负责记录和撤销已提交的修改。

禁止把 addMode、lassoMode、refineMode 等独立布尔值继续作为交互主状态。

## 2. Interaction Manager 状态模型

### 2.1 顶层状态

建议使用互斥的 Interaction State：

```ts
type InteractionState =
  | { type: "idle"; tool: "select" }
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

实际状态可扩展，但同一时刻只能存在一个主指针操作状态。辅助键修饰行为应作为当前状态的参数或临时覆盖，不得同时激活两个互斥工具。

### 2.2 工具选择与手势状态分离

工具选择（Select、Rect、Polygon、Brush、Pan 等）是用户偏好；当前手势（Dragging、Drawing、Resizing 等）是一次操作会话。

建议：
- activeTool 存储在 UI / workspace state。
- activeGesture 由 Interaction Manager 管理。
- 工作区切换时取消当前 gesture。
- 不允许 gesture 直接修改项目数据；先产生 draft，再提交 Command。

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
7. 发出可观测事件供 UI 更新。

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
2. 每个 gesture 记录 pointerId，只响应对应指针。
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
- 自动识别、导入、切换工作区前统一取消当前 gesture。
- 快捷键在输入框、文本域、可编辑控件聚焦时不抢占。

## 5. Gesture Draft 与 Command 提交

连续拖动期间不应每个 pointermove 都写入正式 Project，也不应每次写入 History。

推荐流程：
1. beginGesture：记录起始数据和目标实体版本。
2. updateGesture：更新临时 draft，仅驱动画布预览。
3. commitGesture：将最终差异转换为一个 Command。
4. cancelGesture：丢弃 draft，恢复原始画面。

对于极高频笔刷，可使用专用 stroke buffer，完成后一次性提交 mask command；若笔刷需要实时持久化，则必须有节流策略和事务边界。

## 6. Reactive Store 设计

### 6.1 Store 分区

建议至少区分：

```ts
interface RootState {
  project: ProjectState;
  ui: UIState;
  interaction: InteractionSnapshot;
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
  state: InteractionState;
}

interface DerivedState {
  // 通过 selectors 计算，不作为独立可编辑数据源
}
```

项目数据与临时 UI 状态必须分离：
- 项目数据：Sprite、Scene Layout、Animation Set、Clip、Frame、Pivot Preset 等。
- UI 状态：当前工作区、选中项、面板开合、缩放和平移。
- Interaction 状态：当前手势、临时草稿、指针会话。
- Derived 状态：列表分组、命中索引、质量检查摘要等派生值。

是否持久化 UI 状态由产品设置决定；Interaction gesture 永不持久化。

### 6.2 读写规则
- 组件通过 selector 读取所需状态。
- 组件不得直接 mutate Project 对象。
- Project 更新通过 Command Bus。
- UI 状态可通过独立 UI actions 更新。
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

selector 应尽量返回稳定引用或使用 memoization，避免无关状态变化触发全部工作区重绘。

## 7. Command Bus 与 History Manager

### 7.1 修改入口
项目数据修改必须走 Command：
- CreateSprite / UpdateSpriteGeometry / DeleteSprite
- UpdateSceneLayout / ReorderSceneLayers
- CreateAnimationSet / UpdateClip / ReorderFrames
- SetFramePivot / SetFrameOffset
- ApplyCalibrationResult
- ImportAgentData
- DeleteOverlapComponents

禁止组件直接写入 sprites、animationSets 或 sceneLayout。

### 7.2 Command 接口

```ts
interface Command<TPayload = unknown> {
  id: string;
  type: string;
  payload: TPayload;
  execute(context: CommandContext): CommandResult;
  undo?(context: CommandContext): void;
  label: string;
  affectedIds: string[];
}
```

Command 实现可以采用纯 reducer + inverse patch，而不一定使用类；关键是有统一输入、输出、影响范围和撤销语义。

### 7.3 History
- 支持 undo / redo。
- 每次成功提交形成历史项。
- 连续拖动形成一个历史项。
- 批量校准、Agent 导入、批量属性修改形成一个事务。
- 失败事务不进入历史。
- redo 栈在新命令提交后清空。
- 历史项记录 label、时间、affectedIds、数据 revision。
- 历史容量可配置；大图 mask 应评估快照内存，必要时使用差异记录或压缩快照。

### 7.4 事务
事务支持：
- beginTransaction(label)
- dispatch(command)
- commitTransaction()
- rollbackTransaction()

批量操作必须原子化：要么全部成功，要么恢复到执行前状态。

## 8. Store 与渲染同步

各工作区从 Store 订阅所需状态：
- 主画布订阅 Sprite Render Model。
- 列表订阅 Sprite Summary。
- Inspector 订阅当前选中实体属性。
- Scene Workspace 订阅 Scene Render Model。
- Animation Workspace 订阅 Clip / Frame / Preview Model。
- Agent 面板订阅导入预览状态。

不得依赖业务代码手工记住调用 draw()、refreshList()、syncInspectorProperties() 等多个刷新函数。可以保留局部渲染 API，但更新触发源应来自订阅状态变化。

高频画布拖动可用临时 draft 绘制，不应触发整个 Store 树和所有面板重渲染。

## 9. Canvas / 坐标与命中测试

建立统一坐标工具：
- clientToCanvas()
- canvasToWorld()
- worldToCanvas()
- spriteLocalToCanvas()
- canvasToSpriteLocal()
- getSpriteTransformedBounds()
- hitTestSprite()
- hitTestHandle()

所有工具使用同一变换矩阵和像素比例定义。

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
- Alpha / hit-test / thumbnail 等昂贵结果缓存，并按资源版本失效。
- 指针事件不触发不必要的持久化写入。
- 异步任务携带项目 revision，过期结果不得覆盖新数据。
- 工作区卸载时取消异步任务与交互会话。
- 所有异常路径都保证 gesture 清理。

## 11. 迁移策略

### Step 1：封装旧交互入口
先保留 V9 UI，将现有 pointer 逻辑集中到 Interaction Manager 适配层，不改变算法。

### Step 2：引入互斥状态
将 addMode / lassoMode / refineMode / drag 等映射为明确 tool 与 gesture。设置统一 activateTool / cancelGesture。

### Step 3：统一指针生命周期
增加 pointercancel、lostpointercapture、blur、workspace switch 的清理与测试。

### Step 4：引入 Store
先迁移选中项、工作区、Sprite 列表和 Inspector，再迁移 Scene Layout，最后迁移动画数据。

### Step 5：引入 Command / History
优先覆盖删除、几何修改、属性修改、场景操作、Agent 导入；动画工作区开放前必须覆盖帧和校准操作。

### Step 6：删除旧状态入口
确认无模块依赖旧布尔值和直接 mutate 后，再删除兼容层。

## 12. 测试与验收

### 12.1 状态机测试
- 任何时刻最多一个主 gesture。
- 非法转换被拒绝或安全取消。
- 工作区切换取消当前 gesture。
- 自动识别不会遗留旧工具状态。
- pointercancel 后可立即开始下一次操作。

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
- 异步旧 revision 结果不能覆盖新状态。

### 12.4 History 测试
- 每次手势只生成一个历史项。
- cancel 不生成历史项。
- 批量操作一次撤销全部恢复。
- undo 后 redo 恢复相同数据。
- 新操作提交后 redo 栈清空。
- 失败事务不污染状态和历史。

### 12.5 回归场景
1. 切换套索、矩形、精修后执行自动识别。
2. 自动识别后立即手工追加选区。
3. 拖动时切换工作区或窗口失焦。
4. 场景中旋转、缩放对象并点击边界。
5. 连续修改属性并检查所有面板。
6. 删除 / 排序 Sprite 后检查动画引用。
7. 动画 Pivot 拖动中取消指针。
8. 自动校准应用后整体撤销。

## 13. 完成标准

- 交互模式互斥且状态转换可追踪。
- 所有指针异常路径能恢复。
- 所有业务数据修改经 Command。
- Store 成为唯一数据源。
- Canvas、列表、Inspector、Scene、Animation 订阅同步。
- 高频操作不会导致全界面无意义重绘。
- 撤销 / 重做覆盖所有正式数据修改。
- 动画工作区不再建立独立的交互或状态管理机制。
