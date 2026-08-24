# Channel runtime and plugin architecture

Status: approved architecture and delivery contract with an implemented local
productization slice. This document freezes the
product boundary, identity model, Node/renderer split, security and reliability
requirements, extension points, dependency order, PR boundaries, and validation
matrix. The status tables below distinguish the verified simulator/Host work
from unavailable real platform adapters.

## Outcome

CordisX will let an authorized user create, find, open, continue, and control a
CordisX task from an external messaging channel. The first official adapters are
Feishu/Lark and WeCom. A local simulator is a mandatory delivery dependency and
must pass the complete lifecycle matrix without a real developer account.

Channel is a high-level, host-neutral facade over the existing CordisX Platform
and Agent APIs. It is not a second task runtime, does not replace the Provider
Fleet, and does not give a platform adapter raw app-server or renderer access.

The durable transport runtime lives on the Node launcher side. A renderer
plugin may render controlled manager content and invoke a narrow, brokered Host
API, but it never owns platform credentials, webhook listeners, WebSocket
connections, cursors, queues, retry loops, or process supervision.

## Status vocabulary

Every Channel diagnostic, manager snapshot, test report, and release handoff
uses one of these values:

- `implemented`: code exists at the reported revision;
- `verified`: the reported behavior passed the named automated or real smoke;
- `experimental`: evidence exists but the behavior is not a supported contract;
- `unavailable`: the current runtime has no honest conforming path; and
- `planned`: architecture is fixed but implementation has not landed.

`implemented` never implies `verified`, and a protocol reservation never implies
that a launcher, renderer, or real platform adapter is available.

## Audited baseline

The architecture and delivery audit was refreshed on 2026-08-25 against the
formal remote mains before the productization slice was implemented.

| Area | Current evidence | Status for Channel |
| --- | --- | --- |
| Platform identity and operations | `PlatformSessionRef { providerId, remoteSessionId }`; provider-aware model/session list, search, read, create, continue/fork/archive/restore/delete, submit, steer, and interrupt are implemented on `cordisx` main. | implemented and reusable |
| Provider Fleet | Launcher-owned provider processes, provider-specific persistence, generation fencing, and a token-bound normalized RPC exist. | implemented and reusable; native Desktop current connection remains unavailable |
| Agent events and delivery | Agent event v2, delivery snapshots, `followup`, `steer`, `inject`, cancellation-before-claim, and generation/owner fencing exist. | implemented and reusable after an explicit Platform-to-Agent binding is added |
| Permission Broker | Source-bound required/optional declarations, `ask`/`allow`/`deny`, scope checks, audit, and plugin activation reconciliation exist in the renderer runtime. | implemented foundation; the Channel core has a source/generation-bound broker port, while the production Node policy-store adapter remains planned |
| Manager navigation and plugin Config | Configuration protocol #19, Host #60, TDesign-aligned Host forms/collections, and Manager navigation core #106 are merged. | Channel B navigation/route/standard-page data plane and bounded Host `manager.content` mount are implemented and verified; launcher live projection and writes remain unavailable |
| Agent Trace | Fixture, product package, event/delivery lifecycle, and README are merged. | useful notification evidence; not a Channel transport |
| Node plugin surface | The host-neutral core and source-bound Node Cordis `channel` service exist. Package service entries are now source-validated, bundled, integrity-bound into the immutable package object, authority-projected, imported, activated, and disposed by generation. | loader path implemented/verified with the simulator; lifecycle-coordinator orchestration and production gateway/broker/store wiring remain planned |
| Mono pins | Mono was audited read-only against its formal remote main before this slice. | deliberately unchanged by this owning-repo delivery |

The current public `turns.submit` input is a plain string. Sending a remote
message through it would discard Channel provenance. Real Channel ingress is
therefore unavailable until a sourced user-input envelope is enforced by the
host-owned task gateway. The simulator must exercise that envelope first.

## Product operations

The Channel command layer is presentation-neutral. Adapters may expose slash
commands, cards, buttons, or plain text, but all of them normalize into one of
these host operations:

| Operation | Required behavior |
| --- | --- |
| create | Resolve default or named provider, model, profile, workspace alias, and initial user message; return the complete `PlatformSessionRef` even when the initial turn fails. |
| list/search | Return a bounded, deterministic session page with provider identity, title, state, workspace label, model, and update time. |
| status/read | Return a bounded projection of task and active-turn state; content reads require a separate capability from catalog reads. |
| open | Produce a host-owned deep-link intent for the selected complete session reference. |
| continue | Resume an archived or inactive task through Platform task control and make the binding active only after success. |
| followup | Queue a sourced user message for the next turn. |
| steer | Target a running turn/step through the existing Agent delivery semantics when an explicit Platform-to-Agent mapping exists; otherwise use provider `turns.control` only when the adapter supports it. |
| interrupt | Interrupt the selected complete session/turn; never infer a session from a bare remote id. |
| archive/restore | Invoke the reversible Platform controls and retain binding history. Remote delete is not part of version 1. |
| notify | Deliver completion, failure, approval-request, approval-expiry, and other explicitly subscribed events through the durable outbox. |

