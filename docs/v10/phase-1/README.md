# V10 Phase 1 — 领域模型与 V9 兼容层实施计划

> 阶段状态：已启动（独立分支）
> 依据：`docs/v10-technical-blueprint` 分支三份 V1.5 Frozen Implementation Baseline
> 本阶段目标：建立可持久化的 V10 领域模型与 V9 导出物兼容入口；不重写图像算法，不提前进入 Interaction Manager / Reactive Store 阶段。

## 1. 分支与基线

- 实施分支：`v10/phase-1-core-foundation`
- 起点：Phase 0 收尾提交 `3d3613350100e1d4be8843354ecc80023052cd95`
- V9 main 基线：`473931a1109d118f1acfb3c4d91f349f2ac22873`
- V9 HTML Blob：`e37512e24202892804649201580d71c6ee6df018`
- 冻结规格分支：`docs/v10-technical-blueprint`（只读引用，不合并、不修改）

## 2. 本阶段范围

### 2.1 领域模型

按冻结规格建立并验证以下模型与 schema：
- Project / ProjectDocument 与 projectSchemaVersion。
- SourceImage（允许 available / missing 两种状态）。
- SpriteAsset：稳定 UUID、legacyId、sourceRect、shape / points、资源版本、contentVersion、revision、legacyExtensions。
- SceneLayout：sceneWorld position、Scene Anchor、layer、depth、parallax、zIndex、visibility、locked、transform。
- ResourceVersion：resourceId、单调 revision、SHA-256 contentHash、byteLength。
- RevisionLedger 与实体 / 资源 / Project revision 关系，按 V1.5 冻结契约实现。
- 明确 Source Local、Sprite Local、sceneWorld 的坐标转换边界；Source Trim 与 Atlas Trim 不混用。

本阶段不实现 Animation Workspace，但领域模型不得占用或误用 Animation Pivot 字段；V9 sceneAnchor 不能迁移成 Animation Pivot。

### 2.2 V9 兼容层

