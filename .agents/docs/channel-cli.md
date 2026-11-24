# Channel CLI and chat bindings

For independently authorized original-message forwarding, see [single/merge forwarding](channel-forward.md). It is not `send`, reply/thread sending, or Agent SDK fallback.
See [scoped message operations](channel-message-operations.md) for candidate
edit/recall, pin, read-user/reaction pagination, restricted card updates and
operation-level capability discovery. These are not generic vendor API access.

See [media and reactions](channel-media-reactions.md) for candidate reaction CLI
arguments, completion semantics, capability boundaries and unavailable media APIs.

## Configured runtime

### Let an administrator open the current group for tasks

In a group, an administrator can mention the bot and say “给这个群开白，在这个群里都能和他说话”
or “给本群开白吧”. To revoke it, say “本群取消开白”. The AI receives the current
message's scoped CLI instructions and can run:

```bash
cordisx channel group-access --context <incoming-context> --input '{}'
cordisx channel group-access-set --context <incoming-context> --input '{"enabled":true,"expectedRevision":<revision>}'
```

Use the revision returned by `group-access`; revocation uses `enabled:false`.
Both operations require a live authenticated incoming context. The caller cannot
provide another account, group or actor. Enabling requires the sender's existing
`allow-user` command permission in this group; revocation requires `reset-user`.
A Feishu group administrator title alone does not establish a CordisX command
grant. Explicit command denials still win. The Host validates the original
direct request, not an AI-provided paraphrase; an ambiguous or quoted request
needs clarification.

The grant bypasses positive task-dispatch allowlists only for future messages
in this exact account, tenant and group that mention the bot. Explicit dispatch
denials, disabled policy and configured receive selectors remain authoritative.
It does not expand management commands, outgoing-message permissions, memory
sharing, private-chat access or other groups. Current and future group members
use the verified sender identity of their incoming message; no cached roster is
used as authorization. Requests denied before the grant are not replayed.

The Host persists this task-only grant separately from ordinary policy rules.
Revocation removes only this grant and rechecks queued work before dispatch;
it does not interrupt an already-running turn. Re-enabling starts a new message
cutoff. Revision conflicts require a fresh read. An unknown RPC outcome is not
success and must be read back before another write. General `policy-set` remains
local-user-only for profile changes.

### Let an administrator change personal task access or block a group

An authorized user can ask “给 @用户 授权”, “禁止 @用户 发起任务” or
“恢复 @用户 权限”. The AI must copy the original target into these operations:

```bash
cordisx channel user-access --context <incoming-context> --input '{"user":"@用户"}'
cordisx channel user-access-set --context <incoming-context> --input '{"user":"@用户","effect":"allow","expectedRevision":<revision>}'
```

`effect` is `allow`, `deny` or `reset`, requiring the sender's corresponding
`allow-user`, `deny-user` or `reset-user` command permission. In a group, `allow`
creates a task-only grant for this exact account, tenant, group and user. It
bypasses positive dispatch allowlists for that user's future messages mentioning
the bot; earlier messages are not replayed. It does not open the group to other
members or change private chats, other groups, send or management permissions.
Explicit denies still win. Revocation rechecks queued work but does not interrupt
an active turn. This grant does not require global command authority.

Direct-chat rules and optional `scope:"account"` use ordinary policy rules:
positive lists at applicable scopes intersect and explicit denies win. Account
scope requires both an explicit “在本账号给 @用户 授权” (or corresponding
deny/reset) request and the existing global command grant. It remains limited to
the source account and tenant. A scoped command administrator cannot silently
widen a change to the account. Arbitrary other accounts and unrestricted remote
`policy-set` are not accepted.

The Host resolves native mentions, explicit IDs or unique full names using the
current source's addressing and directory. An ambiguous/incomplete name returns
`choice-required` without changing the policy. Ask the user for a new explicit
request using a native mention or ID; the AI must not select a person itself.
The Host validates the target, scope and affirmative intent against the original
message, not an AI-provided actor or paraphrase. For `user-access`,
`dispatchAllowed` describes prospective task admission; a task-only grant still
requires a new mentioned message at or after `fromSequence`.

For current-group task blocking, ask “禁止本群任务”; to restore, ask
“恢复本群任务”. The AI reads the revision and writes:

```bash
cordisx channel group-block --context <incoming-context> --input '{}'
cordisx channel group-block-set --context <incoming-context> --input '{"blocked":true,"expectedRevision":<revision>}'
```

Blocking requires `messages-off`; restoration requires `messages-on` and uses
`blocked:false`. The group accepts an explicitly mentioned, authorized
“恢复本群任务” request even while its managed block is active, provided the
other admission rules permit that sender. Other tasks remain blocked. If another
deny or an allowlist also blocks the administrator, `/messages-on` is the
authenticated management fallback, independently of task dispatch; a local
administrator can also inspect and edit policy. No arbitrary remote group target
is accepted. Disabling the whole consumer still requires local configuration.

The message commands and CLI share managed rule IDs. Personal `reset` removes
only the matching managed rule and precise user grant; group restoration removes
only the matching managed group block. Neither deletes unrelated denies, opens
management commands or promises admission when another rule still forbids it.
Live caller, connection generation, command authority and revision are checked
again at the durable effect. Re-read conflicts and uncertain RPC outcomes before
any further write. Running tasks are not interrupted and denied history is not
automatically replayed.

### Scoped memory (local implementation)

Use `cordisx channel memory guide --context <incoming-context> --input '{}'`
to discover on-demand `write`, `organize` and `recall` guidance. `navigate` and
`search-page` return byte-bounded paged cards; `batch` loads selected IDs under a
separate budget. These operations do not establish style profiles or grants.

Every scoped business turn receives memory instructions, including accounts
without a configured persona and later turns whose unchanged persona capsule is
suppressed. At meaningful milestones, verified progress, decisions, corrections
and handoffs, the model should save concise useful task knowledge. It searches
before writing and updates a matching assertion with its exact revision.
Questions about earlier conversations or project progress should first retrieve
authorized memory. Use short supplied subject names rather than entire questions;
retained memory is dated evidence, so live progress still needs task readback.