### Creation routing

A remote request never supplies an arbitrary local path or environment value.
It supplies structured selectors:

```ts
interface ChannelTaskCreateRequest {
  readonly provider?: { readonly id: string } | { readonly useDefault: true }
  readonly model?: { readonly id: string } | { readonly useDefault: true }
  readonly profile?: { readonly id: string } | { readonly useDefault: true }
  readonly workspace: { readonly alias: string }
  readonly message: ChannelUserInput
}
```

The Node host resolves those selectors against a local, allowlisted route
policy. A workspace alias maps to a configured absolute cwd under an authorized
root. Provider, model, profile, and workspace defaults are explicit route data,
not ambient renderer state. Unknown or ambiguous selectors fail closed.

Current Platform creation accepts model, cwd, and an optional plain-string
initial message. Channel delivery requires two compatible changes before real
ingress: host-side profile/workspace routing and the sourced input envelope.

### Open and deep-link behavior

The core returns an opaque `ChannelOpenIntent`, never a platform URL assembled
by an adapter. The Host may project that intent as:

1. a structured `session.header.actions` command inside CordisX;
2. a same-machine custom-scheme link after the launcher has registered and
   verified the scheme; or
3. a future HTTPS relay link only after an explicitly deployed, authenticated
   relay exists.

Until one of those projections is implemented, the manager reports deep links
as `unavailable`. A link on a phone cannot be claimed to open a desktop-local
session merely because a URI string was generated.

## Identity and persistent binding

Channel identity is structured at every layer. Display names are never keys.

```ts
interface ChannelAccountRef {
  readonly adapterId: string
  readonly accountId: string
}

interface ChannelTenantRef extends ChannelAccountRef {
  readonly tenantId: string
}

interface ChannelConversationRef extends ChannelTenantRef {
  readonly conversationId: string
  readonly kind: 'direct' | 'group' | 'broadcast'
}

interface ChannelThreadRef extends ChannelConversationRef {
  readonly threadId: string
  readonly semantics: 'conversation' | 'topic' | 'reply-chain'
}

interface ChannelUserRef extends ChannelTenantRef {
  readonly userId: string
}

interface ChannelEventRef extends ChannelThreadRef {
  readonly eventId: string
  readonly messageId?: string
  readonly actor?: ChannelUserRef
}

interface ChannelSessionBinding {
  readonly bindingId: string
  readonly channel: ChannelThreadRef
  readonly session: PlatformSessionRef
  readonly createdBy: ChannelUserRef
  readonly createdFrom: ChannelEventRef
  readonly routeId: string
  readonly revision: number
  readonly state: 'active' | 'archived' | 'unavailable'
}
```

The canonical Channel endpoint key is:

```text
(adapterId, accountId, tenantId, conversationId, threadId, routeId)
```

The canonical task key remains:

```text
(providerId, remoteSessionId)
```

The binding table stores both complete tuples. Two providers returning the same
remote session id cannot collide. Two bot apps, tenants, or conversations using
the same platform-local id cannot collide either. The actor and originating
event are retained with the binding; every later applied event records the
complete binding revision and Platform session reference in its durable
outcome, so `User` and `Event` are never detached display-only metadata.

### Conversation semantics

- A direct chat uses `kind=direct`. When the platform has no independent topic,
  its stable thread id is the conversation id and semantics are `conversation`.
- A group message without an explicit topic belongs to the group conversation
  endpoint. Ambient group traffic does not create or continue a task unless a
  route policy requires an explicit mention, command, or reply to a bot-owned
  message.
- A native topic uses the platform topic/root id and semantics `topic`.
- A reply chain retains the platform root id, immediate parent id, and message
  id. The binding key uses the stable root/thread id; the parent/message ids are
  event metadata, not new task identities.
- A platform without groups or topics must not synthesize those features in its
  adapter. For example, a WeChat Service Account is a direct user-to-account
  conversation, not a personal WeChat group.

One task may have several explicit Channel bindings, but one inbound endpoint
and route has at most one active binding revision. Rebinding records history and
increments the revision; it never silently overwrites the previous task.

## Runtime boundary

```text
platform webhook / WebSocket / simulator
                  |
                  v
      Node Channel service adapter
      verify -> normalize -> persist
                  |
                  v
      Channel Runtime Core + durable store
      policy / binding / queue / audit
           |                  |
           v                  v
   ChannelTaskGateway      durable outbox
           |                  |
           v                  v
 Platform/Agent adapters    platform send
           |
           v
   provider process or honest unavailable native adapter

renderer plugin
      |
      v
brokered Channel Host API -> snapshots/actions only
      |
      v
CordisX-owned Settings and structured session actions
```

### New Node-side service extension point

The audit found no conforming way for a normal CordisX package to register a
Node transport. Reusing a renderer entry, importing launcher internals, or
calling the raw CDP binding would violate the existing boundary. A versioned
Node service extension point is required.

The protocol PR defines a package service declaration with a launcher-resolved
entry and a closed service kind such as `channel-adapter`. The launcher binds
canonical package source/id, generation, granted capabilities, configuration,
and secret handles before loading the service. The service cannot supply or
replace its own identity.

