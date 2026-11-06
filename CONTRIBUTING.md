# 贡献指南

## 开发

使用 Node.js 24 和 Chrome／Edge 136+。固定版的版本号在 `src/version.ts` 中维护，构建配置和面板共同使用。

```sh
npm ci
npm run dev
```

从自动打开的本地页面安装开发脚本，再访问[拼多多订单页](https://mobile.pinduoduo.com/orders.html)。开发版与正式版只启用一个；更改开发端口后需重新安装。

Tampermonkey 和浏览器需允许官网连接本地 Vite 服务。若提示 `Permission was denied ... loopback address space`，在拼多多页面的站点权限中允许“回环网络访问”或“本地网络访问”，再刷新。详见 [vite-plugin-monkey 的说明](https://vite-plugin-monkey.pages.dev/guide/notes#local-network-access)。

样式支持即时更新；TypeScript／TSX 更新会重建面板、重置结果并中止收集。正式脚本仅匹配官网订单页。

正式构建与预览：

```sh
npm run build
npm run preview
```

产物位于 `dist/`，经 Prettier 排版，不提交到仓库。运行时依赖由 `vite.config.ts` 的 `externalGlobals` 加载固定版本的官方浏览器产物。安装时保留可选依赖，不使用 `--omit=optional`。

`src/pdd.ts` 处理协议，`src/collect.ts` 负责收集，`src/export.ts` 生成文件。`src/ui/` 使用 Preact 和 TSX，按收集、导出、弹层划分职责。表单拥有草稿，收集区域拥有任务与进度，入口将结果快照传给导出区域。

面板及独立 CSS 挂载到 Shadow Root，区域样式使用 `@scope`。优先使用原生表单和弹层，保留校验、回车提交、焦点及 Esc 行为；收起面板不停止任务。

## 测试

```sh
npm run check
```

完整检查包含格式、类型、构建和全部测试。可单独运行 `test:unit`、`test:integration`、`test:browser`；浏览器测试需先构建。

浏览器测试使用隔离 Chromium、官方 Tampermonkey 和合成响应，首次运行需要联网；可设置 `PLAYWRIGHT_CHANNEL=msedge` 改用隔离 Edge。失败截图和 trace 位于 `test-results/`。

业务回归案例见[样例约定](tests/fixtures/orders/README.md)。样例需脱敏并独立核对期望结果；真实订单、Cookie、UID、地址、手机号及 HAR 仅保存在本机忽略目录。提交说明中区分离线测试和登录官网核验。

CSV 防护公式前缀文本，JSON 仅保留解析后的订单条目数组。文件名使用收集快照的日期范围，未指定日期为“不限”，部分结果追加 `_不完整`；之后修改表单不影响已收集结果的文件名。

日期筛选遇到不能解析日期的订单编号时，保留订单并标记 `dateUncertain`。CSV 仅在存在此类条目时增加「日期核对」列，普通账单列保持兼容。收集中途失败也应交付已完成的条目，明确标为部分结果。

详情解析找不到有效数据时，协议层报告 `detail-unavailable`。收集层保留该订单，标记 `detailFailure: "unavailable"`，继续下一笔；不再按连续解析失败次数暂停。`"paused"` 仅用于兼容旧文件中尚未取得详情的条目。其他错误和取消继续向上传递。

`partial` 表示列表收集中断或达到页数上限；详情缺失由条目的 `detailFailure` 表示。面板分别说明两种情况，文件名相应使用 `_不完整` 或 `_详情不完整`。CSV 仅在存在失败标记时增加「详情状态」列。详情解析仍只读取 JSON 字面量，不执行页面脚本。

`src/resume.ts` 导入导出数组并生成缺失详情的逐笔更新。补齐只依赖 `getOrderDetail`，不调用 `getOrders`，不改动输入数组或已有详情。成功时只替换对应索引的缺失详情并删除失败标记；单笔 `detail-unavailable` 继续，其他错误与取消上抛。显式补齐不设连续解析失败暂停上限，仍逐笔调用现有请求层。

导入结果带 `imported: true`。JSON 数组没有日期和列表完整性元数据，因此结果区不推断这些信息，文件名用「导入订单_补齐详情」。导入本身不发网络请求；只有点击补齐按钮后请求详情。补齐期间持续发布完整数组快照；错误、停止或错误文件导入不得丢失已保存的结果。

固定版的四个运行时依赖使用已核对的 SHA-256，`downloadURL` 和 `updateURL` 均为 `none`。修改后从源码重新构建，不直接修改生成文件。

## 发布此 fork

版本号由 `src/version.ts` 维护。发布 tag 使用 `v` 加相同版本号，例如 `v2026-10-25.4`。同时更新 README 的固定版本安装链接。关闭自动更新后，用户需要手动安装新版本。

1. 核对源码、文档、测试样例及提交身份，排除真实订单、联系方式、登录信息、本机路径与账号运行记录。保留上游 MIT 许可和来源说明。
2. 使用 Node.js 24 运行 `npm run check`，从同一提交构建 `dist/pdd-order-export.user.js`。
3. 将代码推送到此 fork，从该提交创建 GitHub Release，上传构建脚本和 `SHA256SUMS`。不要提交 `dist/`。发布说明应区分合成数据测试和官网验证。
4. 启用 Actions 时，发布工作流重新检查并上传脚本及校验文件。核对最终附件与校验值，再提供安装链接。

此 fork 不同步到上游 Greasy Fork 页面。发布位置为 [GitHub Releases](https://github.com/PG2047/pdd-order-export/releases)。
