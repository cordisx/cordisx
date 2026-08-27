# Lifecycle Smoke

Lifecycle Smoke 是仅限本地使用的包 fixture，用来在隔离 renderer 中验证 CordisX
v1 包生命周期。它贡献一个结构化 route、page、command 与侧栏项。全局计数器记录
`apply`、`dispose` 和命令调用，因此 smoke 可以验证所属 fiber 的重新加载与完整卸载
清理。

route 与 page 分别提供真实的英文和简体中文 `title` 与 `description`：route 说明
侧栏入口如何打开 fixture，page 说明导航后可见的生命周期状态。path、outlet、page
ID 与 chrome 都是不翻译的机器 metadata。

在 Manager 中选择 **插件 → 安装本地插件**，然后安装该目录的绝对路径。权限审查
会显示一个可选的 `models.read` 声明；fixture 激活并不依赖该权限。

该 fixture 不演示远程下载、包签名或安全沙箱。其规范来源是公开地址，不包含本地
路径、配置或凭据数据。
