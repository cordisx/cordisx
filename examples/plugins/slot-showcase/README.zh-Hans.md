# 点位展示

Slot Showcase 在插件管理器中展示 CordisX 扩展点、导航、页面与状态交互。

这是结构化 UI 的端到端示例。它通过 `ctx.commands`、`ctx.routes`、
`ctx.pages` 与 DSH 风格的 `ctx.slots.register` 提交数据；Host 统一负责
shell DOM、交互、排序、无障碍与清理。

## 展示内容

- 侧栏底部控件前、后及菜单项。
- 主导航行及不会冒泡到主行为的独立快捷操作。
- workspace 工具栏语义锚点前、后及菜单项。
- 环境信息面板的页头操作、section、section 操作、row 与尾部操作。
- `app`、`main`、`session.content` 三类页面 outlet。
- 每条 route/page 的英文与简体中文产品标题和说明，包括用途、入口与目标区域。
- 动态消息参数与 locale 重新投影；路径、outlet、参数和稳定 ID 保持机器值。

Manager 的“路由”详情会将三类 route 与 page 分组展示，并使用当前 Host locale
投影说明。`app.overview` 从侧栏底部或演示设置入口打开应用级概览；
`main.analytics` 从导航行、工具栏或会话页头打开工作区分析；
`session.analytics` 在配置原生会话 ID 后打开当前会话正文分析。插件只声明结构化
`LocalizedText`；Host 负责列表 DOM、搜索、诊断和无障碍。

## 配置

```json
{ "sessionId": "原生会话 UUID，不含 local: 前缀" }
```

插件导出 Schemastery `Config` 与 `configApplies = 'plugin-restart'`。
`sessionId` 最长 128 个字符；留空时不显示会话分析快捷操作，匹配当前选中的原生
会话时，该操作导航到受控的 `session.content` 页面。保存配置只重建本插件 fiber。

屏蔽插件会销毁当前 Cordis fiber、撤销贡献并 Abort/dispose 活跃页面；恢复插件会从
同一个受信任本地 bundle 创建新的 generation。页面 mount 属于受信任的本地受控
DOM，不是权限沙箱。