The high-level Node facade is intentionally DSH/OneWorks-like:

```ts
defineChannelService({
  descriptor,
  createConnection(host) {
    return {
      start(handlers) {},
      send(message, control) {},
      stop(reason) {},
    }
  },
})
```

`host` exposes normalized logging, clocks, durable queue handles, secret
handles, attachment quarantine, and the Channel task gateway. It does not
expose a renderer, DOM, CDP session, raw provider transport, child-process
handle, app-server JSON-RPC client, or secret value export.

The facade is a lifecycle adapter, not a parallel agent runtime. Task methods
delegate to the lower-level CordisX Platform/Agent implementation.

### Node Cordis service and cross-plugin effects

The launcher owns a Node-side Cordis root context and provides one high-level
`channel` service. A manifest-declared `channel-adapter` service contributes a
connection through a generation-owned Cordis effect; another Node plugin may
inject `channel` to list available connections, subscribe to normalized
messages, or enqueue a send. The raw adapter connection is never a service
value visible to consumers.

```ts
export const inject = ['channel']

export async function apply(ctx: Context) {
  const dispose = await ctx.channel.messages.subscribe(filter, event => {
    // event.input is still sourced role=user content
  })
  ctx.effect(() => dispose)

  await ctx.channel.messages.send({ target, kind: 'reply', text })
}
```

The launcher creates every plugin child context with canonical package source,
plugin id, and generation metadata. The `channel` service resolves that caller
context on every method, just as the existing Platform service resolves its
runtime-bound plugin identity. A plugin cannot pass a caller id or reuse a
facade after its generation is disposed.

Connection discovery requires `channel.accounts.read`, normalized-message
subscription requires `channel.events.subscribe`, and sends require
`channel.messages.send`. Each call also checks the structured Channel scope.
Adapter-side `channel.events.receive` remains a distinct authority to accept
and persist platform ingress; it does not automatically grant another plugin
message content.

Subscriptions attach only after the core has durably accepted and attributed
the input. Consumer handlers receive no raw callback body, transport client,
secret, cursor, filesystem path, or task-gateway handle. Handler failure is
isolated from platform acknowledgement and from other consumers. Durable
consumer checkpoints and at-least-once replay are required before a subscription
is described as reliable across restart; an in-process notification-only watch
must be labeled `experimental` and cannot claim durable delivery.

Adapter registration, subscriptions, connection watches, and other resources
return Cordis disposers and are tied to the owning fiber. Replacement fences
the old generation before publishing the new connection, and fiber disposal
removes its consumers/contributions without stopping unrelated adapters.

### Process lifetime

Version 1 runs as a launcher-owned companion or service fiber. It may keep a
long connection and background workers alive independently of renderer
reloads, but it remains supervised by the tracked CordisX launcher generation.
Renderer replacement cannot restart or inherit the transport.

Restart recovery means recovery after a companion/launcher restart. Version 1
does not promise 24-hour delivery while CordisX is completely stopped. A
login-item, daemon, or separately deployed relay would require a later explicit
installation/deployment contract and is not implied by this architecture.

### Renderer Host API

The renderer receives only frozen, bounded snapshots and commands:

- channel/account/route/binding configuration metadata with secrets replaced
  by host handles and readiness state;
- connection health, cursor age, queue counts, last success/error, generation,
  and last-good revision;
- audited actions to enable/disable, reconnect, retry/dead-letter, bind/unbind,
  and test a simulator route; and
- structured open/share/status command results.

Every action rechecks plugin identity, capability, generation, target scope,
and current policy in the Host. There is no public raw bridge and no generic
request method.

## Channel core and adapter layering

The core owns platform-independent behavior:

- identities and bindings;
- sourced input normalization;
- whitelist and route policy;
- durable inbox/outbox, retry, dead letter, cursors, and checkpoints;
- task command dispatch;
- notification subscriptions and formatting model;
- audit records, generation fencing, and last-good activation; and
- bounded manager snapshots.

An adapter owns only platform-specific behavior:

- credential/transport bootstrap;
- webhook or long-connection verification;
- platform payload normalization;
- platform ids and direct/group/topic/reply mapping;
- message/card/file formatting and size/rate constraints; and
- platform send/update/recall handles where officially supported.

Adapters never implement task routing, bind sessions by display name, mutate
prompts, decide CordisX permissions, or persist their own uncoordinated retry
queue.

## Official platform feasibility

The following source set was checked on 2026-08-24. Official documentation may
change, so real-adapter work must pin the SDK version and refresh the source
matrix in its PR.

