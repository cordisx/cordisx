# 插件控制台展示

Plugin Console Showcase 是仅用于开发环境的 fixture，用来验证插件详情中的
**运行状态** DevTools Console。

它调用原生可变参数 `console.*` 方法，并执行一次成功的同步 Host capability 与
一次需要权限的 Platform 调用，以便检查日志来源、参数投影和权限结果。

按插件隔离的 console 只是补充视图。Host API 记录由 capability aspect 生成，
不是由插件伪造。该 fixture 不提供用户配置、外部连接或持久化日志，也不是安全
沙箱。
