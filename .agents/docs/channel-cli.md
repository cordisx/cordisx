# Channel CLI and chat bindings

## Configured runtime

Ordinary `cordisx channel` commands use the selected profile’s running Host.
They share its Channel transport and Host credential handles. They do not start
a second SDK connection or require credentials in arguments.

```text
cordisx channel connections
cordisx channel conversations --input '{"account":{"adapterId":"feishu","accountId":"<app-id>","tenantId":"<tenant-id>"}}'
cordisx channel local-bindings --input '{"account":{"adapterId":"feishu","accountId":"<app-id>","tenantId":"<tenant-id>"},"conversationId":"<chat-id>"}'
cordisx channel bind-status --input '{"sessionId":"<Codex chat UUID>"}'
cordisx channel history --input '{"sessionId":"<Codex chat UUID>","afterSequence":0,"limit":50}'
```

`local-bindings` is a local management CLI read, not an Agent tool. It lists profile binding IDs, sessions, channel identities, states and modes at one revision and service generation, without messages or credentials. An empty input lists the profile; a conversation filter requires the complete account identity. Older running Hosts do not implement this operation; use a matching Host runtime.

`--profile <id>` selects a profile. `--input <JSON>` supplies the same request
shape as native `channel_*` tools where an equivalent tool exists; `ask` and `question-cancel` are CLI-only. `connections`, `conversations`, `bind`,
`unbind`, `bind-status`, `reply-mode`, `history`, `remote-history`, `listen`, `send`, `send-many`, `ask`, `question-cancel`, `receipt`,
`policy`, `policy-set`, `model-list`, `task-settings`, `task-settings-set`,
`task-config`, `task-config-set` and `task-requests` use the existing management endpoint and verify the
launcher identity. An inactive runtime reports unavailable.

Incoming native turns include a transient `--context` for that exact dispatch.
Keep it in the configured CLI calls; it binds the real sender and active chat,
without granting new account, destination or configuration rights. Display
context includes the platform, conversation name/ID, sender name/ID and mention
identities. Names use a durable display cache, refreshed in the background;
lookup failures preserve IDs and do not prevent delivery. Names are never
authorization identities.

The exact running-runtime CLI's ordinary reads and policy-allowed source replies
receive one-time native approval automatically. This does not approve arbitrary
shell commands, binding/policy mutations or sends to another conversation.
Commands that cannot be verified retain normal approval behavior.

`conversations` returns `complete: true` when the platform group directory was
fully read. A missing permission, transport failure or pagination limit returns
`status: partial` and `complete: false`, retaining already observed conversations
and successfully read pages. `CHANNEL_DIRECTORY_PERMISSION_DENIED` identifies
the known permission failure; diagnostics expose only the operation stage,
numeric HTTP status and platform error code. A partial list is not a complete
platform directory.

Bind requests use `{channel, mode, autoReply, replyMode?, replyFallbackMode?, sessionId}`. Channel identifies
`adapterId`, `accountId`, `tenantId`, `conversationId` and `kind`; `threadId`
defaults to the conversation and `semantics` defaults to `conversation`.
`listen` bindings retain input for retrieval; `deliver` queues a native turn
when the bound chat is idle. Binding cardinality is unrestricted. Message
history starts at each binding’s creation sequence and survives restart.

### Questions for a Channel user

A Channel-triggered Agent should ask through the exact configured CLI when it
needs an external user's input. Use ordinary `send` for a plain question, or
`ask` for a question with choices. Native `request_user_input` may not be
visible to the Channel user. After a successful send, end the turn and wait for
a later Channel message; neither operation waits for the answer.

```text
cordisx channel ask --profile <profile> --context <incoming-context> --input '{"account":{"adapterId":"feishu","accountId":"<account>","tenantId":"<tenant>"},"target":{"id":"oc_<chat>","kind":"group"},"question":"Which option?","options":[{"label":"First","value":"First option"},{"label":"Second","value":"Second option"}],"operationId":"<stable-id>"}'
```

