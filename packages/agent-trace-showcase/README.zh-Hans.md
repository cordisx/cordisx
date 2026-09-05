# CordisX Agent Trace Showcase

Agent Trace Showcase 是用于开发与验证的插件，用来检查 CordisX Agent 会话如何演进。它从当前 Codex 会话标题栏打开会话范围内的时间线，不替换原会话、不改变应用 URL，也不接管 Codex 的 UI 节点。

标题栏图标由 Host 渲染。按下状态来自当前精确的 session route，而不是插件内部状态：单击打开，再次单击或在时间线中按 Escape 关闭。时间线正文直接从保留的原生会话标题栏下方开始，不会再添加一行 CordisX 标题或关闭按钮。

插件分别发布本地化的 route-v2 和 page-v3 元数据。路由文案说明会话标题操作会为当前会话打开 Agent Trace；页面文案说明时间线包含该 Agent 会话的输入、模型、工具、投递和 prompt contribution 事件。规范路由/页面 id、路径、outlet 与页面引用均保持不翻译的机器身份。这些元数据不会给予插件 Manager DOM 或自由渲染器权限。

## 时间线

时间线按 turn 和 step 分组，并投影四条泳道：

- **输入**：观测到的用户输入；
- **模型**：模型生命周期与输出记录；
- **工具**：工具和命令活动；
- **注入 / Prompt**：插件投递与 prompt contribution。

序列视图、时间视图、搜索、来源/类型/阶段过滤、记录详情，以及有上限且可配置的时间线窗口，使较大的会话仍可检查。页面区分观测事实、CordisX 产生的事实与推断事实，并展示当前 adapter 能力和数据完整度。除非公开事件契约提供证据，否则投影或转发的记录绝不会被描述成“模型已消费”。

## Fixture、实时与历史模式

Fixture 模式使用一个集中、确定性的 provider。它可以在不读取或修改真实会话的前提下演示完整时间线交互和权限状态。Fixture 记录会明确标注，不能与实时 Agent 事件混淆。

实时模式只读取公开的、会话范围内的 Agent event ledger。当 Host 有公开 ledger，但当前 Codex 连接无法转发 Agent 消息时，它可能只展示部分历史。它不会回退到原始 bridge、私有 adapter store、DOM 选择器或并行 trace ledger。

历史模式通过 Host 代理的 `agent.history.read` 服务，把所选 Codex 会话的本地 JSONL 投影到同一时间线。插件和渲染器都不会获得文件系统访问权或原始路径。导入记录标记为 `historical/imported`，使用稳定的不透明 provenance，遵守 Host 最高 500 条范围内的页大小，并与重叠的实时观测去重合并。尾部更新保持增量，因此较早的会话可以继续进入当前实时窗口。

历史数据的证明能力受证据约束。它可以证明源 JSONL 中出现的消息、工具、内容、时间、session/turn 与压缩事实，但不会虚构权限决策、CordisX 投递或 prompt contribution 阶段、成功转发或模型消费。损坏/截断行和不完整索引会显示为覆盖不完整诊断，而不是合成事件。

该插件仅用于开发且需显式启用；CordisX 初始化仍会创建空的 `plugins: []` 配置。

## 配置

插件导出由 CordisX Manager 消费的标准 Schemastery `Config` schema。配置在插件重启时应用，因为切换数据源会把 session provider、订阅、历史 cursor/尾部定时器和插件拥有的待处理 contribution 作为一个由 fiber 管理的生命周期整体替换。

| 设置                 | 默认值 | 可选值                          | 用途                                                                            |
| -------------------- | ------ | ------------------------------- | ------------------------------------------------------------------------------- |
| `mode`               | `live` | `live`、`historical`、`fixture` | 选择公开实时 ledger、Host 代理的历史记录与实时观测合并，或确定性 fixture 数据。 |
| `historyPageSize`    | `100`  | `25`–`500`，步长 `25`           | 每个不透明 Host 页面请求的历史记录数，仅历史模式使用。                          |
| `timelineWindowSize` | `500`  | `50`–`500`，步长 `50`           | 限制当前时间线投影保留的合并记录数。                                            |

`live` 不请求本地历史；`historical` 在同一个去重时间线中合并导入证据与公开实时观测；`fixture` 保持确定性，不能指向自行配置的 session identity，页面始终由 Host 绑定到当前活动会话。

Session/provider/profile 身份、本地路径、契约版本、payload 脱敏、tail 周期、诊断、secret 和权限策略都不是普通插件设置，它们仍是 Host 拥有且受 capability scope 约束的决策。

## 显式 Agent 演示

插件加载、页面打开或会话切换时都不会自动注入。每项操作都需要用户明确点击：

- **Followup**：为下一个 turn 排入一条会唤醒的消息；
- **Steer**：为下一个 step 排入一条会唤醒的消息；
- **Inject**：为下一个 step 排入一条不会唤醒的消息；
- **Pre-step append**：注册一次性、带来源的 append handler；
- **Prompt section**：注册具名 system prompt section；
- **Prompt context**：注册 session 范围内的 system prompt context。

排队投递使用带 owner 和 generation fence 的公开 handle 执行取消和 `clearPending`。Pre-step 与 prompt contribution 通过公开 disposable 移除。切换/按 Escape 关闭、插件 block、generation 替换和 fiber dispose 都会清理入口、路由、订阅及待处理 contribution。

## 权限与如实可用性

实时和历史模式声明五项可选能力，全部由 Host Permission Broker 执行：

- `agent.events.read`；
- `agent.history.read`；
- `agent.messages.append`；
- `agent.prompt.section`；
- `agent.prompt.context`。

允许、询问和拒绝都由 Host 决定；插件不持久化 grant，也不实现私有权限弹窗。Ledger 访问被拒绝或失败时，实时操作会被禁用，因为其结果无法审计。

当 Host 报告 `current-connection-client-unavailable` 时，页面会如实保持“部分可用”，同时已导入历史仍可能可用。用户触发的投递可能被记录为已请求、已检查权限、已排队，随后失败。这只能验证公开控制与 ledger 路径，不能证明 Codex 已成功转发，更不能证明模型已消费。

历史 payload 默认使用摘要投影。内联内容仍由 Host 脱敏并限制长度；secret、原始本地路径、工具参数、工具结果、diff、instruction、加密 blob 和未请求正文都不会发送给渲染器。Provider/profile/session scope 必须精确匹配；遇到拒绝、不匹配、符号链接、源替换或过期插件 generation 时都会关闭失败。

架构、契约映射、生命周期与验证边界见 [Agent Trace Showcase 设计](https://github.com/cordisx/cordisx/blob/main/.agents/docs/agent-trace-showcase.md)。