| Platform surface | Inbound/outbound feasibility | Credentials and network | CordisX decision |
| --- | --- | --- | --- |
| Feishu/Lark app bot | Official Open Platform supports bot apps, message APIs, events, webhook dispatch, and SDK WebSocket long connection. The official Node SDK states long connection needs outbound internet but no public IP/domain; event handling must complete within the platform timeout and long connection does not cover callback subscriptions. | Developer app, bot capability, App ID/Secret, granted scopes, event subscription, published/approved version. Webhook mode needs a public callback; long connection does not. | planned first adapter; prefer long connection for message events and use webhook only for required callback types. |
| WeCom intelligent bot | Official 2026-05 documentation supports either webhook or WebSocket API mode. Long connection supports direct/group-mention messages, events, replies, streaming updates, and limited proactive sends after the user has contacted the bot. One bot permits one active connection and requires heartbeat/reconnect ownership. | BotID and long-connection Secret; outbound internet, no public callback for WebSocket. Webhook mode instead uses URL/Token/EncodingAESKey, and switching modes invalidates the other. | planned first-class WeCom adapter; prefer the official long-connection mode when the tenant exposes it. |
| WeCom enterprise application | Official callback verification/encryption and application message APIs support internal users and app-created chats. | CorpID, AgentID, CorpSecret, callback Token/EncodingAESKey, and a public HTTPS callback for inbound. | feasible second WeCom adapter mode where intelligent-bot long connection is unavailable or enterprise-app identity is required. |
| WeCom “message push” (formerly group robot) | Official webhook pushes messages into the configured group. It is not the bidirectional intelligent-bot receive path. | Secret webhook URL; outbound HTTPS only. | optional notification-only adapter; cannot create or continue task bindings from inbound messages. |
| WeChat Service Account | Official service-account server integration receives user messages at a developer URL, recommends MsgId deduplication, retries when the server misses the response deadline, and supports passive replies plus separately constrained service-account send APIs. It has no personal-chat group/topic semantics. | Registered Service Account, developer server URL/Token and encryption settings; AppID/AppSecret for active APIs; public HTTPS endpoint. | feasible direct-conversation adapter after webhook security and account eligibility are verified. |
| Personal WeChat account/client | The reviewed official developer surfaces cover Service Accounts, Mini Programs, WeCom, and related approved products; no authorized public API was found for intercepting or impersonating a normal personal client's chats. | No conforming credential/transport contract identified. | `unavailable`; do not use reverse-engineered clients, database polling, injection, or unauthorized hooks. |

Primary source references:

- Feishu/Lark Open Platform: <https://open.feishu.cn/> and the official Node
  SDK at <https://github.com/larksuite/node-sdk> (audited main
  `f54b49f3566c52b54c598194b7ed3015e3e24224`).
- WeCom callback configuration, application messages, group/application push,
  and long connection:
  <https://developer.work.weixin.qq.com/document/path/90930>,
  <https://developer.work.weixin.qq.com/document/path/90372>,
  <https://developer.work.weixin.qq.com/document/path/90248>,
  <https://developer.work.weixin.qq.com/document/path/91770>, and
  <https://developer.work.weixin.qq.com/document/path/101463>.
- WeChat Service Account server development and inbound messages:
  <https://developers.weixin.qq.com/doc/service/guide/dev/> and
  <https://developers.weixin.qq.com/doc/service/guide/product/message/Receiving_standard_messages.html>.

The personal-WeChat result is an explicit absence-based feasibility finding,
not a claim that every private Tencent integration was inspected. CordisX
still treats it as unavailable unless Tencent publishes and authorizes a
conforming public surface.

## Config Schema compliance audit

This audit was refreshed on 2026-08-25 against plugin configuration protocol
`cordisx-protocol#19`, Host configuration `cordisx#60`, its simplified Manager
projection `cordisx#64`, launcher service configuration Host `cordisx#107`,
and Channel configuration protocol `cordisx-protocol#21` (`e4c3a15`).

The earlier Channel service declaration carried only `configurationRevision`.
That was runtime state, not a configuration contract: adapter connections,
routes, task mappings, retry, and rate options had neither an exact schema nor a
Manager projection. Manifest v2 is closed and cannot receive a new optional
field without becoming incompatible with conforming v2 hosts. That gap was
fixed without changing the closed older document. The current package contract
is plugin-package v3 plus plugin-manifest v4; it carries the same exact
Host/no-config service configuration declaration introduced by the Channel
schema work.

| Configuration axis | Versioned source schema | Manager projection | Current Host status |
| --- | --- | --- | --- |
| Node service configuration presence | Every manifest-v4 service declares `configuration.kind=host` with the exact Channel schema and closed legacy `configApplies=restart`, or `kind=none`. The Host maps a Channel Node service to the precise `service-restart` plane from #107. | The schema projection is `standard/renderable=false`; a `none` service produces no descriptor, empty object, revision, or form. | declaration parser, Host service-config contract, and immutable launcher service loader verified; normal lifecycle registration remains planned |
| Adapter connections | Tenant-qualified ref, official adapter kind, enabled state, compatible transport mode, callback alias where required, and optional opaque `secretRef`. | Same non-secret fields plus `secretState`; no reference string. | parser and projection verified; live transports planned |
| Route/mapping | Route id, connection ref, conversation/user allowlists, group trigger/command prefix, explicit provider/model/profile selector, workspace alias, and notifications. | Same redacted structured values. | schema/parse/projection verified; policy/task-gateway enforcement integration planned |
| Retry/reliability | Lease, attempt/base/max/age/jitter, account/user/conversation rate, concurrency/backlog, and attachment limits. | Same structured non-secret values. | schema/parse/projection verified; the current core still takes only lease/max-attempt/base-delay constructor options, so complete enforcement is planned |
| Credential state | Source config accepts only `keychain:` or `host-secret:` references; inline/plaintext fields fail closed. | The generic Host descriptor carries only secret field paths/set state; the Channel body projection carries `missing`, `ready`, or `unavailable`; neither carries the reference value. | preservation/redaction verified; credential creation/resolution broker unavailable |
| Persistence/application | Manifest `restart` is normalized by the Channel Host contract to `service-restart`; the shared #107 API owns revision CAS, generation/owner fencing, restart callback, rollback, and last-good publication. | revision, last-good, generation, `service-restart`, writable state. | contract + shared narrow API verified with an opaque handle; normal launcher handler and Manager writer registration planned |

