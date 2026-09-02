# Codex Desktop Agent/Session Runtime 本地候选

一句话结论：Host 只有一个 `CordisXAgentSessionRuntime`，它是 Agent、Session、
`SessionEvent`、admission、approval、cursor 与 replacement fence 的唯一 authority；
Desktop 与 Playground 只是由 Host composition 注入的 transport。

## 运行模型

插件只消费 `ctx.agents`、`ctx.sessions` 与 `ctx.approvals`。它们得到的是 owner 与
plugin generation 绑定的 Agent handle、Session reader/subscription 与 approval service，
不会得到 transport、native connection、MessagePort、preload bridge、operation id 或 raw
payload。

`CordisXAgentSessionRuntime` 负责把 transport 的观察结果 append 成同一条 append-only
`SessionEvent` log，并以 cursor-pinned snapshot/read 和 atomic replay-to-live subscription
提供读取。命令面的 `create`、`resume`、`submit`、`discard`、`cancel` 只报告 admission；
assistant message、tool fact、approval asked/decided 与 turn terminal 都由同一 Session
event authority 写入。whole-agent idle 未被 native transport 证明时返回
`whole-agent-idle-unobservable`，不伪造 whole-Agent idle。

## Transport 注入与边界

生产 composition 在当前 Codex Desktop 的 `app://-/index.html` 内尝试注入版本钉死的
`CodexDesktopAgentSessionTransport`。它只捕获现有 `sendMessageFromView` closure，以
allowlist 发出 `model/list`、`thread/start`、`thread/resume`、`turn/start`、
`turn/interrupt`；pin、bridge 或运行环境不满足时注入 unavailable transport 并 fail-closed。
不会修改 Desktop 安装包、启动第二个 app-server、Provider Fleet 或 local CLI。

Playground composition 自动注入同一 transport contract 的 deterministic transport。它只为
开发产生可预测的 assistant、tool 与 approval 事实，所有事实仍由同一个 Runtime append；
不会创建第二条 ledger 或 compatibility facade，也不会启动 Provider Fleet、local CLI 或
第二个 app-server。插件、manifest、permission plan/decision/lease 与 `SessionEvent` 不分支。

## 目前状态与权限缺口

已实现：一个 Runtime authority、private transport contract、owner/generation/session/
connection fences、first-terminal subscription closure，以及 deterministic transport 的
create/resume/get/send/discard/cancel/live observation/approval seam。

未验证：真实 Desktop 的 notification/request 语义、持久 replay、whole-agent idle，及真实
App 的端到端验收。当前 native transport 只将已审计的 response 当作命令 admission；尚无
可靠 notification 证据时不会将其编造成 `SessionEvent`。

正式权限接线仍等待 PermissionBroker 的 `authorizeAgentRuntime`、route/connection fence
与 Host-only development policy seed API。接线前 production runtime 保持 deny-by-default；
开发 policy 必须来自 Host-only opaque authority，使用每次调用的单一 exact SessionId，不能
由 plugin、route 参数、wildcard 或 metadata grant 直接授权。

当前 Chatroom 集成身份固定为 `org.cordisx.chatroom` 与同插件动态 route
`room-session-detail`（`/main/chatroom/:roomId/run/:runId/session/:sessionId`）。`resume`、
`get`、send/cancel、live 与 Session read/subscribe/approval 都只能从当前 active route
解析一个 exact `sessionId`。`agents.create` 使用由 Host 预留、尚未创建的稳定 SessionId；
它必须经 PermissionBroker 的 `host-create` authority 生成精确 lease，不能由 manifest
`scope: {}` 或调用方参数直接获得授权。

## 核心文件

- `packages/cli/src/renderer/agent-session-runtime.ts`：唯一 authority 与公开服务投影。
- `packages/cli/src/renderer/codex-desktop-agent-session-transport.ts`：版本钉死 native transport。
- `packages/cli/src/renderer/deterministic-agent-session-transport.ts`：开发 deterministic transport。
- `packages/cli/src/renderer/runtime.ts`：只按 Host composition 注入 transport。
- `packages/cli/src/renderer/agent-route-session-scope.ts`：动态 exact Session scope 的 Host-private 辅助层；将由 PermissionBroker API 接管 decision/lease。
- `tests/agent-session-runtime.test.ts`、`tests/deterministic-agent-session-transport.test.ts`、`tests/agent-route-session-scope.test.ts`：focused 行为覆盖。

真实 App 验收仍需确认：native transport 的版本探针、create/send 后同源 event
append/replay-to-live、approval response、route/plugin/permission/connection replacement closure，
以及 raw bridge 未投影到插件。