`cordisx channel memory remember|get|search|update|forget|index` reuses the
running Host and requires `--context <incoming-context>` and optional
`--profile <id>`. Use `--input <JSON>`: remember takes `record` (kind, title,
summary, tags, entityRefs, evidenceType, confidence); get takes `id`; search
takes `query` and optional `entity`; update takes `id`, `revision`, `record`;
forget takes `id`, `revision`; index takes `{}` and rebuilds only the caller's
current-conversation records. Read `cordisx channel help memory` for details.

For a verified task milestone or decision, `kind` is `fact`; `task` and `decision`
are not supported kind values. `confidence` is a JSON number from 0 to 1, not
`"high"` or a numeric string. Keep all record fields inside the `record` wrapper:

```sh
cordisx channel memory remember --context <incoming-context> --input '{"record":{"kind":"fact","title":"Cedar progress","summary":"Deployment verified; validation remains","tags":["Cedar"],"entityRefs":[],"evidenceType":"verified","confidence":1}}'
```

Accepted kinds are `fact`, `preference`, `person`, `conversation`, `collaboration`
and `impression`; an impression also requires `observedAt` in UTC ISO format with
milliseconds. `memory guide --input '{"topic":"write"}'` returns a complete example.
Invalid record fields return `MEMORY_INVALID_RECORD`, field-level `issues`, and
`retrySafe:true` only when validation rejected the request before writing.
The Agent should correct those fields and retry once in the same authenticated turn,
without inventing missing evidence. If still rejected, read the write guide and
report unresolved failure rather than looping. Confirm `status:"ok"` before saying it saved
anything. Revision conflicts require a fresh `get` and reconsideration; storage
or transport failures do not authorize blind retries. Search/get first when the
effect is unknown. Corrupt stored data does not receive the retry-safe flag.
Successful retrieval proves authorized readback, not that a model used the fact
in its answer; relevant answers should refer to the returned dated evidence.

This is selective model-driven maintenance, not automatic transcript ingestion
or platform history access. It never configures a persona or widens sharing.
Direct-chat own
recall needs no administrator. The verified owner can also find their own
records in the same source group without a special recall phrase, allowing
ordinary progress messages to update an existing record. Across groups,
own-topic requests derive from actual
accepted incoming text; grant/revoke/grant-list use configured actor/source
authority, not claimed admin. Two-account identity-challenge/identity-confirm
use verified second-account requests with expiry/replay checks. Caller
actor/admin claims are rejected. See the
[memory design and delivery ledger](channel-memory-design.md) for tested
boundaries, identity confirmation gaps and production gates.

### User-scoped introductions and recall

Channel reuses the existing memory store for explicit self-introductions, preferred names, relationships, stable preferences, and useful personal facts. Before starting or steering a business turn, the Host analyzes an eligible first-person text message using tool-free structured Responses inference and saves or updates individual records. This does not depend on the business Agent choosing to call a memory tool. Record owner and provenance come from the verified adapter/account/tenant/user tuple, never from a display name or model claim. A self-declared relationship is attributed evidence, not management authority. Task admission, send denials, and persona separation still apply.

On an explicit self-question, the Host retrieves a bounded set of relevant exact-owner records from the effective persona space and supplies them in `messageContext.userMemory`. For example, a private introduction followed by “认识我是谁吗？” in another addressed group can recall the same sender's name and relationship; “我的名字是什么？” supplies only name records. Explicit own-topic questions can recall matching preferences or facts. The existing scoped memory CLI can also search and get these records. No permanent group grant is created, and another person, bot account, tenant, or persona does not gain access. The Agent must use relevant returned evidence and keep the current audience and uncertainty in view. A read result is not proof of model consumption.

Local operators can place `channel-user-memory.json` beside the profile's `channel-conversations.json` (under `apps/codex/profiles/<profile>`):

```json
{
  "enabled": true,
  "remember": true,
  "recall": true,
  "groupRecall": true,
  "timeoutMs": 5000
}
```

These are the defaults. `providerId` and `model` may be set together to an already admitted Responses model service for extraction; otherwise, the task's selected provider/model is used. Shared model services work in headless mode; Desktop also supports Host-managed plugin gateways. Official account-only models without a plain Responses connection cannot run automatic extraction; the business Agent retains the normal memory CLI. The analysis request contains only this message, has no tools, requests structured JSON, and disables provider storage. It adds one bounded model request to eligible introductions. The timeout range is 100–10,000 ms. Timeout, invalid output, or unavailable inference reports a bounded diagnostic and continues ordinary task dispatch; it never claims a successful save. Settings are read for each eligible message.

This is selective extraction of Chinese/English first-person statements, not transcript ingestion or universal semantic search. Quoted/unsupported text, secrets, and speculative or sensitive profiles are excluded. Topic matching is lexical; arbitrary paraphrases may require a shorter supplied keyword through the existing CLI. Corrections use a stable model-extracted topic key and revisioned records; a changed key may require normal CLI deduplication. Disabling the feature stops new automatic actions without deleting existing records. Existing `update`/`forget` remain available. No stored-data migration or automatic platform history import occurs.

### Automatic request-local recall for an administrator

For a direct project-status request such as “青杉项目现在进度是什么？” or a
recent-work question such as “你记得自己最近都做了什么吗？”, the Host can admit
the requesting administrator's own relevant task records automatically. The Agent
should first read `memory guide --context <incoming-context> --input '{"topic":"recall"}'`.
Its `recallAccess` reports the verified administrator, recognized request scope and
current audience. Then use `search-page` with the supplied project name, or
`navigate {}` for a recent-work overview, and `get`/`batch` for selected cards.
No sharing phrase or repeated grant request is needed for records already admitted.