This configuration does not use a renderer module's `Config` export. A Channel
transport survives renderer reloads and owns Node queues, cursors, callbacks,
and credentials, so copying its config into the ordinary plugin form would put
the lifecycle and secret boundary in the wrong process. Its shared Host schema
projection is explicitly `standard/renderable=false`; the Channel Manager body
consumes only the redacted service/Manager projection and will invoke narrow
Host actions after the writer exists. If a package separately has renderer-only product preferences,
that renderer module should export Schemastery `Config` plus `configApplies` and
remain an independently identified configuration document.

The local simulator fixture is the first configuration-complete adapter. It
validates connection, route/task mapping, notifications, retry/rate, and
attachment limits without an account or secret. A separate static-notifier
fixture declares `kind=none`, proving that no meaningless fields or default form
are manufactured.

## Security model

### Access policy

The core evaluates all of these before a task operation:

1. enabled Channel account and route;
2. tenant allowlist;
3. direct/group policy;
4. conversation/group allowlist and denylist;
5. user allowlist and denylist;
6. mention/reply/command ingress rule;
7. CordisX capability declaration and `ask`/`allow`/`deny` policy;
8. provider/profile/workspace/session scope; and
9. rate, concurrency, backlog, and attachment limits.

Admins are explicit scoped principals, not a magic username string. A platform
user id is always qualified by account and tenant. Identity linking never means
CordisX owns or can impersonate the user's platform login.

### Event verification and replay defense

Webhook adapters must verify the official signature/encryption scheme against
the exact raw body before parsing business data. They enforce a bounded time
window, constant-time comparisons where applicable, and a durable replay key.
Long-connection adapters authenticate the connection through the official SDK
or protocol and still persist platform event/message ids for replay defense.

The inbox uniqueness key is `(adapterId, accountId, eventId)`. When a platform
does not provide an event id, the adapter derives a documented stable key only
from signed immutable fields; a random receive-time id is not idempotency.

### Sourced user input

Remote content enters the task gateway only as:

```ts
interface ChannelUserInput {
  readonly role: 'user'
  readonly content: readonly ChannelContentBlock[]
  readonly source: {
    readonly kind: 'channel'
    readonly account: ChannelAccountRef
    readonly tenantId: string
    readonly conversationId: string
    readonly threadId: string
    readonly userId?: string
    readonly eventId: string
  }
}
```

The adapter cannot request `system`, `developer`, `application`, `trusted`, or
another user identity. Mention text, card fields, attachment names, quoted
messages, and platform metadata remain untrusted user content. A local route
may contribute a host-authored policy section, but no remote message or adapter
payload may become a system/developer prompt.

The existing Agent source stamping and append-only input model are reused. A
Channel adapter cannot mutate earlier native/user messages or send an
unattributed full message batch.

### Secrets and attachments

Configuration stores only a host secret reference such as
`secretRef: "keychain:cordisx/channel/..."`. The launcher resolves it inside the
Node service boundary. Secret values never enter:

- the renderer bundle or globals;
- logs, errors, traces, manager snapshots, or diagnostics exports;
- plugin-readable configuration;
- event, inbox, outbox, binding, or audit rows; or
- deep links and notification payloads.

Attachments are fetched by the Node adapter into a size/type-limited quarantine
with randomized storage names, content hashing, expiry, and no execute bit.
The renderer receives metadata or an opaque transfer handle, never a raw local
path. Unsupported or unsafe media remains an attributed reference with an
explicit unavailable diagnostic.

## Permission contract

Channel service capabilities are added to the same versioned manifest and
Permission Broker model; they do not create a second grant store.

| Capability | First use | Requirement |
| --- | --- | --- |
| `channel.accounts.read` | list/watch brokered connection metadata | required for a consumer plugin; does not reveal config or secrets |
| `channel.accounts.connect` | start webhook/long-connection account | required for a live adapter; `ask` may keep the service pending |
| `channel.events.receive` | persist and normalize inbound events | required, scoped to accounts/tenants/conversations |
| `channel.events.subscribe` | consume sourced normalized messages from another plugin | required for consumer subscriptions; no raw platform payload |
| `channel.messages.send` | notifications, replies, updates | required for bidirectional adapters; optional for receive-only simulation |
| `channel.bindings.read` | inspect existing endpoint/task binding | required for continue/query |
| `channel.bindings.write` | create/rebind/archive binding | required for create/continue/bind operations |
| `channel.attachments.read` | fetch inbound files/media | optional |
| existing Platform task/model/turn capabilities | list, read, create, control, submit | required or optional per declared Channel route |
| existing Agent event/message capabilities | observe lifecycle, followup/steer, approval notifications | optional until an explicit mapped Agent session is available |

