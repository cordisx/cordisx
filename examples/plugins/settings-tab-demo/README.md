# Settings Tab Demo

这是 `manager.settings.tabs` 与 `manager.settings.content` 的真实端到端演示：插件提交结构化标题、Host icon token、稳定顺序和本地 route；CordisX 统一渲染 Tab header，并只把 `role=tabpanel` 内部的受控 body container 交给插件 page mount。

演示固定使用 `/manager/settings/settings-tab-demo` 与 `chrome: 'body-only'`。它不会取得 header seat、manager 根节点或 Codex selector，也不会注入任意 HTML、SVG 或 CSS 字符串。插件被屏蔽、权限被拒绝、generation 被替换或 manager 关闭时，活跃 mount 会先收到 Abort，随后 dispose。

页面 mount 是 trusted-local renderer code，不是进程或安全沙箱；插件访问 Platform/Agent 等服务仍须经过现有权限系统。

从仓库根目录运行：

```sh
npm run dev -- --config cordisx.config.settings-demo.json
```