The Host derives this role from effective `allow-user`, `deny-user` and `reset-user`
management grants at the actual source, or configured memory-source administrator
authority. It verifies adapter, account, tenant and user identity; a claimed role
or platform group-admin title is insufficient. Disabled policy and explicit
dispatch/send/management denials block this additional path. Memory-source
administration does not confer authority to read another person's private data.

This access is recomputed for each authenticated incoming request, creates no
persistent grant and does not open the records to other group members. It covers
exact-owner `fact`, `conversation` and `collaboration` records relevant to the
supplied topic. Recent-work overview additionally requires a task/work keyword and
an update within the last 30 days. Preferences, profiles, impressions, unrelated
personal facts, expired records, other accounts and unconfirmed linked identities
are excluded from this new path. Existing explicit own-topic and grant rules
retain their separate behavior. A following unrelated request receives only its
ordinary authorized scope.

The request made in a group authorizes an answer about these selected task facts
to that current audience, not disclosure of the private archive. Candidate matching
and permission checks happen inside the Host before cards/content reach the model;
no hidden record count, denied source title or other-person existence is returned.
The model must answer only the requested task facts and preserve their dates and
uncertainty. Quoted, negated, ambiguous or unsupported wording does not activate
this path; the normal authorized scope still applies. A broad assistant work
overview across all users/personas is not implemented. This does not merge persona
spaces, create global knowledge or change group task admission.

Local operator-only operations, rejected with Agent/Channel metadata:
`memory-authority-set` (account user tuple,scopes,expectedRevision),
`memory-persona-profile` (personaId,name,identity,style?,expectedRevision),
`memory-persona-bind` (bot account tuple,personaId,expectedRevision),
`memory-persona-context` (personaId,conversationId,style,expectedRevision).
Native generation reads bound persona capsules and task memory spaces. These
are existing `cordisx channel` operations, not another executable. Public
Protocol publication and formal delivery remain separate gates.

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

### Task reception feedback

Feishu/Lark tasks accepted by the existing wake, binding and dispatch rules
receive best-effort feedback. Default behavior attempts `Get` on receipt,
switches to `OnIt` after the native turn starts, and switches to `DONE` when
that exact turn is confirmed stopped. DONE describes the end of this round,
not successful completion of the user's whole goal. Default progress reminders
are injected into the existing Agent turn after 5 seconds without new input;
they ask the Agent to assess whether work can finish within 10 seconds and, if
not, send a factual progress update through Channel CLI. Group chatter that does not wake the bot and
Host slash commands do not trigger task feedback. Reaction failure does not
block native work. Feedback is separate from automatic final-response forwarding.

Configure `channel-feedback.json` beside the selected profile's
`channel-conversations.json` (under `CORDISX_HOME/apps/codex/profiles/PROFILE/`):

```json
{
  "reaction": {
    "enabled": true,
    "receivedEnabled": true,
    "receivedEmojiType": "Get",
    "processingEnabled": true,
    "emojiType": "OnIt",
    "stoppedEnabled": true,
    "stoppedEmojiType": "DONE"
  },
  "wait": {
    "enabled": true,
    "mode": "agent",
    "quietSeconds": 5,
    "repeatSeconds": 30,
    "finishSeconds": 10,
    "ackTimeoutSeconds": 60
  }
}
```

Reaction and progress reminders can be disabled independently. The three Agent
timings accept integer seconds from 1 to 86400. Continuous input resets one timer
for this account, tenant, conversation and group topic; it never schedules one
fixed response per message. After the quiet period, reminders repeat at
`repeatSeconds` until an actual correlated message is confirmed sent, a new input
resets the timer or the task stops. A tool invocation, queued message or reaction
does not count as a reply. Question cards and typed/media sends through the same
Channel CLI also count only after their sent receipt.

The native transport uses exact-turn `turn/steer` with an explicitly labeled Host
notice. It creates neither another task nor a fabricated Channel user input. The
native protocol represents this notice as a text input in the current turn; it
does not offer a separate system-message role. CLI progress sends should include
the notice's `progressToken`; stale tokens reject and queued guarded sends are
cancelled before transport if new input arrives or a reply was confirmed. Ordinary
business sends retain their existing behavior. The token changes no permissions.

### Short waits and cooperative input acknowledgment

The scoped prompt asks the parent Agent to continue independent work while its
delegates run, check new input between bounded waits, and send meaningful progress
through Channel CLI. Where the installed tool schema permits, use explicit
10–30 second waits, with no wait longer than 60 seconds unless the user needs it.
A timeout is a status check; it must not restart a healthy delegate or cause tight
polling or repeated unchanged updates.

Codex CLI 0.149.1's original `wait_agent` has a fixed 30-second default and a
one-hour maximum. Its timeout bounds are not configurable. That version also
supports an opt-in v2 tool implementation with configurable bounds:

```toml
[features.multi_agent_v2]
enabled = true
min_wait_timeout_ms = 10000
default_wait_timeout_ms = 30000
max_wait_timeout_ms = 60000
```

These are native Codex settings in the selected Codex configuration, not Channel
feedback fields. The Host does not silently enable v2 or rewrite existing native
settings. Check the installed version and generated schema before using them;
v2 settings do not affect the original implementation. In
[the 0.149.1 implementation](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs),
v2 waits subscribe to input-queue activity and can return early on steered input.
This is native-source evidence, not a guarantee that every blocking tool returns
or that the model has consumed the input.

When it begins handling the latest input, the Agent can run:

```sh
cordisx channel input-ack --context <incoming-context> --input '{}'
cordisx channel input-status --context <incoming-context> --input '{}'
```

Both require the live scoped caller and accept no target, actor or session override.
`awaiting-agent` with `consumption:"unconfirmed"` means there is no cooperative
acknowledgment; it does not prove the input was unconsumed. `agent-acknowledged`
with `consumption:"acknowledged-by-caller"` confirms the caller's explicit receipt,
not understanding or task completion. An older input cannot acknowledge the newer
one. In Agent feedback mode, `wait.ackTimeoutSeconds` records
`CHANNEL_INPUT_ACK_OVERDUE` once when queued/dispatching/active/uncertain work has
not acknowledged the latest input. It accepts integer seconds 0–86400; 0 disables
this diagnostic. New input resets it; confirmed reply, stopped work or process
restart ends this process-local monitor. Disabled/fixed feedback is not monitored.

