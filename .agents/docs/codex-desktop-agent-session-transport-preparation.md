# Codex Desktop Agent/Session transport 准备说明

`CodexDesktopAgentSessionTransport` 是 Host-only、版本钉死的 transport binding。它在
`app://-/index.html` 内使用现有 `sendMessageFromView` closure，但不向插件投影 preload
对象、native connection、MessagePort 或 raw envelope。

它只处理 allowlist command admission；native durable replay、完整 lifecycle 和
whole-agent idle 尚未经真实 App 验证，因此不把有限观察伪装为持久事实。所有可用观察只能
交给 `CordisXAgentSessionRuntime` 统一 append，不能建立平行 ledger。

Pin 或环境不符合时，Host 注入 unavailable transport，公开服务保持 fail-closed。该实现不
修改 Codex Desktop 安装包，不创建 Provider Fleet、local CLI 或第二个 app-server。
