# Permission V2 Smoke — 扩展更新

这个仅用于开发的 `1.1.0` 包是 Permission V2 Smoke 的更新 fixture。它保留相同的公开命令探针，同时通过 Host 管理的生命周期验证包更新、权限 scope 扩展和 module generation 失效。

## 验证内容

- 新包可以替换较早的显式本地 fixture；
- Host 会为新的包 generation 重新计算权限；
- 旧 module generation 的权限不能穿透更新继续生效；
- Agent 事件与任务目录探针仍通过公开 broker 执行。

“已安装”或“已激活”不代表请求的能力已经获准。当前 generation 的真实结果应以 Manager 的权限与运行诊断为准。

## 当前边界

该包是未签名的更新 fixture，不是独立产品插件。它故意与 Permission V2 Smoke 使用相同 package id，以便在受控测试中验证替换行为。