Scopes add structured Channel account, tenant, conversation, and user bounds;
existing provider, cwd-root, and complete Platform session bounds remain in
force. An `ask` decision is attributable to the external user request but must
be resolved by an authorized CordisX principal. A channel message cannot click
through or self-approve its own capability prompt.

### Audit and reversibility

Every operation records source package identity, Channel actor, endpoint,
complete Platform target, capability/declaration fingerprint, policy result,
adapter/runtime generation, binding revision, and outcome. Audit projections
redact user content by default.

Queued Channel delivery returns a handle and is cancellable until claimed by
the adapter. Claim is the boundary at which an external send may become
irreversible. After claim, cancellation reports `irreversible` unless the
platform returns an official recall/delete handle and that separate action is
authorized. The runtime never rewrites a claimed delivery as cancelled.

Task archive/restore and Channel bind/unbind return normal reversible result
handles. A successful external send with no official recall is reported
honestly as irreversible.

## Reliability contract

CordisX promises at-least-once processing with idempotency. It never promises
exactly-once delivery.

### Durable inbox

1. Adapter authenticates and minimally validates the event.
2. Core atomically inserts the normalized envelope, replay key, adapter
   generation, and receive checkpoint.
3. Adapter acknowledges the platform as soon as its protocol permits.
4. A worker claims the row with a lease and executes the policy/task operation.
5. The row records applied, retryable failure, terminal failure, or dead letter.

A duplicate insert returns the original durable outcome and does not repeat the
task operation. Crash after persistence and before application is recovered by
lease expiry. Crash after application is reconciled through a durable operation
id/idempotency key and result record before any retry.

### Durable outbox

Notifications and replies are inserted in the same durable transaction that
commits the triggering task/event checkpoint where possible. A worker claims,
sends, and records the platform result. Exponential backoff uses bounded jitter,
attempt and age limits, platform rate-limit hints, and a dead-letter terminal.

If the platform offers a client idempotency key, CordisX uses the outbox id. If
it does not, a crash after remote acceptance and before local commit may produce
a duplicate; diagnostics report that risk instead of claiming exactly-once.

### Cursor, restart, and generation

The durable store owns:

- webhook replay windows and long-connection cursors/checkpoints;
- inbox/outbox leases, attempts, next-attempt time, and dead letters;
- binding revisions and notification subscriptions;
- adapter configuration revision and last-good non-secret snapshot;
- runtime/adapter generation and shutdown reason; and
- bounded audit and health state.

Replacement activates a staged generation, completes its validation, then
atomically publishes the adapter/runtime/config tuple. The previous generation
drains in-flight claims and cannot acquire new work. Stale callbacks, cursors,
updates, disposers, and send completions cannot mutate the new generation.

If staged activation fails, the last-good generation remains active. If no
last-good exists, the account is `unavailable`; the runtime does not run a
partially initialized transport.

## Completion, failure, and approval notifications

Notification routing subscribes a binding to normalized task/Agent events and
stores the last delivered event sequence/checkpoint. Completion and failure
must be terminal-event driven, not inferred from a quiet timer or UI text.

Approval notifications require a new typed, expiring approval event and
resolution handle. The current Agent event contract does not expose a complete
approval-resolution surface, so approval notification/action is `planned` and
must not be simulated as working against a real provider. Phase one may emit a
simulator approval request and prove deny/expiry/idempotency behavior.

Remote approval resolution, if later added, must include request identity,
allowed choices, expiry, requesting tool/action summary, authorized Channel
principal, and a one-time brokered resolution. It never grants a standing
capability or bypasses the native approval policy.

## Manager and session UI

Channel management uses the distinct B pair
`manager.settings.navigation-items` and `manager.content`. The built-in
`cordisx:channel` renderer bundle contributes one structured navigation record,
a same-owner `/manager/extensions/channels` route, standard page metadata, and
a manifest-v4 service declaration. The internal Host Channel Manager body
renderer owns all body nodes, styles, state indicators, adaptive searchable
collections, empty states, diagnostics, theme projection, accessibility, and
cleanup; the plugin receives no header or navigation DOM.

The data plane and read-only Manager page are `implemented/verified`: isolated
`app://-/index.html` CDP evidence proves an active plugin with `schemaKind=none`,
valid authorized B registration, exact route, separate route/page metadata,
standard Host icon/header, active `manager.content` mount, and a bounded Channel
body. The Host owns navigation, header, seat, theme, accessibility, and cleanup;
the Channel renderer contributes no navigation or header DOM. This is still a
simulator/read-only status page, not a connected account manager.

