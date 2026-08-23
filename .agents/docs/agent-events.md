# Agent event and messaging architecture

Status: approved implementation architecture for the version-2 Agent event
and delivery-control slice. Normative plugin-visible behavior lives in
`cordisx-protocol` at `cordisx.agent-events/v2` (schema version 2), with
delivery snapshots at `cordisx.agent-delivery/v1`. Version 1 landed at
`e6155723528a888d1b949a9c56483340874cff27`; version 2 merged at
`08dcdc11aae38ea9c0e91e4ad17cf31b8c756747`, descending from UI-catalog
baseline `2ec9ca15234e778853104d1667c7d1c4bffff1d9` so provider-aware Platform
scopes and the independent UI catalog remain intact.

## Boundary and ownership

This slice supplies adapter-neutral Session/Agent observations and a
permission-brokered DSH-compatible messaging facade. It is shared
infrastructure for future runtime status, audit, and projections. It does not
define or render a Timeline, session header, route, button, DOM seat, surface,
outlet, or demo plugin. Session, turn, step, message, item, tool-call, and
context ids are stable correlation keys only.

CordisX owns the runtime ledger, permissions, plugin attribution, query and
subscription service, pre-step waterfall, prompt contributions, and adapter
boundary. The Codex-specific adapter privately owns app-server method names,
notification shapes, and `additionalContext` projection. Claude Code, Zcode,
and future adapters must produce the same public events without leaking their
transport fields.

The default renderer still has no audited reference to the Desktop's current
app-server request client or notification stream. Product code must not start
a second app-server, use the raw Electron bridge, modify the installed App, or
claim that an isolated test connection is the current Desktop connection.
Until a host-private current-connection seat exists, the Codex live adapter
reports `current-connection-client-unavailable` and accepts no writes.

## Shared runtime

```text
launcher-owned plugin identity + normalized manifest
                         |
                         v
                  PermissionBroker
                    /           \
                   v             v
            ctx.platform      HostAgentRuntime
                                 |       |
                                 v       v
                         ctx.agentEvents ctx.agents
                                         ctx.systemPrompt
                                 |
                                 v
                       host-owned AgentAdapter
                        /                 \
                       v                   v
              unavailable default   controlled Codex feed
```

`ctx.platform`, `ctx.agentEvents`, `ctx.agents`, and `ctx.systemPrompt` share
one `PermissionBroker`, one generation, and one host adapter instance. The
high-level queues and low-level observation ledger therefore cannot become
competing sources of session state. Services resolve the calling Cordis fiber
through host-bound `(source, plugin id, version, generation)` identity; public
calls never accept a source, role, trust level, or native application identity.

The append-only ledger assigns a monotonically increasing `seq` within each
session and the stable id `cxevt:<escaped-session-id>:<seq>`. It rejects a
duplicate event id, a sequence gap, and an out-of-order append before
publication. Committed events are immutable copies. Query results are bounded
and cursor-paged; subscriptions publish only committed ranges and never hand
out the mutable store. Content chunks carry an index and optional immutable
content reference so an adapter may coalesce a high-frequency stream without
forcing a UI policy.

The public envelope records:

- `observed`, `cordisx`, or `inferred` provenance; an inference can never be
  emitted as a host observation;
- adapter-neutral source and causal parent;
- session plus optional turn, step, item, message, tool-call, and context ids;
- plugin source/id/version/generation for plugin-originated actions; and
- one of the nine protocol event types: `session.lifecycle`,
  `turn.lifecycle`, `step.lifecycle`, `item.lifecycle`, `message.observed`,
  `message.delivery`, `input.contribution`, `content.chunk`, or `diagnostic`.

## Agent facade and delivery state

`ctx.agents.send(message, target, wakeup)` is the primitive. Its convenience
methods are aligned with DeepSeek Harness `dsh-v0.1.1-rc.2` at
`deepseek-harness@b150a551`:

| Method | Target | Wakeup | Semantic |
| --- | --- | --- | --- |
| `followup(message)` | `next-turn` | `true` | waking next turn |
| `steer(message)` | `next-step` | `true` | waking next step |
| `inject(message)` | `next-step` | `false` | non-waking next-step queue |

Every send method returns an immutable public delivery handle bound to the
calling plugin owner and current generation. The handle exposes its stable
`deliveryId`, a current typed snapshot, and `cancel()`. The Agent handle also
exposes `clearPending()`, which may cancel only that owner's still-cancellable
deliveries in the selected Agent session and generation. There is no API that
accepts another owner or generation.

