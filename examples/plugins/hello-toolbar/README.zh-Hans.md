# 工具栏问候

Hello Toolbar 在工作区工具栏提供一个简单的问候操作。

这是最小的结构化工具栏插件：插件只提交本地化操作、Host 图标令牌与命令引用。
CordisX 负责 DOM、样式、提示、无障碍、排序、权限投影以及插件卸载时的清理。

插件没有用户配置。它仍显式导出空的 Schemastery
`Config = Schema.object({})` 与 `configApplies = 'plugin-restart'`，因此
Manager 可以诚实地显示只读的“没有可编辑设置”状态，而不会制造无意义开关。

从仓库根目录运行：

```bash
npm run dev -- --config cordisx.config.hello-toolbar.json
```

该示例是受信任的本地 renderer 代码，不是隔离进程或安全沙箱。
