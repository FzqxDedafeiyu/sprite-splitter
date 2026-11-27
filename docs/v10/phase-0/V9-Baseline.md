# V9 Baseline — Phase 0

> 状态：Phase 0 基线与人工测试记录收尾版
> 检查日期：2026-11-26
> 基线来源：GitHub 仓库数据、V9 静态源码审查及用户人工测试反馈

## 1. 仓库与分支

- Repository：`FzqxDedafeiyu/sprite-splitter`（Public，未归档）
- 默认分支：`main`
- main 基线 commit：`473931a1109d118f1acfb3c4d91f349f2ac22873`
- Phase 0 工作分支：`v10/phase-0-baseline`，从上述 main 基线创建；未修改 main。
- 冻结规格分支：`docs/v10-technical-blueprint`，Phase 0 不修改其三份 V1.5 Frozen Implementation Baseline 文档。

## 2. V9 主文件基线

文件：`精灵图切分编辑器_V9_分组批量属性与中文导出版.html`

- main 基线 commit：`473931a1109d118f1acfb3c4d91f349f2ac22873`
- Blob SHA：`e37512e24202892804649201580d71c6ee6df018`
- GitHub tree 报告大小：85,998 bytes
- Git mode：`100644`
- 主程序标题：像素精灵图切分编辑器 V9

Phase 0 工作分支中该文件保持不变；Phase 0 没有修改 V9 HTML、V9 算法或 main。

## 3. 冻结规格

以下文档位于 `docs/v10-technical-blueprint` 分支，均标明 V1.5 / Frozen Implementation Baseline：

| 文档 | Blob SHA |
|---|---|
| docs/v10/01-总体架构与模块迁移方案.md | 8d6e353b9ebf33a6b6843eafc0c66c0a2e9d3477 |
| docs/v10/02-Animation-System-技术规格.md | b3a20eed53b39dee5855e96a917ce3dcfbb1ca3a |
| docs/v10/03-Interaction-Manager与Reactive-Store技术规格.md | 9ff5659bab9a18fadebf593031210957195414ce |

Phase 0 仅引用，不擅自合并、修改或重新解释冻结规格。

## 4. Phase 0 人工测试结论

测试素材与结果见：
- [Phase-0-Test-Assets.md](Phase-0-Test-Assets.md)
- [V9-Regression-Checklist.md](V9-Regression-Checklist.md)
- [V9-Known-Issues.md](V9-Known-Issues.md)
- [results/README.md](results/README.md)

关键结果摘要：

- A-001：识别、边界与外扩边界通过。
- A-002：真实像素接触/微光粘连可通过 Alpha 47 在已观察样本中分离；浅色亮度阈值对真实接触无帮助。
- A-003：纯透明原图加纯色半透明背景后可识别；渐变背景可通过 Alpha 调节范围，并结合手动切割、重叠分析与预览处理。
- A-004：提高 Alpha 可减少识别区域，但会损伤柔和光晕。
- A-005：最小区域面积可控制碎片数量；滑块缺乏精确输入。
- A-006：默认参数下四块分区牌合并；Alpha 调整至 47 后成功分离，判定调整后通过。
- A-007：自动识别与手工补框可组合完成；语义相关跳跃特效会被拆开，需人工修正。
- A-008：图层语义与远/中/近景层级应由 Agent 标注，不属于 V9 像素连通域自动识别。
- A-009：V9 任务包导出、Agent JSON 生成、导入往返成功。
- A-010：V9 实际 ZIP/Manifest 样本已产出；完整 ZIP 结构、CRC 与跨解压工具验证仍需单独完成。

用户另报告选区放大后精灵内容反而变得难以辨认，缩小时更清楚；作为待复现显示问题登记，不推断为缩放逻辑反向。

## 5. 证据边界与可信度

- 已核实：GitHub main 基线、V9 HTML Blob SHA/大小、Phase 0 分支及冻结规格文件。
- 已做：V9 HTML 静态源码/UI 盘点；用户人工执行 A-001～A-010 中相关测试并反馈结果。
- 仓库结果文件：A-009 任务 JSON、Agent 结果 JSON、提示词、原图、标注过程记录；A-010 V9 实际导出 ZIP。
- 未做或未完全做：完整 24 项通用回归、所有浏览器/操作系统组合、A-010 ZIP 深度完整性与跨工具兼容性、性能压力、自动化测试。
- 用户未提供的浏览器版本、操作系统和操作录屏不作推断。
- V9 源码/UI 中存在功能，不等于所有功能运行时通过。
- 静态风险不等于已复现 BUG。

## 6. Phase 0 收尾与保护边界

Phase 0 的目标是建立可追溯的 V9 基线、功能清单、已知问题、测试素材及首轮人工测试记录；不要求把 V9 所有 24 项回归全部测完。未完成的专项回归和风险已明确留档。

Phase 0 文档收尾后，下一阶段可按冻结 V1.5 规格启动 V10 实施。继续遵守：
1. 不修改 V9 HTML / V9 切割算法。
2. 不修改 main 基线。
3. 不修改三份冻结技术规格。
4. V10 新实现放在独立分支与独立文件中；任何规格冲突先登记，不擅自改写冻结规格。