The ledger remains the authoritative completion surface. Every accepted request records
`requested -> permission -> queued -> claimed -> projected -> forwarded`; a
request may instead terminate as `failed`, `expired`, or `cancelled`. A
permission denial records `permission` followed by `failed` without calling
the adapter. Missing current-connection support fails honestly rather than
leaving a request indefinitely queued.

Cancellation is an atomic race against adapter claim. `requested`,
`permission`, and `queued` are cancellable. The adapter must claim through a
host-owned control before any irreversible projection or native forward. Once
`claimed` wins, `cancel()` returns a typed `irreversible` result and does not
write a false `cancelled` event. `projected`, `forwarded`, and every terminal
stage are likewise non-cancellable. Repeated cancellation is idempotent and
does not append duplicate terminal events.

Plugin block, owning-fiber disposal, permission blocking, and generation
replacement invalidate that owner's handles. Pending cancellable deliveries
first receive one auditable `cancelled` terminal with the actual release
reason. An already claimed delivery retains its real eventual terminal; it is
never rewritten as cancelled merely because its owner disappeared. A stale
handle can still return its frozen last snapshot but mutation returns
`stale-generation` or `terminal`.

The `agent/pre-step` waterfall receives the complete immutable sourced
`UserMessage[]`. Handlers run in stable registration order. Ordinary
`agent.messages.append` authority may append only host-stamped messages owned
by that plugin; it cannot delete, replace, or reorder the original batch.
Rejecting the step requires `agent.steps.reject`; deleting, replacing, or
reordering existing messages requires `agent.messages.transform`. The broker
enforces these capabilities at the operation boundary. A transformed or
appended message is re-stamped as plugin content and cannot impersonate the
user, adapter, application, or another plugin.

`ctx.systemPrompt.section()` and `ctx.systemPrompt.context()` use the same
identity and broker. They require `agent.prompt.section` and
`agent.prompt.context`, respectively. There is no `ctx.modelInput`. Prompt
contributions are claimed by the same pre-step execution and disposed with
their owning fiber/generation.

## Successful input lifecycle

The host writes successful pre-step append and prompt composition facts into
the same Agent ledger. Consumers must project these events and must not invent
parallel Trace events. `input.contribution` identifies one of
`pre-step.append`, `system-prompt.section`, or `system-prompt.context` and uses
only stages the HostRuntime actually completed:

| Stage | Meaning |
| --- | --- |
| `registered` | a prompt contribution passed permission and entered the generation registry |
| `evaluated` | a handler or prompt contribution successfully produced step input |
| `projected` | the HostRuntime incorporated that output into the immutable step projection |
| `forwarded` | the completed projection left the HostRuntime for the next host boundary |
| `released` | the owning registration was removed explicitly, blocked, disposed, or replaced |
| `failed` | permission, evaluation, validation, or projection failed |

`forwarded` means only that CordisX returned the projection to its host caller;
it never means model-consumed. An adapter may record model consumption only
from a distinct host observation, and the current unavailable Codex connection
produces no such fact.

Each lifecycle event is host-committed with `provenance: cordisx` and the
host-stamped plugin source `(source, id, version, generation)`. Session is
always present. Turn and step are attached to evaluation/projection/forwarding
when known. Pre-step append events name the generated message ids. Prompt
events name a stable contribution id and kind; prompt content is returned only
through the private host composition path, not copied into audit data.

## Permission, timeout, and diagnostics

The shared manifest supports these Agent capabilities:

- `agent.events.read`
- `agent.messages.append`
- `agent.steps.reject`
- `agent.messages.transform`
- `agent.prompt.section`
- `agent.prompt.context`

Agent calls use the existing `allow` / `ask` / `deny` policy and required
capability activation rules. Session-scoped declarations use `scope.sessionIds`.
An ask prompt has a bounded host timeout; timeout is denial for this call and
is recorded as `timeout`, never silent allow. Diagnostics distinguish
undeclared, denied, out-of-scope, invalid, expired, cancelled, unavailable,
and adapter failure. Current trusted renderer plugins are still not sandboxed;
the broker enforces cooperative public APIs, not arbitrary renderer behavior.

## Private Codex adapter