实现 V9 Export Adapter，读取实际 V9 导出 ZIP（sprites/*.png + manifest.json）和单独 Manifest：
- 按实际 `spatial-scene-layout/v2` 结构解析，不假设 V9 存在完整项目文件。
- 为旧 Sprite 分配稳定 UUID，并生成可重复验证的 legacyId → UUID 映射。
- 保留名称、分类、描述、sourceRect、shape / points，以及 Manifest 实际包含的场景属性。
- PNG 尺寸必须与已知 sourceRect 宽高一致；不一致时阻断该 Sprite 自动导入并报告。
- 对缺失、损坏、重复、孤立 PNG 形成迁移诊断；重复 legacyId 整体隔离。
- V9 ZIP 不含原始整图字节时，SourceImage 必须标记 missing，不得伪造可用原图。
- V9 未导出的内存 Mask 不得假装迁移成功；报告提示需重新切割或精修。
- 未知字段进入 legacyExtensions；缺失或歧义字段使用显式状态，不以空 UUID、全零矩形或空字符串伪造有效值。
- Agent 结果 JSON 是可选标注输入，不是完整项目文件；只允许写入 AgentAnnotation 对应语义，不允许改写裁切几何或资源像素。

### 2.3 持久化最小闭环

建立 V10 Project 文件的序列化 / 反序列化与 schema version 判别：
- 项目文件以 kind + projectSchemaVersion 判别。
- 保存后重新打开，领域数据与资源引用保持一致。
- ResourceVersion 与实际资源字节校验 SHA-256 / byteLength。
- 迁移报告与 Project 文件分离保存或明确记录，不能静默丢弃异常。

## 3. 明确不做

- 不修改 V9 HTML、V9 切割/抠图/GrabCut 算法或 main。
- 不修改三份 V1.5 冻结规格。
- 不在本阶段实现 Interaction Manager、Reactive Store、Command / History（属于后续 Phase 2 / Phase 3）。
- 不实现 Animation Domain / Workspace / Calibration。
- 不做大规模视觉改版。
- 不把 Agent 对场景语义的推断当作 V9 自动识别能力；A-008 的远/中/近景语义由 Agent 提供并经过校验。

## 4. 实施顺序

1. **工程技术验证**：确认模块化工程、TypeScript 构建、资源加载、ZIP 读取、浏览器文件读写的最小可行方案；不承诺未经验证的单文件交付。
2. **Schema 与类型**：按冻结文档实现 Project / SourceImage / SpriteAsset / SceneLayout / ResourceVersion / RevisionLedger 类型与运行时校验。
3. **坐标与映射纯函数**：实现 sourceLocal ↔ spriteLocal、V9 scene position / transform 映射；建立可测试的确定性函数。
4. **V9 Adapter**：导入仓库 A-010 ZIP 与 Manifest，生成迁移结果及诊断报告。
5. **Agent Annotation Adapter**：用 A-009 v2 样本验证 spriteId 映射与标注字段回写；严格禁止改变几何与像素资源。
6. **Project Persistence**：保存、关闭、重开，验证 UUID、资源哈希、revision 与关系完整。
7. **回归与阶段验收**：运行本文件第 5 节的验收矩阵，记录失败样本，不以忽略错误的方式“通过”。

## 5. Phase 1 验收门槛

| 验收项 | 必须达到 |
|---|---|
| V9 ZIP / Manifest | A-010 样本可识别；单独 Manifest 也可读取 |
| Schema 判别 | 项目文件通过 kind + projectSchemaVersion 区分，错误版本给出明确诊断 |
| 字段映射 | V9 Manifest 每个 sprite 字段有明确映射表落点 |
| UUID 稳定性 | 同一导入映射可重复验证；保存、重排、删除其他元素后 ID 不漂移 |
| Agent 对应 | A-009 的 30 个标注能准确对应目标 Sprite；无错配 |
| 几何不变 | Agent 导入前后 sourceRect、shape / points、PNG 字节不变 |
| 场景位置 | 至少抽样 3 个不同 transform，迁移前后 sceneWorld 位置一致 |
| 资源完整性 | PNG 实际尺寸与 sourceRect 一致；SHA-256 / byteLength 校验通过 |
| 异常诊断 | 缺失、损坏、重复、孤立 PNG 有明确报告和隔离策略 |
| Mask 边界 | V9 不存在的内存 Mask 不被虚构迁移 |
| 未知字段 | legacyExtensions 保留未知字段；无悬空关系引用 |
| 持久化 | 保存并重新打开后实体、资源、关系与版本一致 |

任何一项不满足，不得标记 Phase 1 完成。

## 6. 交付物

- V10 工程骨架与可复现构建命令。
- 领域模型 TypeScript 类型及运行时 schema。
- V9 Export Adapter 与迁移诊断报告。
- Agent Annotation Adapter（只写语义标注）。
- Project 序列化 / 反序列化与资源完整性校验。
- A-009 / A-010 自动化或可重复手工验收记录。
- 阶段变更摘要、测试结果、已知限制与回滚方式。

## 7. 与 Phase 0 测试发现的关系

- A-001～A-007 的识别表现属于 V9 算法基线；本阶段不改变算法。
- A-006 在 Alpha 阈值 47 下通过，记录为参数调整后通过。
- A-004 说明识别阈值与原始低 Alpha 像素保留应解耦；本阶段迁移时必须保留 V9 导出 PNG 的原始字节，不在 Adapter 中重做 Alpha。
- A-007 的语义相关特效拆分、手工补框与删除入口问题进入后续交互设计，不在兼容层中自动合并。
- A-008 的语义层级由 Agent 标注；Adapter 负责校验并保留数据，不负责图像语义推断。
- A-009 是 Agent JSON 往返样本；A-010 是 V9 ZIP / Manifest 迁移基准。
- 选区放大后显示不清晰的 V9 观察问题留在 Known Issues；本阶段不修改 V9 Canvas 显示逻辑。