Launcher-to-renderer live snapshot transport, configuration writes,
reconnect/dead-letter actions, and credential operations remain `planned` or
`unavailable`. The complete Channel settings experience needs:

1. channels and adapter availability;
2. accounts and secret-handle readiness;
3. routes, default provider/model/profile/workspace aliases, and access policy;
4. active and historical bindings;
5. notification subscriptions;
6. runtime generation, connection/cursor health, queue/retry/dead-letter state;
   and
7. redacted diagnostics and simulator controls.

The plugin detail README explains setup and official platform constraints.
`配置管理`, `权限`, `运行状态`, and diagnostics use the existing manager
hierarchy. No `secretRef`, secret value, raw callback body, full user message,
or attachment path appears in the manager snapshot. The current page has no
credential input and no generic renderer-to-launcher request bridge.

An active bound session may contribute a structured utility/status action and
open/share command through the existing `session.header.actions` surface. The
Host owns the DOM, style, tooltip, keyboard/a11y behavior, overflow, and
cleanup. Channel plugins receive no title node, selector, render callback, CSS
seat, or arbitrary header mount.

## DSH and OneWorks compatibility

The local OneWorks authoritative source was checked through its fetched
`origin/main` at `9f6b048977bfdc5f8fd6f54c88ab1742261762fa` without modifying its dirty
checkout. Reusable concepts include:

- `defineChannel` / connection lifecycle separation;
- adapter-normalized account, conversation, thread, root, reply, message, and
  navigation references;
- direct/group and mention-aware ingress policy;
- persistent Channel-to-session binding and message-id deduplication;
- ack/unack, outbound update, availability, and connection cleanup hooks; and
- a host pipeline that keeps platform payload parsing in adapter packages.

CordisX does not copy the OneWorks server pipeline or treat its session id as a
CordisX Platform identity. The CordisX facade retains complete provider/session
references, Cordis fiber/generation ownership, Platform/Agent permission
enforcement, durable inbox/outbox, and secret handles.

The same facade is a normal Node Cordis service: adapter packages contribute
lifecycle-owned connections, while other source-bound plugins consume
brokered list/subscribe/send operations. This preserves useful plugin
composition without exposing a raw transport or creating a second permission
system.

OneWorks permits channel-specific prompt composition in its own runtime.
CordisX does not carry that behavior across for remote payloads: Channel input
is sourced user content only. Any host-authored local route policy is a separate
trusted configuration contribution.

A future compatibility shim may implement the high-level Channel connection
shape over CordisX's Node service Host API. The lower-level authority remains
CordisX Platform/Agent; there is only one task runtime and one broker model.

## Repository ownership and package plan

No new GitHub repository is required for the approved scope. The existing
`cordisx` monorepo can own:

- `packages/channel-runtime`: Node-only core, service Host API, persistence
  ports, queue/binding/policy/task gateway, and simulator;
- `packages/channel-adapter-feishu`: Feishu/Lark official SDK adapter;
- `packages/channel-adapter-wecom`: WeCom intelligent-bot and explicitly
  separated enterprise-application modes;
- `packages/channel-adapter-wechat-service`: later Service Account webhook
  adapter; and
- renderer-side manager/demo packages that use only public structured UI and
  the brokered Channel Host API.

Implementation-specific types and stores stay in `cordisx`. Stable package
service declarations, sourced-input/binding snapshots, capabilities, and
version compatibility live in `cordisx-protocol`. CordisXMono pins only merged
compatible commits.

A separately deployed public relay might eventually deserve a new repository,
but it is not needed for the launcher-side service and is not authorized by
this plan.

## Delivery order and PR boundaries

1. **Architecture (`cordisx`)**: this document and the architecture/docs/development-plan
   indexes. No platform runtime code lands first.
2. **Protocol (`cordisx-protocol`)**: versioned Node service declaration,
   Channel identities and binding projection, sourced user-input envelope,
   Channel scopes/capabilities, snapshots, compatibility/downgrade behavior,
   source config/redacted descriptor, explicit no-config mode, schemas, vectors,
   and conformance. Older hosts reject the newer manifest/package versions.
3. **Node host/core (`cordisx`)**: versioned Host config parser/redacted
   projection, immutable launcher service artifact loader/authority, Node Cordis
   `channel` service, source/generation-bound cross-plugin list/subscribe/send,
   shared broker authority, secret handles, durable store, inbox/outbox, task
   gateway, attachment quarantine, simulator adapter, and headless tests.
   The core/simulator and immutable loader are implemented and verified. Formal
   lifecycle-coordinator orchestration, production policy/gateway/store adapters,
   credential broker, and full configured restart remain separate follow-ups.
4. **Platform adapters (`cordisx`)**: independent Feishu/Lark and WeCom package
   PRs based only on official SDK/protocols. They include deterministic mocked
   wire tests and no real credential in fixtures.
5. **Manager UI/settings (`cordisx`)**: the structured Channel B navigation,
   route/standard-page metadata, Host-owned body renderer, README, permission
   manifest, safe simulator projection, and unavailable default are implemented
   in this slice. The Manager B DOM mount is implemented and verified; writable
   service configuration/actions and `session.header.actions` status/open entry
   remain follow-ups.
