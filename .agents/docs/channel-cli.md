# Channel CLI and chat bindings

## Configured runtime

Ordinary `cordisx channel` commands use the selected profile’s running Host.
They share its Channel transport and Host credential handles. They do not start
a second SDK connection or require credentials in arguments.

```text
cordisx channel connections
cordisx channel conversations --input '{"account":{"adapterId":"feishu","accountId":"<app-id>","tenantId":"<tenant-id>"}}'
cordisx channel bind-status --input '{"sessionId":"<Codex chat UUID>"}'
cordisx channel history --input '{"sessionId":"<Codex chat UUID>","afterSequence":0,"limit":50}'
```

`--profile <id>` selects a profile. `--input <JSON>` supplies the same request
shape as native `channel_*` tools. `connections`, `conversations`, `bind`,
`unbind`, `bind-status`, `reply-mode`, `history`, `listen`, `send`, `send-many`, `receipt`,
`policy` and `policy-set` use the existing management endpoint and verify the
launcher identity. An inactive runtime reports unavailable.

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

## 发送诊断、执行设置与文档

CLI 返回固定 code 和 submitted 状态，区分未运行、身份无法核验、过期端点、Socket 权限、连接不可用和结果未知。已观察到同一 send 在受限环境失败、正常授权后成功；未采集具体 syscall，不能将全程等待归于权限。先核对运行中精确 CLI/profile，再查询同一 operationId 的 receipt。缺失 receipt 明确为 null/not-found；final 或 stop 不是外发证据。详见插件随包发送排障文档。

`execution-defaults`/`execution-defaults-set` 维护 CordisX profile 的新建默认值；`execution-settings`/`execution-settings-set` 维护 host+chat 覆盖，CAS `expectedRevision`，下一 turn 应用。`never` 不扩大执行权限。Native effective 状态与保存、提交分开。

`docs --input '{"pluginId":"channel"}'` 列出已激活插件文档；加 `id` 读取一个随包 Markdown。Host 只读 package 内常规文件，拒绝越界及 symlink。通用插件 README 页面提供独立文档选择，文档不自动获得 prompt 权限。

版本边界见 [workflow policy v3 / Manager v9](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/channel-runtime/workflow-v3.md) 与 [package docs v1](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/plugin-documents/README.md)。
