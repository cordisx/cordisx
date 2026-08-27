# Permission V2 Smoke

Permission V2 Smoke 是仅用于开发的 Host 权限代理探针。它注册两个命令，用来请求公开的 Agent 事件和任务目录操作；它不会实现私有权限弹窗，也不会绕过拒绝策略。

## 探针

- `probe-agent-events`：使用固定的 smoke-test session id 查询公开 Agent event ledger。
- `probe-tasks`：从 `codex` 提供方目录请求一条任务。

两个命令都只适合受控开发 fixture。命令注册成功不代表能力已获准，也不代表底层提供方可用；实际结果应以 Manager 的权限与运行诊断为准。

## 当前边界

该包是显式本地加载、未签名的 smoke fixture，不是面向用户的插件，也不能进入 CordisX 默认配置。