6. **Simulated end-to-end plugin/demo (`cordisx`)**: the packaged-service loader
   and renderer projection/body are each verified locally. A single launcher
   orchestration that drives both from the same persistent simulator service is
   still planned and must precede claims of an end-to-end usable plugin.
7. **Real smoke (`cordisx`)**: opt-in Feishu and WeCom tests only when an
   authorized developer account and credentials are supplied. Public webhook,
   developer registration, app publication, or deployment is never fabricated.
8. **Mono (`cordisxmono`)**: only after explicit parent coordination and every required owning PR is merged and
   compatible validation passes, pin exact merged owner commits from a fresh
   mono main. Keep `roadmap update = none` and do not stage unrelated gitlinks.

Architecture, protocol, core, each real adapter, generic Settings host, Channel
UI, simulated demo, real-smoke evidence, and mono remain independently
reviewable. A source branch head is never a final gitlink.

## Validation matrix

| Layer | Required evidence |
| --- | --- |
| Protocol/versioning | Older manifests/hosts reject newer package/manifest versions; exact versions, explicit `host`/`none`, closed enums, unknown fields, spoofed source/generation, naked session ids, plain-string Channel input, and secret values fail closed. |
| Configuration | Connections, compatible official transport modes, routes/mappings, user/conversation/group policy, provider/model/profile/workspace selectors, notifications, retry/rate/backlog/attachment limits, duplicate/orphan references, revision/last-good, and explicit no-config; `secretRef` is launcher-only and absent from the Manager descriptor/default form. |
| Identity | Same remote session id across providers, same conversation/user id across accounts/tenants, direct/group/topic/reply semantics, rebind revision/history, and stale binding selection cannot collide. |
| Creation/query/control | Default and explicit provider/model/profile/workspace; invalid/ambiguous alias; created-plus-initial-turn-failure retention; list/search/read/status/open intent; continue/followup/steer/interrupt/archive/restore. |
| Sourced input | Every remote message is `role=user` with immutable Channel provenance; adapters cannot request system/developer/trusted roles, mutate prior messages, or submit an unattributed batch. |
| Permissions | required/optional activation, `ask`/`allow`/`deny`, timeout, account/tenant/conversation/user/provider/workspace/session scope, adapter receive versus consumer subscribe separation, source-bound cross-plugin list/send, policy change, and no self-approval from the channel. |
| Webhook security | exact raw-body verification, encryption/decryption where official, time window, constant-time comparison, replay key, invalid signature, stale timestamp, duplicate id, malformed payload, and fast durable acknowledgement. |
| Long connection | authenticated subscribe, single-connection rule where applicable, heartbeat, reconnect/backoff, duplicate event, cursor/checkpoint, handler timeout, platform rate limit, clean stop, and no renderer-owned socket. |
| Durable inbox | duplicate before/after completion, crash before claim, crash after claim, lease expiry, restart recovery, retry/backoff, terminal/dead letter, and operation-id reconciliation. |
| Durable outbox | completion/failure notification, send retry, rate-limit hint, restart, duplicate-risk diagnostic without platform idempotency, pre-claim cancel, claimed irreversible result, and optional official recall handle. |
| Generation/activation | staged generation, validation failure, last-good retention, drain, stale callback/cursor/send completion/disposer rejection, plugin block/restore, and generation dispose. |
| Secrets/attachments | secret handle only, redacted logs/errors/snapshots/audit, no renderer/config plaintext, size/type/hash/expiry quarantine, unsafe media refusal, and opaque transfer handles. |
| Simulator phase one | create, continue, completion/failure notification, duplicate inbound event, restart, retry/dead letter, permission denial, approval expiry/deny fixture, binding revision, and generation disposal without a real account. |
| Adapter conformance | official fixture normalization, direct/group/topic/reply mapping, outbound formatting/limits, token refresh where applicable, platform-specific retry hints, and no unsupported personal-WeChat path. |
| Manager data plane and DOM | Implemented/verified: valid authorized B navigation record, exact `manager.content` route, Host-rendered route label and page header, `schemaKind=none`, controlled mount, redacted account/route/binding/diagnostic collections, close/reopen cleanup, and no `secretRef`/secret/raw payload. Writable actions remain planned. |
| Session surface | structured Channel status/open/share action only; no arbitrary title DOM/CSS, no native node replacement, correct composite session target, policy hide/restore, and generation cleanup. |
| Real smoke | exact SDK, CordisX, protocol, adapter, account mode, and app version; authorized account only; one inbound create/continue and one outbound notification; redacted evidence; unavailable features reported honestly. |
| Release | focused tests, typecheck, build, full `npm run check`, audit, `git diff --check`, isolated real `app://-/index.html` smoke, normal PR/CI, and head-fenced owning merge. Mono and roadmap remain untouched by this slice. |

Screenshots complement UI assertions; they do not prove signature verification,
durability, policy enforcement, or secret isolation. Mock or simulator evidence
does not prove a real platform account is configured.