The implementation is version-pinned to generated experimental app-server
types from `codex-cli 0.145.0`. The private normalizer consumes controlled
copies of `thread/started`, `turn/started`, item lifecycle and delta, turn
completion, and compaction notifications. Since those notifications do not
carry a public sequence, the normalizer checks its own lifecycle state and
emits a diagnostic for duplicate, missing-parent, or out-of-order input. A
controlled feed used by tests is not enabled by the product runtime.

Only this adapter may project CordisX messages into Codex's experimental
`additionalContext`. The public contracts, manifests, events, and plugin input
types contain no such field. Projection copies every native entry, adds a
collision-free CordisX-owned key, and always uses the least-trusted native
kind. Plugins provide text only and cannot request `application`, `trusted`, a
user role, a raw key, or a native source.

## Codex 0.145.0 black-box matrix

These observations were made through a test-only isolated app-server. They do
not prove access to the Desktop current connection and do not change the
unavailable product default.

| Question | Observation | Contract status |
| --- | --- | --- |
| order | Object insertion order was not retained; entries were materialized in deterministic key order before the direct user message | experimental; adapter never promises native order |
| native preservation | Distinct native entries remained present when CordisX added its own entry in controlled projection tests | required implementation behavior |
| one-shot/persistence | Entries were emitted once for the submitted turn, then persisted in durable model history and affected later turns | experimental host behavior |
| history visibility | `thread/read(includeTurns=true)` hid entries while the rollout retained them | public history visibility unavailable |
| resume | A new app-server process resumed the thread and retained their model-history effect | experimental host behavior |
| fork | A fork copied the entry-bearing seed history while public turn items still hid it | experimental host behavior |
| compaction | Plaintext entries disappeared from replacement history, while marker information remained model-visible after compaction and resume | representation unavailable; behavior experimental |
| token use | Same prompt/control used 19,592 input tokens; four roughly 90-character entries used 19,803 (+211), with the same cached input and output | experimental observation, not a pricing/token formula |
| paginated history | The probed paginated thread rejected `thread/read(includeTurns=true)` | unavailable on this path |
| live compaction notification | Generated types declare it, but the probe did not observe the expected notification | unavailable in this probe |

Evidence sessions are
`01a0304a-cde7-7472-8fba-be20dc2bbff1` (legacy),
`01a0304a-e931-7c53-9d3a-649ba1d37ccc` (fork), and
`01a03050-bce7-7f03-99b0-a2110cac19c5` (no-context control). The paginated
probe is `01a0304a-10af-7051-b898-29514ce169bf`. Exact values are recorded as
test evidence, not shipped fixtures containing host-private fields.

## Delivery and validation order

1. `cordisx-protocol#10` owns Agent event version 1 at `e615572`. Protocol
   `#11` added structured Platform session identity at `00113dc`, which remains
   independent of Agent `sessionId`; protocol `#12` added the UI catalog at
   `2ec9ca`. The delivery-control protocol merged at `08dcdc1`; it adds the
   version-2 event/snapshot schemas and conformance vectors and changes neither
   Platform scope nor UI catalog.
2. Provider-aware Platform foundation `cordisx#41` landed at `1f2c10d` and
   Provider Fleet `cordisx#44` landed at
   `d74c48524b73f47b3cf56de795ca66ed92bbab30`, the current host parent. They
   own composite Platform identity, `scope.sessions`, requested-scope audit,
   provider routing, and the generation-fenced provider registry/binding seam.
   Agent `sessionIds` neither replace nor map those identities, and this slice
   adds no Platform-to-Agent session bridge.
3. This host PR owns contracts, ledger, broker integration, facade, private
   adapter, fixtures, and tests. It adds no Timeline or demo plugin.
4. The host PR must pass protocol conformance, typecheck/build/tests, release
   and package checks, installed-package checks, high-severity audit,
   `git diff --check`, and a controlled renderer/app-server smoke where safe.
5. Only merged compatible owner commits are pinned by a separate CordisXMono
   PR. Product code is never committed to the mono repository.

Automated coverage includes gap/duplicate/out-of-order rejection, immutable
pagination and committed subscription ranges, content chunk coalescing,
generation and owner fencing, plugin identity stamping, allow/ask/deny and
timeout, session scope, required denial, cancel-versus-claim races, owner-only
clear, terminal idempotence, block/fiber-dispose/generation replacement,
append-only batch protection, separately authorized reject/transform,
successful pre-step and prompt lifecycle, all delivery terminal paths, native
context preservation and collision avoidance, unavailable current-connection
degradation, and absence of raw bridge/second-connection surfaces.