The supported native protocol has `turn/steer` and whole-turn `turn/interrupt`,
but no cancellation of only a blocking tool and no reliable semantic consumption
notification. An overdue acknowledgment therefore never automatically interrupts,
restarts or replays a turn. Existing progress reminders still use the exact active
turn. Their acceptance alone does not prove timely consumption during a long tool
wait; reliable tool-only interruption remains unavailable.

Legacy `wait.delaySeconds`, `wait.text` and `wait.texts` select `mode:"fixed"` when
no mode is explicitly set; this preserves existing deployments. To switch, add
`mode:"agent"`; legacy fixed fields can remain but are ignored by the Agent timer.
To retain fixed hints explicitly, use `mode:"fixed"`, `delaySeconds` and optional
`texts` (1–50 nonempty strings, up to 1000 characters each). One entry is chosen
randomly per attempt; `texts` takes precedence over single `text`. Fixed and Agent
modes never run concurrently. A file at
`CORDISX_HOME/channel-feedback.json` is the legacy fallback when the profile
file is absent. Agent timing is captured for each newly accepted input; fixed
settings are reread at the hint deadline.
no App restart is needed. Invalid configuration disables feedback for that
input and records a diagnostic, without blocking the task.

`stoppedEnabled` and `stoppedEmojiType` configure the final running-status reaction
independently. Normal completion, explicit native failure and interruption qualify;
active, queued and unknown results do not. Every correlated job must refer to a
confirmed stopped native turn. Multiple messages steered into one turn each change
only when that shared turn stops. Uncertain handoffs or changed account generations
remain unchanged. The Host confirms the new reaction before removing its own prior
reaction receipts, including Get/OnIt receipts arriving late. Unknown API outcomes
are not retried and never authorize deleting another user's reaction.

The stopped configuration is captured only for newly accepted inputs in this Host
lifecycle. Enabling it or restarting does not sweep historical messages; interrupted
feedback requests are not replayed. With no explicit `stoppedEnabled`, an existing
`completionEmojiType` keeps its legacy completed-only behavior and disables the
default stopped mapping. To use stopped semantics instead, explicitly enable
`stoppedEnabled` and set `stoppedEmojiType`; it takes precedence over the legacy
completion mapping. `reaction.enabled:false` also disables stopped feedback unless
`stoppedEnabled:true` is explicitly set. No feedback operation blocks native work.

Feedback uses the existing account SDK connection and the configured reply
route. Reminders are process-local and are not replayed after restart. Multiple
bindings or ambiguous simultaneous tasks are not reminded; queued inputs wait
for their own confirmed active turn. Different senders do not steer one another.
Unknown native state or an uncertain reminder receipt stops further reminders
until a new input; the Host never repeats an uncertain `turn/steer`. A reminder
already accepted can still send its guarded update if its scope remains current.
Sends outside Channel cannot be correlated. Delivery created before the latest
input does not cancel that input's timer, even if its receipt arrives late.

In legacy fixed mode, an observed reply/question enqueue attempt conservatively
cancels all fixed hints for that account/destination, including concurrent tasks;
failed sends may therefore suppress a fixed hint. Agent mode instead relies on
confirmed receipts correlated to the active native task and destination.
Task completion and cancellation are rechecked before sending, but an HTTP
request already issued cannot be withdrawn atomically with task completion.
Hints are auxiliary notices and do not represent final task results.

## Pair a direct-chat administrator

On a running Host with a resolved, ready Feishu/Lark connection and enabled Channel policy, a local user can issue a five-minute, one-use code:

```text
cordisx channel admin-pair-begin --input '{"account":{"adapterId":"feishu","accountId":"<app-id>","tenantId":"<application-tenant-key>"}}'
```

Send `/pair <code>` to that bot in a private chat. Keep the code private and do not send it to a group. On the same local Host, inspect the candidate and explicitly confirm or cancel using the `pairingId` returned by `admin-pair-begin`:

```text
cordisx channel admin-pair-status --input '{"pairingId":"<pairing-id>"}'
cordisx channel admin-pair-confirm --input '{"pairingId":"<pairing-id>"}'
cordisx channel admin-pair-cancel --input '{"pairingId":"<pairing-id>"}'
```

Compare the displayed account, user ID, direct-chat ID and command list before confirming. Expiry, replacement, a changed service generation, a changed policy revision, or restart requires a new code. The sender must be a user in the application's own tenant; external users and group submissions cannot pair. The resulting rule authorizes management commands only for that exact account, tenant, user and private conversation. It does not change task-dispatch policy, and it cannot authorize `--global`. Existing policy denials and narrower restrictions still apply. Remove the generated pairing rule in Channel policy to revoke the grant. Pairing messages are consumed before the normal Channel inbox; no pairing code or raw event is stored in the transport or consumer ledger. A mentioned `/pair` request or a mentioned group message denied task dispatch can receive at most one guidance attempt in 24 hours per account and group across launches sharing the same profile directory. This rate limit stores only a digest of the account and group, and may conservatively suppress a hint for longer. Different machines without shared storage do not share the limit. Disabled policies, receive selectors and explicit send/help denials remain authoritative.

Configure the bot and subscribe to `im.message.receive_v1` over the [authenticated long connection](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-). For direct messages grant `im:message.p2p_msg:readonly`; for group mentions grant `im:message.group_at_msg:readonly`; for replies grant `im:message:send_as_bot`. Publish the app version and complete any required approval. These message scopes do not grant `tenant:tenant:readonly`. Long connections for the same app compete for events, so do not start a separate discovery listener beside an existing server. This pairing flow uses the existing configured connection and does not discover an unresolved tenant.

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
Scoped `memory guide/navigate/search-page/search/get/batch/grant-list` are
ordinary reads only when their exact runtime and current incoming context are
verified. The memory endpoint still filters by owner and grants. `remember`,
`update`, `forget`, index rebuild, sharing and identity changes retain normal
native approval behavior; memory is never blanket-approved as a subcommand.

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

