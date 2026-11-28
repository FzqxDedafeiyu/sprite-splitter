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

## P1-2 交互基础与浏览器回归

`coordinates.ts` 集中处理视口、DPR、旋转/缩放与命中，以及 Source Trim、Clip 校准和 Atlas Trim 的转换。绘制与命中共用矩阵。命中测试跳过隐藏、锁定及透明像素对象，Z 值相同使用绘制顺序，控制柄半径以 CSS 像素计。

`interaction.ts` 是主指针与手势草稿的唯一拥有者，只发布手势类型和是否交互。成功释放指针时产生一个命令请求，取消、失焦、丢失 capture 与卸载均清理草稿。`workspace-lifecycle.ts` 在工作区切换、换工具、导入和自动识别时取消手势及旧异步任务。

`reactive-store.ts` 将项目、UI、交互摘要和播放状态分别发布。组件使用只读视图和 selector。未变化的子对象保留引用，临时 UI 变化无需推进项目版本。

使用 Node 24，在 P1-0 spike 目录执行一次 `npm ci`，设置 `V10_BROWSER` 为 Chromium 或 Edge 路径，然后从仓库根目录执行 `node v10/tests/run-browser.mjs`。可用 `V10_SPIKE_PACKAGE` 指向另一个装好依赖的 P1-0 package.json，用 `V10_BROWSER_ARTIFACTS` 把临时配置指到工作目录。运行器使用本机回环地址和全新浏览器配置。已在 Edge 验证原生 pointer capture、取消、订阅分区、两个真实标签页争用以及刷新回读。

当前阶段提供运行时与自动化测试页面。生产工作区、各工具的具体 draft 命令以及多点闭合多边形仍需在编辑器接入时完成。

## P1-3 首批命令

`command-bus.ts` 开始接管素材基础属性更新。创建命令时从单一快照捕获实体和 Project 版本。多素材编辑提交一个事务，验证失败时整体拒绝。仅当绝对属性赋值的目标版本完全不变时，对无关 Project CAS 冲突重试一次。实体和资源冲突不重试。持久化成功后才向 Store 发布。已验证中文属性批量更新、无关提交后的安全重试、旧目标版本冲突、重复 dispatch 和空操作。

当前命令入口仅支持名称、分类、说明和旧版分组标签。事务撤销重做、CompositeCommand、几何与资源命令仍属 P1-3 后续工作。
