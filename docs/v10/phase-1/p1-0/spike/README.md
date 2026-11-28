# P1-0 验证复现

本目录是技术验证原型。生产入口和 V9 的交付文件保持原样。

- 使用 Node 24，执行 `npm ci`、`npm run check`、`npm test` 和 `npm run build`。测试默认从仓库根目录读取 V9 HTML，也可通过 `V9_HTML` 指向已校验的本地基线。
- ZIP 回归使用 Phase 0 的 `docs/v10/phase-0/results/A-010-v9-export-check.zip`。执行 `node verify-zip-roundtrip.mjs <V9 HTML> <A-010 ZIP> <新 ZIP>`。装有 Pillow 时，可对原 ZIP 和新 ZIP 执行 `python check_zip.py <ZIP>`。
- 在独立配置的 Edge 中用 `file://` 打开 `offline.html`。页面输出 JSON，覆盖 IndexedDB 事务回滚、Worker 和 Canvas/PNG。自动读取时可启动带 `--remote-debugging-port=0` 的隔离 Edge，再运行 `node browser.mjs <该配置目录> <HTML 绝对路径>`。
- OpenCV 取自固定的 [4.12.0 文档构建](https://docs.opencv.org/4.12.0/opencv.js)。执行 `node make-opencv-probe.mjs <opencv.js> <输出 HTML>`，脚本会检查 SHA-256。用独立 Edge 配置屏蔽外部域名后打开生成文件，复核 `pixels: [1, 0]` 与 `cancelledBeforeFinish: true`。依赖和生成的 HTML 不入库。

