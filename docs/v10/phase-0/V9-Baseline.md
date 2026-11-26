# V9 Baseline — Phase 0

> 状态：初始静态基线记录（待用户审阅）
> 检查日期：2026-11-26
> 基线来源：GitHub 实时仓库数据；未执行浏览器运行验收

## 1. 仓库与分支

- Repository：`FzqxDedafeiyu/sprite-splitter`（Public，未归档）
- 默认分支：`main`
- 检查时 main HEAD：`473931a1109d118f1acfb3c4d91f349f2ac22873`
- HEAD 提交：`README：Agent JSON 协议改为 spatial-scene-agent-result/v2（v1 仍兼容）`
- 检查时冻结规格分支：`docs/v10-technical-blueprint`
- 冻结规格分支 HEAD：`6a090f73bad0cccc060b5607f67f5acf656b8676`
- Phase 0 工作分支：`v10/phase-0-baseline`，从检查时 main HEAD 创建；不修改 main。

分支比较（base=main，head=docs/v10-technical-blueprint）：
- 状态：diverged；冻结规格分支 ahead 37、behind 1。
- 比较结果列出的文件差异仅为三份新增 V1.5 规格文档。
- 两分支共同祖先：`48723076d30a0a41fff544b465ed592e319df034`。
- main 的 1 个独有提交更新 README 中 Agent 协议描述。
- 冻结规格分支不包含 main 最新 README 更新；本 Phase 0 分支以 main 为基底，冻结规格通过分支引用，不擅自合并或改写。

## 2. V9 主文件基线

文件：`精灵图切分编辑器_V9_分组批量属性与中文导出版.html`

- 路径：仓库根目录
- main 基线 commit：`473931a1109d118f1acfb3c4d91f349f2ac22873`
- Blob SHA：`e37512e24202892804649201580d71c6ee6df018`
- GitHub tree 报告大小：85,998 bytes
- Git mode：`100644`
- 主程序标题：像素精灵图切分编辑器 V9
- 源码文本：约 79,315 个字符、838 行（Git blob 元数据的 85,998 bytes 为权威大小）。

在 `docs/v10-technical-blueprint` 分支的同路径文件 Blob SHA 相同，故该文件在两个分支的内容一致。当前没有修改 V9 HTML 的操作。

相关文件：
- `精灵图切分编辑器_V9_使用说明.md`，Blob SHA `cbb11555ebfab597c0b14577cb6de5317b4d09ea`
- `README.md`，main Blob SHA `689aba6d44d21b1b65bf89a8bbaab742934088e8`

## 3. 冻结规格

以下文件均在 `docs/v10-technical-blueprint` 分支存在，头部原文均标明 V1.5 与 Frozen Implementation Baseline：

| 文档 | Blob SHA |
|---|---|
| docs/v10/01-总体架构与模块迁移方案.md | 8d6e353b9ebf33a6b6843eafc0c66c0a2e9d3477 |
| docs/v10/02-Animation-System-技术规格.md | b3a20eed53b39dee5855e96a917ce3dcfbb1ca3a |
| docs/v10/03-Interaction-Manager与Reactive-Store技术规格.md | 9ff5659bab9a18fadebf593031210957195414ce |

冻结规格分支最新提交：`6a090f73bad0cccc060b5607f67f5acf656b8676`，提交说明 `docs(v10): enforce revision ledger consistency V1.5`。

## 4. 基线边界与可信度

- 已核实：GitHub 当前默认分支、HEAD、分支列表、V9 HTML blob/size、冻结分支存在、三份规格的 V1.5 头部与 blob SHA。
- 已做静态源码审查：V9 HTML 的 UI 控件、主要函数、事件处理、导入/导出实现。
- 未做：浏览器实际启动、真实图片处理、下载 ZIP 解压校验、跨浏览器测试、自动化测试。
- 本文所述功能存在性来自源码和 UI，不等于运行时验收通过。
- 当前仓库未发现自动保存实现（未检出 localStorage / IndexedDB / sessionStorage 引用）；刷新后数据是否保留不应被假设。
- 不应将此基线视为已通过功能回归测试。

## 5. 保护要求

Phase 0 期间禁止修改上述 V9 HTML、V9 算法及 main。后续文档只记录检查事实、风险和测试计划。任何基线文件变化都必须重新核对 commit、blob SHA 与文件大小，并暂停原基线结论。