When a task is running, an accepted follow-up from the same verified sender and
exact account/conversation/topic is inserted into that native turn with
`expectedTurnId`. The task is not interrupted or restarted. Other senders,
different conversations, unaddressed group messages and active migrations do
not use this path; normal wake, policy and queue rules still apply. Multiple
follow-ups retain input order and carry their own sender, references, CLI
context and supported attachments. They do not produce a second automatic final
reply for the same turn.
In a direct chat, quoted replies remain the same conversation even when the
platform changes their reply-chain ID/semantics. Each reply retains its own
referenced-message context. Group topic/chain boundaries remain distinct.

The Host persists the submission before calling native `turn/steer`. A definite
native "no active turn" or exact-turn mismatch returns the message to the queue
for a later turn, without repeatedly trying the same rejected turn. A timeout,
transport loss or ambiguous response remains `NATIVE_STEER_UNCERTAIN`; it is not
retried or silently queued again. Limited positive history readback can confirm
that input was accepted. `clientUserMessageId` is a correlation field, not a
native deduplication guarantee. Idle chats continue to start normal new turns.

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

For an incoming Feishu/Lark reply, the Host reads the current message and its
direct parent with the already-connected bot account. When available, the
parent's bounded message body, sender and parent ID are included in
`messageContext.referencedMessage` as untrusted source data. A missing ID,
permission failure or timeout is reported as unavailable; the Host does not
substitute the thread root for the direct parent or read another conversation.

