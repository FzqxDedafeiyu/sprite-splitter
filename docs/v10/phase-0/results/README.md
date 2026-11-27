# Phase-0 测试结果（2026-11-26）

对应 [Phase-0-Test-Assets.md](../Phase-0-Test-Assets.md) 的 **A-009 / A-010**，并与 Set A 里的 **A-008** 构成同一条链路（同一张 1672×941 场景：切分 → Agent 标注 → 导出）。

| 目录 | 对应 | 内容 |
|---|---|---|
| `A-009-agent-json-roundtrip/` | A-009 | V9 导出的 Agent 任务包 + 回填结果 + 过程记录 |
| `A-010-v9-export-check.zip` | A-010 | V9 实际导出的场景 ZIP（30 个精灵 + manifest） |

## A-009 · Agent JSON 往返

| 文件 | 说明 |
|---|---|
| `agent_task.json` | `spatial-scene-agent-task/v2`，30 个候选，source 1672×941 |
| `agent_result.json` | `spatial-scene-agent-result/v2`，30/30 全部返回；远景 17 / 中景 8 / 近景 5；5 个 `needs_review` |
| `AGENT_PROMPT.txt` | 导出任务包时生成的约束说明（10 条） |
| `source.png` | 标注用的原图，1672×941，与 Set A 的 A-008 是同一张 |
| `标注过程记录.md` | 完整标注过程：怎么验证"不能靠 alpha 自动分离"、锚点怎么取、zIndex 依据、自检清单 |

**用途**

1. 把 `agent_result.json` 导入 V9，验证 `sprite_id` 对应、名称/分类/描述/tags/confidence/review_status 的回写；
2. 作为 V10 迁移器 Agent 适配层（v2 协议）的输入样本；
3. 对照 `标注过程记录.md` 检查"只改语义、不动几何"的约束是否被遵守。

## A-010 · V9 实际导出

- `format: spatial-scene-layout/v2`，`canvas 1672×941`，30 个 sprite，层级 **17 远 / 8 中 / 5 近**；
- 中文文件名（UTF-8）与 manifest 的 `file` 字段一一对应；
- 全部是 `rectangle`，没有 polygon —— 要测多边形路径得另建样本。

**用途**

1. 作为 V10 迁移器的输入基准：ZIP 解压、UTF-8 文件名、manifest schema、PNG 与字段的对应关系；
2. 校验 `sourceRect` 宽高与实际 PNG 尺寸一致（这条在 V10 里是硬校验）；
3. 回灌 V9 做兼容性对拍。

## 备注

- 三份产物都是 2026-11-26 的 Phase-0 基线验证中产出，不是手工编造。
- `标注过程记录.md` 里的本机路径已替换为占位符（`<workspace>` / `<dsh>` / `<system-temp>`），其余内容原样保留。
- A-009 的标注结果里 `slug` 字段按协议保留，但 V9 导入器不写入该字段——这是已记录的行为，不是缺陷。