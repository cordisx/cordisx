# Slot Showcase

这是 CordisX 的结构化 UI 端到端演示插件。它通过 `ctx.commands`、`ctx.routes`、`ctx.pages` 与 DSH 风格的 `ctx.slots.register` 提交数据；shell DOM、交互、排序、无障碍与清理由宿主统一负责。

## 展示内容

- 侧栏底部控件前、后及菜单项
- 主导航行及不会冒泡到主行为的独立快捷操作
- workspace toolbar 语义锚点前、后及菜单项
- 环境信息 panel header action、section、section action、row 与 trailing action
- `app`、`main`、`session.content` 三类 page outlet
- 英文/简体中文词典、动态消息参数与 locale 重新投影

## 配置示例

```json
{ "sessionId": "当前原生会话 ID（可选）" }
```

屏蔽插件会销毁当前 Cordis fiber、撤销贡献并 Abort/dispose 活跃页面；恢复插件会从同一个可信本地 bundle 创建新的 generation。页面 mount 属于 trusted-local 受控 DOM，不是权限沙箱。