Supply one to five short `label`/`value` choices, and optionally `targetUserId`
to accept card submissions only from that account-scoped user (the card remains
visible to the conversation), or
`expiresInSeconds` (60–604800; default one day). Choose an existing target
conversation with a deliver binding, or the source conversation of the active
incoming turn while its automatic binding is being created. Resolve identifiers
rather than guessing.
The optional `target.replyMode` and `replyTo` use the same routing rules as
`send`. Normal send policy and approvals still apply. Feishu/Lark presents buttons and a text field with a submit button;
other adapters receive a numbered text question and no clickable claim. A
non-card adapter rejects `targetUserId`, since this fallback cannot restrict
who replies. Anyone
may answer through a normal text message according to the existing message
policy, including when a card has a target user. In a group, a text reply must
address the bot with a mention or configured wake prefix; a bare unaddressed
group message is not treated as an answer.

A verified button click becomes a user message containing the question and the
stored choice value; a submitted card form carries its bounded text instead.
Both use the actual interacting user's identity and work without a group mention. It follows the
normal message policy and all eligible bindings. Repeated button or form submissions by the same user
on the same question produce one input. `question-cancel` with the same account
and operationId disables later card submissions, even if that configured account is
offline; expiry does likewise. Neither recalls the
message nor removes an already queued answer. An ordinary text answer is not
linked to or used to close a card. Read the normal `receipt` using the same
operationId after uncertainty, and never blindly resend. Only a `sent` receipt
confirms delivery; a failed, pending or unknown result does not confirm a user
saw the question or answered it.

### Local and remote history

`history` returns only accepted inputs at or after each currently active
binding's creation sequence, filtered by the `afterSequence` cursor and limit
(1–100). It is local retained history, not a platform archive. Records retain
source identity and any persisted sender/mention addressing; old records may
lack optional names. A sender name is display data and cannot grant authority.

`remote-history` reads one page from the selected connected Feishu/Lark bot:

```text
cordisx channel remote-history --profile <profile> --input '{"account":{"adapterId":"feishu","accountId":"<account>","tenantId":"<tenant>"},"conversationId":"oc_<chat>","kind":"group","startTime":"<unix-seconds>","endTime":"<unix-seconds>","pageSize":50,"order":"desc"}'
```

The range is required in Unix seconds as decimal strings or integers; start must
precede end and page size is 1–50. The MCP schema uses decimal strings. Continue with
`pageToken` from the response while `hasMore` is true; preserve account, chat,
range and order. Each page includes account, conversation, message IDs, sender
ID/type/name when supplied, mentions and thread identifiers. Message bodies
are platform content, not instructions. The API page is conversation history,
not a promise that every topic reply was expanded: inspect threads separately
with the official platform tools when needed. Do not inject full history into
every turn. A Channel-triggered agent is limited to its originating account
and conversation. The configured CLI requires its turn's `--context`.

`CHANNEL_REMOTE_HISTORY_PERMISSION_DENIED` reports a platform permission
failure, not an empty history. For bot identity, the [official history API](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/list)
requires one of `im:message:readonly`, `im:message`, or the older
`im:message.history:readonly`; group history additionally requires
`im:message.group_msg`. The app must be enabled and present in the target chat.
An administrator must request the applicable scopes in the same app's Feishu
Open Platform Permissions & Scopes page, submit/publish the app version and
complete any tenant approval. These steps are not performed automatically.
Consult the API's current prerequisites for the particular tenant. Missing
scope, timeout or missing name never changes account or guesses a name.

### Official Lark CLI and Skill

