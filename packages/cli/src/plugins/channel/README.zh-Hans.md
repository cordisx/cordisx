# 渠道

Channels 是 CordisX 面向 launcher 所有消息连接的产品界面。它贡献结构化 Manager
导航记录和同一 owner 的标准页面 route，并通过版本化的
`channel-service-config/v1` Host Schema 声明一个 Node 侧 `channel-adapter` 服务。

## 当前状态

- **已实现：** 不可变的打包服务产物会经过校验、bundle、stage、完整性检查、权限
  投影，并加载到 generation 绑定的 Node Cordis context。
- **已验证：** 本地模拟器覆盖激活与 dispose；官方飞书/Lark WebSocket adapter 与
  共享 Host 服务配置 API 已通过自动化测试，覆盖 `service-restart` CAS、不透明
  handle 保留、脱敏和 last-good 发布。
- **已实现且已验证：** 有界 Host body renderer 提供固定的可搜索频道卡片列表、
  Host 所有的 candidate-only 创建流程，以及通过 `manager.content` 展示的配置、
  日志、连接与会话详情。Host 负责导航、表单、主题、无障碍和清理，并且绝不投影
  `secretRef` 或凭据材料。
- **实验性：** renderer 只接收启动时的 Channel 投影，不是持续 transport 或实时
  连接 feed。
- **尚未验证：** 真实飞书/Lark 账号连接与消息 smoke。自动化 adapter 验证不等于
  用户账号会话证据。
- **不可用：** 凭据创建 broker 与企业微信 adapter。
- **计划中：** 真实账号 smoke 证据和生命周期连接的实时 renderer 投影。

renderer module 没有用户配置字段。只有账号连接配置属于 launcher 服务声明。封闭
manifest 的 `restart` 值映射为 Host 精确的 `service-restart` 平面，并公开 Host
所有的 Schemastery descriptor；任务映射、模型、工作区、通知、重试策略与任务分发
属于独立 consumer 插件。没有配置的服务必须声明 `configuration.kind: "none"`；
CordisX 不会创建占位字段。

凭据是不透明 Host handle，绝不能出现在插件配置、renderer 状态、日志、Manager
snapshot 或本 README 示例中。

Manager 不会仅凭应用标识符声称已经连接。凭据保持在 Host；只有独立验证的连接路径
产生真实账号或消息结果后，界面才会展示该状态，绝不会从配置推断连接成功。

## 插件间消息 facade

Launcher 侧 Cordis 插件可以请求高级 `ctx.channel` 服务：

- `ctx.channel.connections.list()` 返回经过权限 broker 的安全连接状态；
- `ctx.channel.messages.subscribe()` 订阅带来源绑定的入站用户消息；
- `ctx.channel.messages.send()` 发送经过审计的出站通知并返回 delivery handle；
- `ctx.channel.adapters.register()` 注册运行在 launcher service Host 内的 adapter 包。

该 facade 保留 package source、plugin ID 和 generation 身份。consumer 插件不会得到
raw transport、凭据、队列、store 或 adapter 连接对象。远程消息始终是带来源的
`role: "user"` 输入，不能变成 system 或 developer prompt。

产品 bundle 将所有操作 capability 声明为可选，因此服务权限被拒绝时仍可查看只读
Settings 诊断。每项服务操作仍会在 broker 处 fail closed。未来真实 adapter 包可在
其明确的账号、tenant、conversation、provider、workspace 或 session scope 内，把
所选 transport 和配置 route 必需的 capability 标为 required。

## 身份与可靠性

账号使用 `adapterId + accountId + tenantId`。thread 额外使用
`conversationId + threadId`，任务绑定使用复合 `providerId + remoteSessionId`；
显示名称和偶然相同的远程 ID 绝不会合并这些身份。

delivery 是至少一次语义，包含持久 inbox/outbox 记录、event ID 幂等、重试/退避、
dead letter、cursor checkpoint、重启恢复、generation fencing 与 last-good revision。
CordisX 不声称 exactly-once delivery。

## 真实平台边界

内置服务支持本地模拟器和官方飞书/Lark WebSocket adapter。adapter 使用官方平台
API 和 Host 持有的凭据，但真实账号/消息 smoke 尚未验证。企业微信仍不可用。
个人微信客户端逆向、非官方 hook、伪造订阅与 renderer 所有的 Web server 均不在
范围内。
