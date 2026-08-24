# Settings Navigation Demo

这是 `manager.settings.navigation-items` 与 `manager.content` 的真实端到端演示：插件只提交一个 route 引用和稳定分组/顺序；CordisX 统一渲染左侧一级入口、图标、选中态、键盘行为、面包屑与标准页面页头，并只将页头之下的受控 body container 交给插件 page mount。

演示固定使用 `/manager/extensions/settings-tab-demo`、`chrome: 'standard'` 与 `manager.content`。route/page 都提交中英文 `title` 与 `description`，但显示文案和图标来自 Host 对这些结构化 metadata 的投影；插件不会取得导航 DOM、header seat、manager 根节点或 Codex selector，也不会注入任意 HTML、SVG 或 CSS 字符串。插件被屏蔽、权限被拒绝、generation 被替换或 Manager 关闭时，活跃 mount 会先收到 Abort，随后 dispose。

`manager.settings.tabs` 与 `manager.settings.content` 仍保留为兼容契约，供显式挂载 Settings 页的 Host 使用；当前 Manager IA 不挂载一个全局“配置”产品页，因此该兼容 point 会保持 `not-mounted` 诊断而不会产生可点击的空 Tab。

页面 mount 是 trusted-local renderer code，不是进程或安全沙箱；插件访问 Platform/Agent 等服务仍须经过现有权限系统。

插件导出 Schemastery `Config` 与 `configApplies = 'plugin-restart'`。`demoValue` 是 1–64 字符的真实用户选项，默认值为 `CordisX`；它属于插件运行时配置，保存后只重建本插件 fiber。启动时冻结的 executable、debugPort、profile 与启动环境不属于这个 Manager 页面。

从仓库根目录运行：

```sh
npm run dev -- --config cordisx.config.settings-demo.json
```