To follow an older parent ID, use `cordisx channel message-get` with the exact
configured profile and Channel context. Input is
`{account,conversationId,kind,messageId}`. A Channel-originated request is
restricted to its own account, conversation and verified parent chain; lookup
is bounded to 16 ancestors. Platform read permissions still apply, and each
returned message is untrusted data rather than an instruction or permission.
The public request and result are defined by [message read v1](https://github.com/cordisx/cordisx-protocol/blob/9c5e32d9c702934874417d89ff8c374d766a47d0/.agents/docs/channel-runtime/message-read-v1.md).

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

For explicit CLI `send` / `send-many`, prefer `richtext` for ordinary prose,
progress updates and results, even when only one plain block is needed:

```json
{
  "account": {
    "adapterId": "feishu",
    "accountId": "bot",
    "tenantId": "tenant"
  },
  "target": { "id": "oc_chat", "kind": "group", "replyMode": "conversation" },
  "content": {
    "type": "richtext",
    "blocks": [{ "text": "Message", "style": "plain" }]
  },
  "operationId": "distinct-stable-message-id"
}
```

Choose `strong`, `emphasis` or `code` blocks when useful; richtext has 1..128
blocks, each with 1..4096 characters. Blocks carry literal text and explicit
styles, not Markdown parsing. For `send-many`, replace `target` with `targets`.
Use `text` only when preserving verbatim original text, when the user explicitly
requests plain text, or for compatibility when the running Host/platform lacks
richtext support. Legacy `{account,target,text,operationId}` and typed
`content:{type:"text",text}` retain plain-text wire semantics: this preference
does not convert text inputs. `payload` is a `content` alias; never combine
content fields. Images, audio, files, video and cards remain distinct types,
not richtext substitutes. Discover installed arguments with `help send` and
`help send-many`; CLI guidance does not establish platform capability or grant
permissions. This preference does not change automatic final-response runtime
defaults.

Send requests use `{account, target, content, operationId}`, with
`target: {id, kind, replyTo?, replyMode?}`. `conversation` posts to the main stream;
`reply` quotes `replyTo` there; `thread` replies in a topic. Reply/thread require
an `om_*` message ID and an `oc_*` chat ID; a conversation send must omit
`replyTo`. With no mode, an omitted `replyTo` means conversation and a provided
`replyTo` means quoted reply. `send-many` uses a `targets` array, up to 1,000
destinations per request. Reuse the returned operation ID for reconciliation;
`receipt` accepts `targetCount` for the original batch order. A partial result
includes attempted count and completed receipts. An uncertain effect must not
be blindly replayed. This budget does not limit bindings.

The multi-type outbound candidate also accepts `content` instead of `text`:
text, image, audio, file, video, richtext or a bounded title/body card. Media
content contains a prepared `media:` handle, never a path, URL or base64.
Optional `fallback: {mode:"text",text}` is used only when the requested type
is unsupported; permission, integrity, upload and dispatch failures do not
downgrade. Omit fallback or use `{mode:"reject"}` to reject unsupported types.

Discover `help media-prepare` on the exact running Host. The candidate's
begin/chunk/commit upload keeps each decoded chunk within 64 KiB and each RPC
under the existing 256 KiB transport limit. Begin declares account, exact
target, operation ID, media kind/format, size and SHA256; file/video require a
safe filename. Commit returns a usable handle only after complete bytes,
digest and format checks. Preparation and send both recheck send authority.
Handles are caller-, target- and generation-scoped, expire after ten minutes,
and are invalidated on disposal/restart. Queue acceptance does not extend their
lifetime. For formats, limits and candidate/release boundaries, see
[media availability](channel-media-reactions.md#media-availability).

Protocol runtime v2 defines the separate public outbound surface; its inline
bytes preparation is limited to 128 KiB and does not define the launcher-private
chunk CLI. Public source tickets are unavailable without an authorized producer.
These source changes do not establish release, installation or live platform
verification; older running Hosts may not implement the operations.

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

### Native mentions in explicit richtext sends

Use an inline paragraph to keep a native mention and its explanation on the
same line:

```json
{
  "type": "richtext",
  "blocks": [
    {
      "type": "paragraph",
      "nodes": [
        { "type": "mention", "userId": "ou_verified" },
        { "type": "text", "text": " please review", "style": "plain" }
      ]
    }
  ]
}
```

Each paragraph is one line; existing text/style blocks keep their separate
lines. Use exact platform-native IDs only, never guess them from display names.
The current Feishu/Lark Host verifies only accepted inbound senders observed in
the last five minutes in the exact account, tenant and target conversation during
the active connection lifetime. This is historical identity evidence, not a
current membership check: a member leaving within that window is not immediately
detected. After expiry, missing fresh sender evidence rejects. Users who have
never sent a message are unsupported, including users merely named by an inbound
mention; inbound mention metadata is not currently accepted as identity proof.
Arbitrary contact-directory users and screenshot names cannot be mentioned.
SDK raw sender evidence must explicitly match the application's tenant, native
open_id, user sender type, message ID and chat ID. Missing raw metadata or an
external-tenant sender does not issue evidence; normalized sender IDs alone
are insufficient. Raw event bodies are not retained in the evidence cache.
A reconnect/replacement requiring a new connection loses that evidence; missing
evidence rejects with `CHANNEL_MENTION_UNVERIFIED`. This does not request contact
or directory scopes and does not enable `@all`. A direct-chat ID is not evidence
of a user's identity. Richtext alone does not imply paragraph or native mention
support: inspect outbound v2 flags. Unsupported structure requires an explicit
text fallback; identity and permission failures never fall back. Batch sends
validate all target identities before queueing the first delivery.

Plugin consumers use additive runtime v3 `outboundV2` with send v2 documents;
frozen `outbound` and `adaptersV2` retain v1 content only. No automatic forwarding
behavior changes. Only a sent receipt proves delivery.

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
For a completed turn, explicitly marked final messages take precedence. If the
provider omits message phases, forwarding accepts an unphased message only
when the whole exact turn was read, it is the sole assistant message, and it is
the last item. Explicit commentary, multiple assistant messages, later tool
items, and incomplete pagination remain unavailable for automatic delivery.

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
Agent guidance prefers meaningful explicit progress and completion sends, with
multiple sends allowed. Each intended message uses its own stable operationId;
receipt queries keep that same ID. Progress never disables final fallback.
Only after a manual terminal result has a confirmed `sent` receipt should the
Agent select `none` for the incoming operation to avoid a duplicate final.
Failed, pending, missing, partial, or unknown receipts retain fallback: inspect
the receipt, never blindly resend through a new ID or route. Explicit user
silence/manual-only requests may select `none` without changing profile settings.
MCP defaults the chat from native caller
metadata, checks the turn when available, and cannot choose another chat’s job.
Finished/reserved jobs reject late choices. Policy changes and retries preserve
an already reserved outbox target and delivery ID rather than retargeting it.

This is guidance using existing public send, receipt, and per-turn reply-mode
capabilities, not atomic terminal-send detection. Manual delivery IDs are derived
from caller/account/send operationId; consumer final deliveries use the incoming
job/event. There is no public progress/terminal field or receipt-to-job terminal
link. A confirmed manual result followed by a failed/late `none` selection can
still duplicate the final. Automatic receipt-linked suppression needs a Protocol
owner contract before implementation; the Host does not infer intent from text
or suppress a final merely because any manual send exists.

Only agent-selected outward text is sent; private reasoning, tool output, and
commentary are not indiscriminately forwarded. Background notification requires
a supported lifecycle to return the result to an active authorized turn. Prompt
guidance alone creates neither a scheduler nor a guaranteed wakeup; no new
background-result integration is implemented here.

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

## Provider, model, effort, Fast and project

The unified Channel settings entry adds a **Task models** tab on Manager v12.
It configures creation defaults, per-conversation/per-user defaults and model
permissions. Each binding also exposes its Host-owned current model form.
Older Hosts omit the unsupported tab. Contract and downgrade semantics are in
[task settings v1 / Manager v12](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/channel-runtime/task-settings-v1.md).
This Host also accepts private Fast/project settings through the existing
Host-owned form and CLI. These fields do not expand frozen public execution
settings or older Manager contracts; older Hosts do not support them.

Read `model-list` for the admitted catalog and `task-settings` for a chat's
actual/pending selection. `task-settings-set` accepts
`{sessionId, settings:{providerId?,model?,effort?,fast?,projectId?}, expectedRevision?}`;
`task-config-set` accepts `{config:{defaults,scopes,permissions},expectedRevision}`.
Both use the selected runtime; they do not add providers or accept credentials.
Native tools expose corresponding `channel_*` operations. Source-scoped writes
use the actual received user's rights, even when requested through an Agent.

```text
/models
/model <model> --provider <provider> --effort high
/task-settings --provider <provider> --model <model> --target <chat-id>
/fast on
/fast off --all
/project list
/project <local-project-id> --target <chat-id>
/task-settings --fast false --project <local-project-id> --target <chat-id>
/task-requests
/task-approve <request-id>
/task-deny <request-id>
```

A single binding is selected automatically; multiple bindings offer a choice
of one or all unless the command specifies `--target` or `--all`. A change is
validated against the actual catalog and queued until the chat is idle. Saving,
submission and observed application are distinct states; unknown effects are
not replayed after restart.

Some native Codex versions keep an existing thread's provider fixed. When the
native service explicitly refuses a cross-provider resume, the change is rejected
without retrying it, and `/task-settings` explains that the existing chat can be
kept while a new chat is created for the other provider. A timeout or any
unrecognized native error remains uncertain and is not treated as a refusal.

Model grants constrain platform/account/conversation, users/user groups, changed
fields, Provider, qualified model, effort, Fast values (`fastModes`) and local
projects (`projectIds`). Deny wins and applicable allow
scopes intersect. Reads do not require a mutation grant. An eligible sender can
change directly; otherwise a fixed, expiring request requires explicit approval
by a currently eligible user from the source conversation. Agent tool calls
cannot provide that user's approval. Rights and configuration are rechecked
before the native change.

`model-priority` reads the profile's ordered creation candidates and revision.
The local user can replace them with `model-priority-set --input` containing
`{"expectedRevision":0,"candidates":[{"providerId":"first","model":"one"},{"providerId":"second","model":"two"}]}`.
Read the current revision first; an empty list disables the policy. The sender
must have the existing exact provider and model grants for each eligible choice.
Scoped provider/model defaults take precedence, and existing chats are unchanged.
Before a new task starts, the Host checks each permitted candidate in order using
a dry run that verifies its catalog entry and declared key. Where a direct
Responses connection is available, it also sends a synthetic request with a
15-second timeout per candidate
without user messages or tools; this may incur model usage. Probe HTTP 401/403,
408/429, server errors, network failures, a failed managed connection and timeout
move to the next candidate. A
connection type or response that cannot be probed falls back to the local check,
so its login and service health remain unknown. A successful probe only reflects
that moment. An unsupported effort or Fast setting excludes that candidate
rather than changing the requested setting. After native dispatch,
authentication failures, network errors and timeouts cannot safely trigger a
replay: an uncertain outcome remains subject to reconciliation. This policy does
not automatically transfer conversation history between providers.

Failed or uncertain tasks can send a fixed notice asking the user to contact an
administrator, independently of automatic final replies. `failure-notices`
reads the setting and revision; the local user can disable it with
`failure-notices-set --input '{"expectedRevision":0,"enabled":false}'` using
the current revision. The notice follows the original conversation and send
permissions and does not expose provider errors. Unknown delivery results are
not blindly repeated.

Common profile creation settings are the base layer. Channel defaults, matching
conversation/user rules and explicit selections override that layer; explicit
Fast `false` remains meaningful. Enabling Fast requires catalog support. A
provider/model change to an unsupported model includes Fast disable in the exact
authorized patch. Changes are persisted before native effects and rechecked
between combined operations. Uncertain partial changes require reconciliation.

Project defaults resolve canonical working directories and writable roots before
creating the chat. The new chat's project membership and native settings must be
confirmed before its first turn. A failed confirmation retains the created chat
and starts no turn. Project switching uses the common supplemental service and
enforces the selected roots on later turns. A headless service may opt into
workspace projects by setting `CORDISX_CHANNEL_WORKSPACE` to an absolute,
operator-controlled directory before service startup. The service lists Git
repositories at that directory and its immediate child directories, rejects
paths outside it, and applies the selected repository as the chat's cwd and
writable root. This service-owned selection is not Desktop sidebar membership.
Without that setting, the project catalog remains unavailable. Project selection
retains the Channel sender's existing field/value permissions and applies when
the chat is idle. It also grants a private profile-specific mailbox directory
for the sandboxed Channel CLI; it does not grant all of `/tmp`.

Linux service-mode Channel and supplemental Codex CLI calls from a different
PID namespace use an authenticated, encrypted, profile-scoped file mailbox
when the Host advertises that capability. The sandbox must be allowed to write
the mailbox directory. A read-only sandbox cannot use this writable transport;
its Channel CLI remains unavailable unless an explicitly permitted transport is
provided. A missing mailbox or old Host fails closed; an uncertain result must
be reconciled rather than resent. Direct Host socket access remains the normal
path outside that sandbox. Fresh continuation retains its existing
confirmed configuration/cwd flow; native sidebar project membership inheritance
has not been established by this change.

Headless service startup merges every enabled shared `model-service` declaration
that supports Codex Responses and has Codex model IDs. There is no two-provider
limit. Save these services through the normal Model Services configuration or
`cordisx models services save`, then restart that service instance. Startup
projects their provider tables into the selected Codex home without changing
the native default provider or model. Only saved environment variables needed
by these services' API keys and headers are added to the native app-server
environment; Channel credentials remain excluded. A missing key/header keeps
that declaration out of the admitted catalog and records
`HEADLESS_MODEL_SERVICE_CREDENTIAL_UNAVAILABLE:<provider-id>` without its value.
Disabled services, other-client-only services and empty Codex catalogs are omitted.

For headless deployments with provider configuration external to shared
declarations, an operator can still supply `CORDISX_HEADLESS_PROVIDER_ID` and
`CORDISX_HEADLESS_MODEL_ID`, plus the optional pair
`CORDISX_HEADLESS_EXTRA_PROVIDER` and comma-separated
`CORDISX_HEADLESS_EXTRA_MODELS`. The legacy primary/extra entries are merged
with shared declarations and retain their default model and ordering. These
variables declare the admitted IDs; they do not configure provider authentication
or prove model capabilities. Only native catalog metadata establishes supported
reasoning efforts. An existing chat, including a `notLoaded` chat, cannot switch
providers through this path unless the underlying app-server supports and
confirms that change; an unsupported switch is rejected. Catalog availability
permits new conversations with the requested provider, not cross-provider replay
of an existing conversation.

Some Codex 0.149.1 app-servers advertise `thread/items/list` but return method-not-found
or “not supported yet”. On a first-page `-32601` only, final-message delivery uses
`thread/turns/list` metadata pages (`itemsView:"notLoaded"`, descending, one turn
per page) to locate the exact original turn, then requests that same page with
`itemsView:"full"`. The returned ID and completed status must still match. It does
not load the whole thread or forward another turn's answer. Scanning is limited
to 64 metadata pages, with no further page scheduled after a 45-second scan budget
(an in-flight RPC retains its transport timeout); repeated/invalid cursors and malformed responses fail
closed. Other errors and a later-page `-32601` do not trigger this fallback.

One native turn can still exceed the transport's 2 MiB line limit. A recognized
oversize error reports `NATIVE_COMPLETION_PAGE_TOO_LARGE`; page/deadline exhaustion
reports `NATIVE_COMPLETION_PAGE_LIMIT`. These are failures, not completion or
delivery evidence. The fallback bounds loaded turn count, not native single-turn
bytes, and does not change the transport cap. Final delivery retains its original
stable outbox ID; unknown send receipts are not automatically replayed.

## Model-service continuation (experimental)

The Host can link a new native conversation to its source when switching model
services. Linked mode exposes the approved user and assistant text to the new
conversation on demand; a separately approved saved checkpoint can be passed to
the first Channel job. A compatible full fork inherits native history, including
tool content. The original remains. Existing fresh relations remain readable,
but fresh cannot be selected for a new continuation. A saved fresh preference
requires a new choice; it does not grant history access.

In a direct Channel conversation with exactly one active binding, use
`/continue-provider suggest <provider> <model>` to see the recommended mode
and matching confirmation command. Follow its history and checkpoint flags
explicitly. Fork is currently limited to the same provider and model with no
linked parent; otherwise the default recommendation is linked. A failed or
uncertain native creation never automatically retries with another mode.
Channel dispatch and task-setting permissions are checked again at commit, and
eligible queued messages move with the binding. Group and multiple-binding
migration are unavailable.
Because the Desktop confirmation is entered by a cross-provider Send, the
currently verified same-provider fork is not offered there; Channel can offer
it within the same-provider, same-model scope above.

Desktop support requires `CORDISX_EXPERIMENTAL_LOGICAL_CONTINUATION=1` at launch.
Its confirmation offers a one-time choice, a conversation override, or a profile
default; an override can also be cleared to follow the default. A saved preference
does not grant future history access. The confirmation can show committed
session boundaries authorized for the active Desktop account; selecting a source
opens that native session after the Host rechecks the current identity and scope.
An earlier-conversation action is also shown beside the model selector when the
current Desktop account owns a previous committed boundary. It opens that native
source after the same checks; it does not merge native transcripts. For a
single direct Channel binding, Desktop can migrate the binding and eligible queued
messages after the Channel user sends the exact command shown in the Desktop
confirmation and the Desktop user confirms. A short-lived challenge identifies
that confirmation; it is not an authorization by itself. Linked mode separately
requires both users' consent and a matching live
native and Desktop account. Every source in the linked chain must have no native
fork, attached or parent thread, and Channel jobs must belong to the authorizing
actor. Earlier logical links must have the same two authorized participants;
their original history categories remain in force. History reads check
the account, binding and Channel permission again, and fail closed when account
identity cannot be verified. These paths do not transfer a checkpoint. Other
Channel-bound Desktop modes and Desktop checkpoint transfer are unavailable. The profile
owner coordinates its own native operations and compares bounded source
snapshots; another independent native process modifying the source is outside
that coordination.
Desktop linked mode also requires the renderer account and the independently
read native owner to match before target creation and at turn admission. If the
native owner is unavailable or differs, linked history remains unavailable.
The source must be idle and its effective security settings and default work
mode must be observable. Some native versions do not report an implicit default
mode; explicitly selecting default and completing a source turn can establish
it. If the mode remains unconfirmed, continuation is unavailable. Plan mode
is not supported by this experimental path.

When Desktop explicitly selects a target reasoning effort, the target model
must advertise that effort. The Host preserves the original source setting,
uses the selected target effort for creation and first dispatch, and saves it
for later target turns. Missing or unsupported capability metadata rejects the
selection before native creation.

The Host copies an explicit source name and the native project assignment to the new
session. For an explicitly ordered native section, it places the destination
immediately before the source and checks the order using both model providers.
The native unsectioned list uses recency rather than a movable position; App
pinning and unsectioned order are not established by this path. The previous
native session remains available, and both sessions can appear in the list.

Codex 0.171.0-alpha.13 can create a hidden attached fork before the first turn,
but that fork cannot register the dynamic history tool through the native fork
request. It also prevents deletion of the parent while the attachment exists.
It is not used as a substitute for the linked path.

For an unconfirmed Desktop result, first inspect the source and any target:

```sh
cordisx channel logical-status --input '{"sessionId":"<source-thread-id>"}'
```

An applied operation can report `protectionPending` when this owner still holds
a source or destination migration fence. Inspect the owner before retrying; an
applied relationship does not itself mean that every native protection has been
released.

To inspect confirmed session boundaries ending at a destination, use
`cordisx channel logical-chain --input '{"sessionId":"<destination-thread-id>"}'`.
It lists identifiers, modes and approved categories; it does not display or
grant access to conversation content.

If the operation is `unknown` and the local user accepts that an orphan target
may exist, the following command can release its fence when the current owner
confirms that it has no outstanding native writes or leases for the affected
threads. It does not delete a target or retry the operation. A still-running or
uncertain owner may refuse; inspect and stop the prior operation before using a
fresh owner. An `applied` result needs separate inspection and navigation.

```sh
cordisx channel logical-abandon --input '{"sessionId":"<source-thread-id>","operationId":"<operation-id>","confirmOrphanPossible":true}'
```

These management commands are local-user operations and are unavailable to
an Agent caller. They do not provide a lock against independent native processes.

## Fresh Channel continuation

The live threshold and target-ready path has a separate
[context threshold and continuation reference](context-threshold-continuation.md).
Its ratio uses the effective native automatic compaction threshold; the existing
idle/send-boundary policy described below retains its own window-based semantics.

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

If the native app-server reports that item pagination is unsupported, the
continuation history reader requests at most one complete native turn per
request and pages its projected entries under the normal Host entry and
character limits, reporting `pagination: "native-turn"`. Its opaque cursor binds the source, turn and projection;
changed source data invalidates it. A native turn has no protocol-level item
or byte limit. In headless mode the shared RPC connection has a 2 MiB line
limit; an oversized native response can close that connection and reports
`CONTINUATION_HISTORY_PAGE_TOO_LARGE` when the limit is observed. Desktop native
responses have no fixed CordisX byte cap. This fallback therefore bounds each
returned Host page, not the size of the native turn response.

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