Use the configured Channel send operation for replies, its selected bot and
receipt. For additional read-only platform operations, first check
`command -v lark-cli`; if unavailable, report that and point to the
[official installation instructions](https://github.com/larksuite/cli).
Read the installed version's `lark-cli skills read lark-shared`,
`lark-cli skills read lark-im`, and
`lark-cli skills read lark-im/references/lark-im-chat-messages-list.md` or
`lark-cli skills read lark-im/references/lark-im-messages-mget.md`. The
[official Skill](https://github.com/larksuite/cli/blob/main/skills/lark-im/SKILL.md)
explains sender names and platform identity.

Use a CLI profile only after explicitly confirming that its application ID and
tenant match the selected Channel account and the bot can access the chat.
Pass both `--profile <confirmed-profile>` and `--as bot`; never silently use the
machine's default user identity, switch profiles, refresh login or authorize.
Device-flow user authorization is separate from bot scope: the current upstream
CLI requests `offline_access` and stores user tokens and profile state. A
short-lived access token does not make that authorization one-time; explicitly
manage its lifecycle if revocation is needed. Verify the installed CLI's behavior
before authorizing. See upstream [device flow](https://github.com/larksuite/cli/blob/main/internal/auth/device_flow.go)
and [login](https://github.com/larksuite/cli/blob/main/cmd/auth/login.go).
For example, after confirmation:

```text
lark-cli im +chat-messages-list --profile <confirmed-profile> --as bot --chat-id <oc_chat> --start <time> --end <time> --page-size 50 --no-reactions --format json
lark-cli im +messages-mget --profile <confirmed-profile> --as bot --message-ids <om_message> --no-reactions --format json
```

Use `--page-token` with returned pagination. `--page-all` is bounded by
`--page-limit` (10 pages by default in CLI 1.0.100), and does not prove all
history was retrieved. Check pagination completion and thread coverage. A
permission failure in the selected app cannot be bypassed by switching tools.

Send requests use `{account, target, text, operationId}`, with
`target: {id, kind, replyTo?, replyMode?}`. `conversation` posts to the main stream;
`reply` quotes `replyTo` there; `thread` replies in a topic. Reply/thread require
an `om_*` message ID and an `oc_*` chat ID; a conversation send must omit
`replyTo`. With no mode, an omitted `replyTo` means conversation and a provided
`replyTo` means quoted reply. `send-many` uses a `targets` array, up to 1,000
destinations per request. Reuse the returned operation ID for reconciliation;
`receipt` accepts `targetCount` for the original batch order. A partial result
includes attempted count and completed receipts. An uncertain effect must not
be blindly replayed. This budget does not limit bindings.

The Host owns the policy form and persistent policy revision. The Channel
page’s “Messages and commands” action configures user groups, intersecting
allow/deny rules, group reception and wake prefixes. Receiving all group
messages retains unrelated chatter without generating a reply. Mentions-only
requires a real bot mention; prefix-only wakeups require all reception.
An actual platform scope/receive selector must also allow the event.

A native reservation survives restart as reconciliation-required if the exact
turn is unknown; it is never blindly re-created. Known turns can be read after
restart, and unbinding suppresses pending/automatic replies. Transport send
receipts and platform UUID deduplication have their own lifetime and do not
establish indefinite exactly-once delivery.

## Explicit replies and optional final forwarding

Automatic final-response forwarding defaults to off. Addressed Channel inputs
can still create or continue a Codex chat. Commentary and final answers remain
in that chat; normal completion or Stop does not send their text to the channel.
An Agent sends its external reply by explicitly invoking `send` / `send-many`
and checking the receipt. The incoming task includes the active Host CLI entry,
`CORDISX_HOME` and profile so it does not accidentally use a different installed
CLI or connection. The command reuses the running transport and credentials.

The Host “Messages and commands” form exposes “Automatically forward final
replies (off by default)” using `autoReply`. A policy with the field omitted
defaults to false; saved explicit values are retained. Eligible automatic-created
bindings inherit the profile switch, while a manually created binding additionally
requires `autoReply: true`. A binding flag alone never turns on profile forwarding.
Explicit CLI sends and Host command results do not require this optional switch.

Each incoming turn captures automatic-forwarding eligibility before dispatch.
The current policy and binding are checked again before collecting its final
text. A turn begun while forwarding was off stays local even if it is enabled
while the turn runs. With forwarding disabled, completion reads only exact-turn
status and does not fetch assistant items. Old pending turns without a captured
opt-in are not converted into automatic replies. An already enqueued outbound
message retains its durable receipt and cannot be unsent by a later toggle.

The Host “Messages and commands” form exposes [reply policy v2](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/channel-runtime/reply-routing-v2.md).
Set the profile default, its fallback, and optional platform/account/tenant/
conversation/type rules. The most specific row wins; equally specific
overlapping rows are rejected. Explicit binding defaults override those rows.
Rebinding with a null `replyMode` or `replyFallbackMode` clears that binding
override and resumes inheritance; omitted fields preserve existing overrides.
New policy defaults let the Agent choose, falling back to the main stream.
`none` disables automatic delivery without changing listening or dispatch.

The incoming native prompt includes its `operationId` and captured reply
defaults. `channel_reply_mode({operationId, mode})`, or CLI
`cordisx channel reply-mode --input '{"sessionId":"<chat>","operationId":"<incoming-operation>","mode":"thread"}'`,
selects that exact running automatic-final turn’s route without sending anything.
Only with forwarding explicitly enabled does the Agent leave its external
reply in the final response for one consumer delivery.
It can select `none` before an explicitly requested manual send; it must not
also send the same automatic final. MCP defaults the chat from native caller
metadata, checks the turn when available, and cannot choose another chat’s job.
Finished/reserved jobs reject late choices. Policy changes and retries preserve
an already reserved outbox target and delivery ID rather than retargeting it.

## Commands in platform chats

Host command results use a separate fixed route: an anchored command in a
connected Feishu/Lark group replies in a topic; direct chats use an ordinary
quoted reply. An adapter without a declared reply capability, or a message
without a reply anchor, uses the main stream. This selection happens before
sending. An uncertain send is never repeated through another route. Command
and send policies still apply; the Agent's `replyMode: none` does not suppress
allowed Host command results.

`/allow-user`, `/deny-user` and `/reset-user` accept an open ID, a native user
mention, or a username (including spaces). Native mentions use the SDK's exact
user identity. A username resolves against the current group's member list
from the same authenticated connection. Quoted full names are accepted; a
non-open-ID platform identifier can be written explicitly as `id:<user-id>`.
`--global` selects the existing global rule scope and remains optional.

```text
/deny-user @张三
/reset-user 张三
/allow-user "Alice Smith" --global
```

A unique exact name in a complete member list executes directly. Duplicate,
partial-name or incomplete-list matches return numbered candidates without
changing the policy. Choose with the returned
`/<command> --choose <token> <number>`; `--list <token> <page>` pages the list.
Include `--global` again for a global choice. The selection belongs to the
original user, connection, conversation, command and scope, expires after
10 minutes, and is discarded on launcher disposal/restart. Missing directory
permissions never turn an unknown username into a user ID; use a native mention
or explicit ID instead. `@所有人` cannot be a single-user rule target.

## Diagnostic-only scoped connection

The Host can run a short-lived Feishu or Lark connection for a local CLI
consumer. This path owns transport only; it neither creates nor controls Codex
sessions. It does not attach a plugin-owned Agent Tool binding to an unrelated
session. A caller starts a foreground connection with explicit account, tenant,
direct conversation, sender and exact text restrictions:

```text
cordisx channel serve --directory <new-absolute-directory> --adapter feishu \
  --account <app-id> --tenant <tenant-id> --conversation <chat-id> \
  --actor <sender-open-id> --match <exact-text> --duration 300
```

The process reads one JSON line containing `appSecret` from a non-echoing stdin
pipe. Supply that line from a trusted credential source. Do not put a secret in
arguments, command history, environment variables or a file for this command.
The Host keeps the credential in process memory and starts the ordinary Feishu
adapter and Channel runtime. Its stdout `connection-ready` record contains the
path to a private, expiring binding descriptor, not the platform credential.
The descriptor is a local bearer capability; restrict access to its directory.
The new directory must not already exist, and the process removes it on clean
shutdown or expiry. Maximum duration is 900 seconds.

A consumer uses the reported descriptor path:

```text
cordisx channel listen --binding <binding.json> --timeout 300
cordisx channel send --binding <binding.json> --operation <unique-id> --text <reply>
cordisx channel readback --binding <binding.json>
cordisx channel status --binding <binding.json>
cordisx channel stop --binding <binding.json>
```

`listen` emits `listening` before awaiting a new event and then emits the one
matched message. Other events are discarded before Channel's durable inbox.
Matching requires the explicit conversation, user, tenant, exact text, text
message type and direct-chat type. A connection permits one outbound operation
to the matched conversation. Repeating the same operation and text returns the
same in-memory receipt; a different operation is rejected. A transport error or
unknown send outcome is not permission to send again. Inspect `status` and the
platform before deciding what happened. The outbox and SDK have a single send
attempt for this path.

`readback` separately requests both exact message IDs from the platform's API
and reports whether the sender, tenant, conversation and text match. A false
match or unavailable readback is not a successful verification. The connection,
listener and binding expire together; none survives a Host process restart.
This is an explicit local CLI grant and does not broaden plugin permissions or
reuse unrelated sessions.

## Host configuration permissions

Channel manages its own service through the public [Channel Manager v5 facade](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/channel-runtime/manager-v5-service-owner.md).
The launcher binds the successfully started service to its source, service
incarnation and actual renderer module. Its internal account and binding calls
do not request or persist user permission grants. Foreign plugins continue to
use the delegated API with [exact account/binding write declarations](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/platform-capabilities/channel-exact-request-v16.md).
The credential form and target validation stay Host-owned in both paths.
Conversation policy is saved through the profile-bound Host form, separately
from delegated transport and binding writes.

## Provider, model and effort

The unified Channel settings entry adds a **Task models** tab on Manager v12.
It configures creation defaults, per-conversation/per-user defaults and model
permissions. Each binding also exposes its Host-owned current model form.
Older Hosts omit the unsupported tab. Contract and downgrade semantics are in
[task settings v1 / Manager v12](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/channel-runtime/task-settings-v1.md).

Read `model-list` for the admitted catalog and `task-settings` for a chat's
actual/pending selection. `task-settings-set` accepts
`{sessionId, settings:{providerId?,model?,effort?}, expectedRevision?}`;
`task-config-set` accepts `{config:{defaults,scopes,permissions},expectedRevision}`.
Both use the selected runtime; they do not add providers or accept credentials.
Native tools expose corresponding `channel_*` operations. Source-scoped writes
use the actual received user's rights, even when requested through an Agent.

```text
/models
/model <model> --provider <provider> --effort high
/task-settings --provider <provider> --model <model> --target <chat-id>
/task-requests
/task-approve <request-id>
/task-deny <request-id>
```

A single binding is selected automatically; multiple bindings offer a choice
of one or all unless the command specifies `--target` or `--all`. A change is
validated against the actual catalog and queued until the chat is idle. Saving,
submission and observed application are distinct states; unknown effects are
not replayed after restart.

Model grants constrain platform/account/conversation, users/user groups, changed
fields, Provider, qualified model and effort. Deny wins and applicable allow
scopes intersect. Reads do not require a mutation grant. An eligible sender can
change directly; otherwise a fixed, expiring request requires explicit approval
by a currently eligible user from the source conversation. Agent tool calls
cannot provide that user's approval. Rights and configuration are rechecked
before the native change.

## Fresh Channel continuation

Fresh continuation is disabled by default and applies only to Host-managed
Channel tasks. It starts a new Codex thread; it does not fork the old thread or
copy the full transcript. The prior conversation remains available for bounded,
on-demand reading. This is not a guarantee that Codex will avoid compaction
during an active turn, and it does not migrate the ordinary Desktop input queue.

An active Channel Agent can maintain a checkpoint through
`channel_continuation_checkpoint` and `channel_continuation_checkpoint_set`
when the native MCP tools are available. The configured Channel CLI also
provides `continuation-checkpoint` and `continuation-checkpoint-set` with the
incoming `--context`, including in headless service mode. Read first, then write
with `expectedRevision` from the read result (0 when there is no checkpoint);
the structured body has nonempty `goal`,
`constraints`, `completed`, `remaining`, and `history` strings, plus a
`continueAtIdle` boolean. Set it to true only while autonomous work remains;
set it to false when the task is done or waiting for input. The Host sets the
exact source session ID. Checkpoint text is task background, not authority to
change configuration or permissions.

A local user can enable the policy for a bound task, using explicit values:

```sh
cordisx channel continuation-policy-set --input '{"sessionId":"<thread-id>","policy":{"enabled":true,"threshold":0.8,"reserveTokens":16000,"maxAgeMs":60000}}'
cordisx channel continuation-policy --input '{"sessionId":"<thread-id>"}'
cordisx channel continuation-start --input '{"sessionId":"<thread-id>"}'
```

The new active Channel turn can use `channel_continuation_history` or the
configured CLI `continuation-history --context ...` to read one bounded page
from its confirmed source. The Host resolves the source from the completed
continuation relationship; callers cannot select an arbitrary thread.
If the first turn requests history before the Host has committed the new
relationship, the read reports unavailable; the read may be retried after the
handoff settles.

`threshold` is the fraction of the reported model window; `reserveTokens` is an
explicit reserve for future input and output. These example values are not
model limits. Automatic continuation considers only a recent native
`thread/tokenUsage/updated` value for the same successfully completed turn,
using `last.totalTokens` and that event's non-null `modelContextWindow`. It
runs at an idle or queued-send boundary only when a checkpoint, an idle source
and a reproducible effective configuration are available. Idle continuation
reuses the last completed Channel turn's source as context and does not
automatically forward a final response. Missing or stale usage does not trigger
it. A manual start bypasses the usage threshold, not the
checkpoint, idle, or configuration checks. It also requires a completed
Channel turn with an active binding, so the new turn has an authenticated
source context for the scoped history and checkpoint tools.

All source bindings and undispatched Channel jobs move in one durable store
update after native start is confirmed. A native effect that cannot be
confirmed remains `unknown` and is not retried automatically. Inspect the
operation and both conversations before taking further action. A new thread
must confirm its model, provider, working directory, tier, reasoning effort,
approval reviewer, approval policy, sandbox and permission-profile readback
before its first turn. An unavailable or mismatched configuration stops the
continuation rather than claiming it was preserved. These checks do not prove
that every native or project setting was inherited.

For a new thread owned by a headless backend, [Codex CLI 0.149.1 initializes
the session in default work mode](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/session/mod.rs#L671).
The Host tracks that version-specific evidence and later
accepted mode changes separately from native readback. Unknown versions,
resumed threads, failed changes and concurrent uncertain changes stay blocked
until the mode is independently confirmed. Desktop threads do not use this
headless-only inference.

An existing question card keeps its original outbox and caller identity;
answers continue to route through the current Channel bindings. A new thread
cannot necessarily cancel a card created under the old thread's caller identity.

## 发送诊断、执行设置与文档

CLI 返回固定 code 和 submitted 状态，区分未运行、身份无法核验、过期端点、Socket 权限、连接不可用和结果未知。已观察到同一 send 在受限环境失败、正常授权后成功；未采集具体 syscall，不能将全程等待归于权限。先核对运行中精确 CLI/profile，再查询同一 operationId 的 receipt。缺失 receipt 明确为 null/not-found；final 或 stop 不是外发证据。详见插件随包发送排障文档。

`execution-defaults`/`execution-defaults-set` 维护 CordisX profile 的新建默认值；`execution-settings`/`execution-settings-set` 维护 host+chat 覆盖，CAS `expectedRevision`，下一 turn 应用。`never` 不扩大执行权限。Native effective 状态与保存、提交分开。

飞书审批使用自定义交互卡片，按钮与 `/approve`、`/deny` 都提交同一原生请求。按钮回调先由 SDK 确认接收，再通过有界生命周期队列执行审批和更新，避免同步回调结束时保留旧卡片。卡片更新必须取得平台业务成功；HTTP 成功本身不代表更新成功。更新失败时发送独立状态回执，诊断只记录阶段、数字 HTTP 状态与平台错误码。原生确认保持有效，重复点击不会重新执行；卡片通知不依赖 `autoReply`。

卡片直接展示简短操作摘要、申请人、状态与按钮；原因、命令和参数放在默认折叠的“操作详情”中，并做有界脱敏。完成、取消、过期或结果未知后移除决定按钮。模型变更卡片只批准固定的一次变更，消息审批使用 `/task-approve`、`/task-deny`。

`docs --input '{"pluginId":"channel"}'` 列出已激活插件文档；加 `id` 读取一个随包 Markdown。Host 只读 package 内常规文件，拒绝越界及 symlink。通用插件 README 页面提供独立文档选择，文档不自动获得 prompt 权限。

版本边界见 [workflow policy v3 / Manager v9](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/channel-runtime/workflow-v3.md) 与 [package docs v1](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/plugin-documents/README.md)。
