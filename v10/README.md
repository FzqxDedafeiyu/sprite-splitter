# V10 P1-1 · 项目与资源持久化基础

本提交从 P1-0 技术验证分支继续，新增 `v10/` 模块。V9 入口和既有导出协议保持原样。

- `domain.ts` 按 V1.5 定义项目、场景、资源和动画类型。项目文档持有唯一的素材集合，按 ID 的查询与 Clip 反向索引由 selector 派生。
- `project.ts` 检查版本台账、身份、主要领域引用以及包内资源路径。旧 ID 和扩展字段随文档原样存储。新项目从 revision 1 开始。
- `project-store.ts` 使用同一 IndexedDB 事务提交 Project、资源版本和 staging lease。暂存时计算 SHA-256，保存时检查实体、资源及 Project 预期版本，读取时验证活动资源的长度和摘要。删除推进 tombstone 水位；过期 staging 可按 24 小时清理。
- `mask.ts` 使用 SSM1 位图协议。12 字节头包含四字节 ASCII 魔数和两个小端 UInt32 尺寸字段，其后每像素一个不透明度字节，逐行存储。新增裁切区域填 255，从原图坐标重叠区复制旧像素。原始 PNG Alpha 独立保存。

## 验证

TypeScript 严格检查通过。在 Edge 中运行真实 IndexedDB browser 测试，覆盖创建、关闭连接后重开、PNG 与 Mask 读取、裁切蒙版映射、损坏引用、错误尺寸回滚后以同一版本重新提交、两个独立连接争用、三种冲突分类、删除水位和暂存清理。

复现时可用 P1-0 原型的锁文件环境。以 `tests/project-store.browser.ts` 作为 esbuild 浏览器 bundle 入口，将 bundle 内联至带 `<pre id="result">` 的 HTML。浏览器打开后查看 JSON，也可用 P1-0 的 `spike/browser.mjs` 读取结果。

## 剩余边界

当前模块还未接入编辑器或项目包导入导出。V9 迁移实现、跨标签页 UI、正式应用刷新恢复、Command / History、撤销重做时的 tombstone 恢复以及无引用资源回收仍待接入。当前存储拒绝普通 Create 重用 tombstone ID。SSM1 是本轮实现的 bitmap 线格式，RLE 仍待协议和解码支持。已知几何的 Mask 映射已可测试，未知几何的用户选择由后续命令和编辑器接入。
