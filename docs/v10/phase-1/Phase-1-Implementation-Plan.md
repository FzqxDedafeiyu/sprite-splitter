# V10 Phase 1 实施计划与任务拆分

> 状态：规划基线（Planning Baseline）
> 创建日期：2026-11-27
> 规划分支：\`v10/phase-1-planning\`
> 上游基线：\`v10/phase-0-baseline\`
> 技术规范：\`docs/v10-technical-blueprint\` 三份 V1.5 Frozen Implementation Baseline
> 本文用途：将冻结技术规格拆解为可执行、可验收、可回滚的工程任务；本文不替代或修改冻结规格。

---

## 1. Phase 1 目标与范围

Phase 1 的目标是建立 V10 模块化工程与核心架构基础，并在此基础上逐步接入既有 V9 能力和 Animation System。Phase 1 采用小步迁移，不进行一次性重写。

### 1.1 本阶段目标

1. 建立独立于 V9 单文件的 V10 源码工程。
2. 验证现有图像算法可在新工程中复用，优先封装，不重写算法。
3. 建立 V10 Project / Domain 模型、资源身份与版本规则。
4. 建立统一坐标变换、Interaction Manager 和 Reactive Store。
5. 建立 Command Bus、原子事务、History、revision / resource 冲突保护。
6. 逐步接入 Sprite、Scene、Agent、Animation 工作区。
7. 建立 V9 导出物迁移、V9 场景兼容导出与 V10 动画导出的验证链路。

### 1.2 明确不在本阶段擅自改变的事项

- 不修改 V9 正式 HTML，不以 V10 实验版本替换 V9。
- 不重写 Alpha 连通域、背景抠除、GrabCut、手工选区等已存在算法。
- 不改变三份 V1.5 冻结技术规格；发现规格冲突时先登记决策项，不自行改写契约。
- 不将 V9 场景 Anchor 当成 Animation Pivot。
- 不从 V9 场景 Manifest 推断 AnimationSet / Clip / Frame。
- 不允许 Agent 结果绕过预览、确认和 Command 直接修改 Project。
- 不在文件读取、Worker、字体、资源 URL、离线和浏览器兼容性验证前承诺单文件 HTML 是唯一交付形式。
- 不在本计划阶段开始实现具体业务功能。

---

## 2. 依据与基线

### 2.1 必须遵守的冻结规格

- \`docs/v10/01-总体架构与模块迁移方案.md\`
- \`docs/v10/02-Animation-System-技术规格.md\`
- \`docs/v10/03-Interaction-Manager与Reactive-Store技术规格.md\`

规划与实现前必须阅读三份完整规格，不得只依赖本文摘要。

### 2.2 Phase 0 输入

Phase 0 的测试记录与素材位于 \`docs/v10/phase-0/\`。实施过程中应使用真实 V9 导出物回归，不得把测试素材生成结果当成真实 V9 导出行为。

重点回归输入：
- A-001：基础单精灵边界与外扩。
- A-002 / A-006：接触、微光连接和 Alpha 阈值行为。
- A-003 / A-004：真实 Alpha、渐变背景、软边光晕与原始像素保留。
- A-005：小像素和最小区域面积。
- A-007：自动识别与手工补框、删除。
- A-008 / A-009：场景输入、Agent 任务包与 JSON 往返。
- A-010：V9 实际 ZIP / Manifest 输入样本；在迁移验收前仍需对 ZIP 内部结构做独立完整性检查。

Phase 0 已记录的选区放大后显示不清晰问题，应纳入视口缩放与绘制回归；在定位前不得假设是缩放逻辑简单反转。

### 2.3 分支与文件保护

- Phase 1 规划分支从 \`v10/phase-0-baseline\` 创建。
- 规划阶段仅增加 / 修改 Phase 1 规划文档。
- 后续实现应从经确认的 Phase 1 规划基线创建独立实现分支。
- \`main\`、V9 HTML 和冻结技术规格分支均不得被 Phase 1 实现直接写入。
- 每个里程碑单独提交；不得将多个核心系统重写塞入一个提交。

---

## 3. 实施总览与依赖顺序

P1-0 工程与技术验证
→ P1-1 Domain / Project / Resource 基础
→ P1-2 坐标系统 + Interaction Manager + Reactive Store
→ P1-3 Command Bus + Transaction + History
→ P1-4A V9 适配与工作区接入 / P1-4B Animation System
→ P1-5 QA / 导出 / 回归 / 交付

P1-4A 与 P1-4B 可以在基础设施稳定后并行开发，但必须共享同一 Domain、Store、Command、坐标与资源契约。最终集成与验收统一进入 P1-5。

---

## 4. 里程碑拆分

## P1-0：工程与技术验证门

**目标：** 在正式迁移业务代码前，确认工程方案、构建方式和 V9 算法复用路径可行。

| ID | 任务 | 具体工作 | 交付 / 验收 |
|---|---|---|---|
| P1-0-01 | 工程脚手架验证 | 验证 TypeScript + Vite、模块别名、类型检查、测试运行器、构建脚本 | 空白工程可安装、检查、测试、构建 |
| P1-0-02 | V9 算法盘点 | 定位图像识别、Alpha、背景排除、GrabCut、矩形 / 多边形、像素提取等入口、依赖和副作用 | 算法清单与复用风险表；不修改算法 |
| P1-0-03 | 算法隔离 Spike | 选一个低风险算法入口，验证从 V9 环境提取 / 适配到模块工程 | 同输入下输出与 V9 基线一致；差异有记录 |
| P1-0-04 | Canvas 与坐标 Spike | 验证 DPR、CSS 缩放、视口平移、sourceLocal / spriteLocal 转换与命中测试共用变换 | 坐标往返测试与截图 / 数值记录 |
| P1-0-05 | 文件与 ZIP Spike | 验证 PNG 读写、ZIP 导入导出、中文文件名、Manifest、异常 ZIP 处理 | A-010 样本专项检查记录 |
| P1-0-06 | Worker / OpenCV 验证 | 验证 Worker 资源路径、OpenCV.js 加载、取消与错误处理、离线依赖边界 | 明确离线能力，GrabCut 联网依赖单独标注 |
| P1-0-07 | 交付形态决策 | 比较单文件 HTML 与离线 ZIP / 多文件静态工程，检查字体、资源 URL、Worker、浏览器打开方式 | 有证据的交付决策，不预设单文件可行 |
| P1-0-08 | 技术决策记录 | 记录依赖版本、目录方案、构建方案、兼容性、未决风险 | ADR / 技术验证报告 |

**进入 P1-1 的门槛**
- 工程可重复安装依赖、运行测试、完成构建。
- 至少一个代表性 V9 算法已证明可复用，或形成明确阻塞与替代方案。
- Canvas 坐标模型通过往返与缩放测试。
- ZIP / Manifest 读写路径明确，A-010 样本结构检查结果已登记。
- OpenCV.js、Worker、离线和交付形态限制有书面结论。

若技术验证失败，暂停后续迁移，先解决阻塞；不得通过绕过测试强行进入 P1-1。

---

## P1-1：Domain、Project 与资源基础

**目标：** 建立唯一、稳定、可持久化的数据模型。

| ID | 任务 | 具体工作 | 交付 / 验收 |
|---|---|---|---|
| P1-1-01 | Domain 类型 | 建立 ProjectDocument、SpriteAsset、SourceImage、SceneLayout、AnimationSet、Clip、Frame、PivotPreset 等类型 | 类型与 V1.5 Schema 一致 |
| P1-1-02 | 稳定身份 | UUID、legacyId、idMap、Frame ID / Sprite ID 分离 | 排序、删除、重开后引用稳定 |
| P1-1-03 | Revision Ledger | Project / Entity / Resource revision、tombstone、水位规则 | Create / Update / Delete 版本矩阵测试通过 |
| P1-1-04 | Resource Store | 不可变字节、resourceId、revision、SHA-256、byteLength、staging | 字节校验、引用切换和失败清理通过 |
| P1-1-05 | Mask 数据契约 | 原始 Alpha、可编辑 Mask、导出 Alpha 分离；Mask 与 Sprite PNG 尺寸一致 | Mask 保存关闭重开一致；Trim 变化按 sourceLocal 映射 |
| P1-1-06 | Project Persistence | Project Manifest 与资源读写、schemaVersion、保存 / 打开 | 保存后重开一致；损坏 / 缺失资源可报告 |
| P1-1-07 | Selector 初版 | 建立领域实体读取与派生视图接口 | assets 是唯一权威 Sprite 集合 |
| P1-1-08 | Domain 单元测试 | Schema、唯一性、引用完整性、路径安全、资源 hash | 正常 / 异常输入覆盖 |

强制约束：
- 领域模型以冻结规格为准，不自行精简必需字段。
- 未知字段按规定保留并报告，不静默丢弃。
- V9 ZIP 不含原图字节时，SourceImage 标记 missing。
- V9 未导出的内存 Mask 不得声称可迁移。
- Revision 不得因 undo / redo 回退。
- 资源引用只能在资源校验和 Project CAS 成功后发布。

**进入 P1-2 的门槛：** Project 可创建、保存、关闭、重开；实体身份与资源版本稳定；资源 / Mask 事务测试通过。

---

## P1-2：统一坐标、Interaction Manager 与 Reactive Store

**目标：** 建立统一交互运行时和状态订阅基础。

| ID | 任务 | 具体工作 | 交付 / 验收 |
|---|---|---|---|
| P1-2-01 | 坐标空间工具 | viewport、sourceLocal、sceneWorld、spriteLocal、clipCanvas、atlasImage 转换 | 转换函数集中；往返误差符合容差 |
| P1-2-02 | 视口变换模型 | 统一缩放、平移、DPR、绘制和命中矩阵 | 绘制与命中使用同一变换 |
| P1-2-03 | Hit Test | Z 顺序、锁定 / 隐藏、透明像素、控制柄命中半径 | 旋转 / 缩放对象绘制与命中一致 |
| P1-2-04 | Interaction 状态机 | Tool 与 Gesture 分离；互斥状态转换 | 任一时刻最多一个主 Gesture |
| P1-2-05 | Pointer 生命周期 | pointerdown / move / up / cancel / lost capture / blur / unmount | 异常退出清理；取消不提交业务数据 |
| P1-2-06 | Gesture Draft | 拖动 / 套索 / 选区先形成临时 Draft | Draft 不写入 Project；提交时只生成一个 Command 请求 |
| P1-2-07 | Reactive Store | Project、UIState、InteractionSnapshot、PlaybackState、Derived 分区 | 组件只读订阅；无业务对象共享引用修改 |
| P1-2-08 | Selector / 订阅 | 画布、列表、Inspector、Scene 的细粒度 Selector | 相关视图同步，无关视图不全量刷新 |
| P1-2-09 | Workspace 生命周期 | 工作区切换、卸载、失焦时清理 Gesture / 异步任务 | 无残留 pointer session / draft |
| P1-2-10 | 交互自动化测试 | 工具互斥、控件误触、多指针、锁定对象、取消和恢复 | 状态机与指针测试通过 |

强制约束：
- Interaction Manager 是真实 Pointer Session / Gesture 的唯一所有者。
- Store 的 InteractionSnapshot 只读，不包含真实 pointerId 或可变 Draft。
- activeTool 只在 UIState.activeToolByWorkspace 存一份。
- PlaybackState 不属于 Gesture 状态机。
- UI 组件不得直接修改 Project。
- 工作区切换 / 自动识别 / 导入前按规格取消活动 Gesture。

**进入 P1-3 的门槛：** 交互状态互斥、异常路径可恢复；多面板订阅更新稳定；坐标与命中回归通过。

---

## P1-3：Command Bus、事务与 History

**目标：** 让正式业务修改具有一致的校验、提交、回滚、撤销和重做语义。

| ID | 任务 | 具体工作 | 交付 / 验收 |
|---|---|---|---|
| P1-3-01 | Command 契约 | CommandResult、read-set / write-set、Entity / Resource expectations | expected 值来自同一不可变快照 |
| P1-3-02 | Command Bus | 统一 dispatch、校验、执行、持久化、发布 | 业务修改不得绕过 Command |
| P1-3-03 | Project CAS | expectedProjectRevision compare-and-swap | 过期提交拒绝；无 last-write-wins |
| P1-3-04 | 冲突分类 | target-entity / resource / project-cas | 结构化错误与冲突对象完整 |
| P1-3-05 | 安全 Rebase | 仅对满足 V1.5 条件的 project-cas 冲突重试一次 | 实体 / 资源冲突不自动重试 |
| P1-3-06 | CompositeCommand | 子命令暂存、失败逆序回滚、一次提交 | 任一子命令失败整体回滚 |
| P1-3-07 | History Manager | undo / redo、revision 校验、资源 pin | 撤销重做是新事务；revision 单调递增 |
| P1-3-08 | Gesture → Command | 拖动、框选、笔刷完成时转换单一 Command | 一次连续手势一个 History 项 |
| P1-3-09 | 资源事务 | Mask / PNG staging、Manifest CAS、失败清理 | 不产生半成品引用或损坏旧资源 |
| P1-3-10 | History / 并发测试 | 跨工作区、跨标签页、外部修改、undo 冲突 | 不覆盖外部新值；冲突可解释 |

首批 Command：
- Create / Update / Delete Sprite。
- Update Sprite Geometry / Mask / Raster。
- Update Scene Layout / Reorder Layers。
- Import Agent Data。
- Update Sprite Properties。
- 后续增加 Animation Set / Clip / Frame / Calibration Commands。

所有进入 History 的 Command 必须有 undo。纯 UI 状态变化不作为 Project History 项。

**进入 P1-4 的门槛：** 关键编辑走 Command；CompositeCommand 原子性通过；undo / redo 与资源恢复通过；冲突保护不覆盖外部更新。

---

## P1-4A：V9 兼容迁移与既有能力接入

**目标：** 在新架构中接入 Sprite / Scene / Agent 功能，并证明真实 V9 导出物可以安全迁移。

| ID | 任务 | 具体工作 | 交付 / 验收 |
|---|---|---|---|
| P1-4A-01 | V9 ZIP Parser | 安全解压、Manifest 解析、路径规范化、PNG 校验 | 损坏 ZIP / 路径穿越 / 缺失文件阻断并报告 |
| P1-4A-02 | V9 Adapter | 适配 spatial-scene-layout/v2 与 Agent v1 / v2 | 不直接 cast；旧字段只在边界解析 |
| P1-4A-03 | ID Mapping | legacyId → UUID 完整映射后解析 relations / Agent refs | 重复 ID 整体隔离；无悬空 UUID |
| P1-4A-04 | Scene 迁移 | position、transform、sceneAnchor、layer、depth、parallax | 对比 V9 左上角、变换后边界和绘制像素 |
| P1-4A-05 | Sprite 工作区 | 列表、Inspector、画布、手工选区基础接入 | Store 驱动多面板；修改通过 Command |
| P1-4A-06 | 旧算法适配器 | 对接 P1-0 验证过的 V9 算法入口 | 同输入与 V9 结果对照；不重写算法 |
| P1-4A-07 | Agent 工作流 | 任务包导出、结果校验、预览、确认、应用 | A-009 JSON 往返；应用为单个可撤销事务 |
| P1-4A-08 | V9 场景兼容导出 | 保持 spatial-scene-layout/v2 原字段 / 目录 / 序号语义 | 与既有消费者兼容 |
| P1-4A-09 | 迁移报告 | 成功、跳过、warning、error、missing source、不可恢复 Mask | 报告完整；原文件不覆盖 |

迁移验收重点：
- A-010 ZIP 先做结构、CRC、Manifest 与 PNG 对应关系专项检查。
- sourceRect 已知时必须与 PNG 实际宽高一致。
- V9 ZIP 没有原图字节时创建 missing SourceImage。
- V9 Anchor 只迁移为场景参考标记，来源标记符合规格。
- V9 场景 Manifest 不自动产生动画组或帧。
- Agent 数据必须经过协议适配、ID 映射、预览和确认。
- 未知字段保留，不丢弃。

---

## P1-4B：Animation System

**目标：** 在 Domain / Store / Command / 坐标基础稳定后建立动画数据、校准、预览与导出。

| ID | 任务 | 具体工作 | 交付 / 验收 |
|---|---|---|---|
| P1-4B-01 | Animation Domain | AnimationSet / Clip / Frame / PivotPreset | 与 V1.5 模型一致；Frame ID 与 Sprite ID 分离 |
| P1-4B-02 | 动作组管理 | 角色 / 物体动作组、Clip、帧顺序、帧时长 | 一个 Sprite 可被多个 Frame 引用 |
| P1-4B-03 | Pivot Presets | bbox_center、alpha_centroid、bottom_center、bottom_contact、semantic_point、custom | 几何候选使用当前 Sprite PNG Alpha 与 spriteLocal |
| P1-4B-04 | Pivot / Offset 编辑 | 组级目标、单帧 Pivot / Offset、锁定、复制 | 坐标语义明确；手工结果默认保护 |
| P1-4B-05 | Calibration Engine | preview / apply、置信度、异常和保护摘要 | 预览不改数据；apply 是单个 CompositeCommand |
| P1-4B-06 | Playback Controller | 播放、暂停、逐帧、Loop、FPS、duration | 累计时间调度；PlaybackState 独立 |
| P1-4B-07 | Gesture 联动 | 拖 Pivot / Offset 时 AUTO_PAUSE，结束按策略恢复 | cancel / blur / lost capture 无播放死锁 |
| P1-4B-08 | Onion Skin / 对比 | 前后帧叠加、固定参考点、并排对比 | 使用统一 frame layout / render transform |
| P1-4B-09 | Animation QA | 引用、帧时长、Pivot、Offset、Trim、循环等检查 | error / warning / info 定位到 Clip / Frame |
| P1-4B-10 | PNG Sequence Export | sprite-anim-manifest/v1 + PNG + JSON | schema、引用、坐标和 hash 校验 |
| P1-4B-11 | Sprite Sheet / Atlas | packing、padding、extrusion、多页、Trim | atlasTrimOffset 与 sourceTrimOrigin 严格分离 |
| P1-4B-12 | 动画自动化测试 | Idle / Walk / Jump / Open / Spin 五类素材 | 校准、预览、播放、Trim、导出抽样一致 |

强制约束：
- 不得从 V9 场景 Anchor 推导 Animation Pivot。
- 不得根据名称相似、数组相邻或 groupName 自动推断动作组。
- 唯一布局公式为 Dᵢ = T - Pᵢ + Oᵢ。
- Pivot / Offset 权威值保留浮点精度；绘制像素对齐不回写业务数据。
- manual / imported 帧默认受保护；覆盖必须显式选择并二次确认。
- 自动校准必须校验 Project / Clip / Frame / Resource 版本快照。
- 预览、QA、导出共享同一套布局 / 变换函数。
- Source Trim 与 Atlas Trim 属于不同层级、不同坐标空间。
- 动画导出使用独立 sprite-anim-manifest/v1，不修改 V9 场景协议。

---

## P1-5：集成、质量门与交付

**目标：** 证明新架构各模块协同工作，旧能力没有因迁移而回归损坏，输出形态满足本地使用要求。

| ID | 任务 | 具体工作 | 交付 / 验收 |
|---|---|---|---|
| P1-5-01 | 端到端工作流 | 导入 → 切割 / 编辑 → 场景 → Agent → 动画 → 保存 / 重开 → 导出 | 真实素材端到端记录 |
| P1-5-02 | Phase 0 回归 | 使用 A-001～A-010 与既有回归清单 | 对照 V9 基线；差异逐项解释 |
| P1-5-03 | 交互回归 | 模式互斥、缩放、命中、pointercancel、blur、工作区切换 | 异常路径无残留 |
| P1-5-04 | 数据与资源完整性 | revision、hash、Mask、CAS、History、GC | 关键不变量自动化测试通过 |
| P1-5-05 | 兼容性回归 | V9 ZIP、Agent v1/v2、V9 场景导出 | 兼容协议样本验证通过 |
| P1-5-06 | 动画回归 | 五类素材、校准、播放、Trim / Atlas、PNG Sequence | 预览与导出抽样一致 |
| P1-5-07 | 离线与浏览器验证 | 断网、文件访问、Worker、OpenCV、字体、浏览器 | 能力矩阵和已知限制公开 |
| P1-5-08 | 性能验证 | 大图、批量 Sprite、时间轴、拖动、缓存 | 记录基线与性能预算 |
| P1-5-09 | 交付包 | 按 P1-0 决策输出构建产物、版本说明、校验信息 | 干净环境可按说明启动 |
| P1-5-10 | 发布候选审查 | 变更清单、测试证据、已知问题、回滚方式 | 用户审查后才考虑替代 V9 |

---

## 5. 任务优先级

### P0：基础阻塞项

以下任务不通过，不进入依赖它们的下游开发：
- 工程构建与测试门。
- V9 算法复用验证。
- 坐标变换与命中测试基础。
- Project / Resource / Revision 数据契约。
- Interaction Manager 状态互斥和取消清理。
- Command / CompositeCommand 原子性与 History。
- V9 ZIP / Manifest 安全解析。

### P1：主路径功能

- Sprite / Scene 编辑接入。
- Agent Adapter 与预览应用。
- Animation Domain / Playback / Calibration。
- V9 场景兼容导出与 V10 动画导出。

### P2：增强与优化

- 大型项目性能优化。
- 高级 Atlas 打包策略与多引擎适配器。
- 更丰富的自动化质量建议。
- 额外视觉体验优化。

P2 不得挤占 P0 的正确性工作，也不得改变冻结规格的权威数据语义。

---

## 6. 跨模块接口契约

| 接口 / 数据 | 唯一权威模块 | 其他模块的使用方式 |
|---|---|---|
| ProjectDocument / Domain entities | Domain + Project Store | 通过 Selector 读取，通过 Command 修改 |
| SourceImage / Sprite PNG / Mask bytes | Resource Store | 通过 ResourceRef / 资源服务读取 |
| Gesture / Pointer Session / Draft | Interaction Manager | UI 只读 InteractionSnapshot |
| activeToolByWorkspace | UIState | 工作区级唯一值 |
| PlaybackState / playback clock | Animation Playback Controller | UI 订阅；Interaction Manager 通过事件协作 |
| Project / Entity / Resource revision | Persistence + Revision Ledger | Command 从同一快照读取 expectations |
| Pivot / Offset / Frame layout | Animation System | Preview / QA / Export 共用计算服务 |
| V9 legacy IDs / protocol aliases | V9 Adapter | 进入 Domain 前转换为 UUID / camelCase |
| V10 动画 Manifest | Animation Exporter | 独立协议，不复用 V9 Scene Manifest |

禁止模块之间通过共享可变对象、隐式全局变量或直接修改对方内部字段建立依赖。

---

## 7. 自动化测试策略

### 7.1 单元测试

- Domain Schema / ID / Revision / Resource Hash。
- 坐标转换往返与边界条件。
- Gesture 状态转换和 pointer 生命周期。
- Selector 输出与订阅失效范围。
- Command 校验、冲突分类、CAS、安全 Rebase。
- CompositeCommand 原子性、History undo / redo。
- Animation 公式、Pivot Preset、Trim 转换与 Manifest Schema。

### 7.2 集成测试

- Project 保存 / 关闭 / 重开。
- Mask / PNG 资源原子提交与失败清理。
- Sprite 编辑同步画布、列表和 Inspector。
- Agent 导入预览与单事务应用。
- 播放中 Pivot 拖动暂停与恢复。
- V9 ZIP 迁移、V9 兼容导出、V10 动画导出。

### 7.3 端到端测试

使用 Phase 0 正式素材包与 A-009 / A-010 真实结果文件。每次回归记录：
- 输入文件 SHA-256。
- 软件构建版本 / commit。
- 浏览器与运行方式。
- 参数与操作步骤。
- 预期结果、实际结果、截图或输出文件。
- 自动化 / 人工执行者及结果。
- 未通过项与复现步骤。

测试报告必须区分自动化实测、人工实测、静态检查和推断。

---

## 8. 风险与待决策项

| ID | 风险 / 决策 | 处理方式 | 决策门 |
|---|---|---|---|
| R-01 | V9 单文件代码耦合导致算法难以独立复用 | P1-0 算法盘点与 Spike；先封装再迁移 | P1-0 |
| R-02 | 单文件 HTML 与模块化资源 / Worker 冲突 | 比较单文件和离线 ZIP；用真实浏览器验证 | P1-0 |
| R-03 | OpenCV.js 体积与离线能力 | 明确本地打包方案和联网功能边界 | P1-0 |
| R-04 | V9 导出 ZIP 与异常数据不完整 | A-010 独立结构检查；建立损坏输入测试 | P1-0 / P1-4A |
| R-05 | 视口缩放后内容显示不清 | 检查 CSS / Canvas / DPR / LOD / 最小显示尺寸；先复现再修复 | P1-0 / P1-2 |
| R-06 | Mask 与 Trim / Raster 修改不一致 | 统一资源事务与 sourceLocal 映射 | P1-1 / P1-3 |
| R-07 | 跨标签页并发覆盖 | Project CAS + Entity / Resource expectation | P1-3 |
| R-08 | 动画语义与场景数据混淆 | 独立 Animation Domain；禁止从 Scene Anchor 推断 Pivot | P1-4B |
| R-09 | 自动校准覆盖手工结果 | 来源保护、Preview、CompositeCommand、二次确认 | P1-4B |
| R-10 | 模块迁移期间功能回归 | Phase 0 素材持续回归；每里程碑设质量门 | 全阶段 |

### 8.1 需要在实现前明确的工程决策

1. TypeScript / Vite 具体版本与依赖锁定方式。
2. 测试框架、浏览器自动化方案和 CI 执行环境。
3. Project / Resource Store 首期采用的浏览器持久化后端与原子提交实现。
4. Worker / OpenCV.js 的加载和取消方案。
5. 目标浏览器范围及本地打开 / 本地服务器要求。
6. 单文件 HTML 与离线 ZIP 的最终交付优先级。

以上决策需用 Spike / ADR 留证，不得在本文中伪装成已验证结论。

---

## 9. 每个任务的交付模板

每个实现任务开始前必须给出：
- 任务 ID 与目标。
- 对应冻结规格章节。
- 允许修改的文件 / 模块。
- 明确禁止修改的文件 / 模块。
- 输入 / 输出接口。
- 依赖任务与阻塞项。
- 自动化测试与人工验收步骤。
- 回滚方式。

任务完成后必须记录：
- 实际修改文件。
- Commit SHA。
- 自动化测试结果。
- 人工验收结果（如有）。
- 与冻结规格的符合性。
- 已知问题与未完成项。
- 回滚方式。

不允许只用“完成”“看起来正常”作为验收证据。

---

## 10. Phase 1 完成定义

Phase 1 只有同时满足以下条件，才可提交为 V10 发布候选：

1. 新工程构建、测试、离线 / 交付方案经过验证。
2. V9 核心图像算法已复用并通过基线回归，或明确标注未迁移能力。
3. Project / Domain / Resource / Revision 模型符合 V1.5。
4. Interaction Manager 独占真实 Gesture，指针异常路径可恢复。
5. Reactive Store 成为 Project 数据唯一权威来源，多面板订阅同步。
6. 正式业务修改通过 Command；批量操作原子化。
7. History undo / redo 与冲突保护覆盖正式数据修改。
8. V9 实际导出物可安全迁移，缺失 / 歧义数据有明确报告。
9. Animation System 可保存、重开、校准、播放和导出。
10. 预览、QA 与导出使用统一坐标 / 渲染计算。
11. Phase 0 回归与新增自动化测试通过；未通过项有明确阻断或风险结论。
12. 交付包、版本说明、测试证据和回滚方案齐备。

达到这些条件不自动授权替换 V9 正式文件；替换 / 发布仍需单独审查和明确授权。

---

## 11. 当前执行状态

| 里程碑 | 状态 |
|---|---|
| Phase 0 基线与文档归档 | 已完成（以 Phase 0 分支提交为准） |
| P1-0 工程与技术验证门 | 待启动 |
| P1-1 Domain / Project / Resource | 未开始 |
| P1-2 Interaction / Store / 坐标 | 未开始 |
| P1-3 Command / History | 未开始 |
| P1-4A V9 兼容与工作区接入 | 未开始 |
| P1-4B Animation System | 未开始 |
| P1-5 集成与交付 | 未开始 |

**当前授权范围：** 已授权正式启动 Phase 1 的实施计划与任务拆分。本文提交后，下一项工作是 P1-0 技术验证，不代表已授权直接修改 V9 或跳过技术验证门。
