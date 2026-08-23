# Slot Showcase

这是 CordisX 的五扩展点演示插件。它使用与 DSH 一致的 `slots` 服务，展示一个插件如何随 Cordis fiber 一起挂载、卸载和恢复。

## 展示内容

- `header.actions`：顶部的 CX Demo 开关
- `composer.before`：输入框前的 Prompt Lens
- `composer.after`：输入框后的运行状态
- `sidebar.footer`：侧栏底部的扩展点计数
- `shell.overlay`：可开关的页面级浮层

## 配置示例

```json
{
  "accent": "#8b5cf6",
  "label": "CX Demo",
  "open": true
}
```

屏蔽插件会销毁当前 Cordis fiber 并撤销以上贡献；恢复插件会从同一个可信本地 bundle 创建新的 fiber。
