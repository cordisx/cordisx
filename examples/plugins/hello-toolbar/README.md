# Hello Toolbar

在工作区工具栏提供一个简单的问候操作。

这是最小结构化 toolbar 插件：插件只提交本地化 action、Host icon token 与 command 引用，CordisX 拥有 DOM、样式、tooltip、无障碍、排序、权限和卸载清理。

插件没有用户配置。它仍显式导出空的 Schemastery `Config = Schema.object({})` 与 `configApplies = 'plugin-restart'`，因此 Manager 能稳定显示只读“没有可编辑设置”状态，而不会制造无意义开关。

从仓库根目录运行：

```sh
npm run dev -- --config cordisx.config.hello-toolbar.json
```
