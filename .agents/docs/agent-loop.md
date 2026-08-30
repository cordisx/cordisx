# Host-bound AgentLoop

## Status and boundary

The renderer Host implements an experimental, plugin-facing `ctx.agentLoop`
service against the local `@cordisx/protocol/agent-loop/v1` candidate. The
Protocol remains room-neutral and data-only. Chatroom owns its room data and
plugin UI; the Host owns Agent task identity, provider routing, permission
decisions, prompt projection, proactive event delivery, and cleanup.

This slice targets the internal text path only. It does not add an external
channel, a general security system, a Chatroom store, or plugin-owned Host UI.
An `image-ref` remains opaque. Until a controlled Host resolver exists, sending
one returns typed `unsupported`; it is never converted to a URL, path, base64
payload, or raw provider value.

## Runtime flow

Each live plugin fiber receives one principal-bound `BoundAgentLoopClient` at
`ctx.agentLoop`. The client exposes only `createOrBind`, `send`, `subscribe`,
and `dispose`.

`createOrBind` validates the self-contained AgentDefinition catalog, rejects
missing, cyclic, duplicate, self-referential, or unreachable definitions, and
resolves ordered parents before applying the leaf's field inheritance modes.
Prompt sections include introduction, personality, and memory. The effective
definition is projected into provider task creation and its prompt sections are
registered through the same Host prompt runtime behind `ctx.systemPrompt`.

Every `target.mode=create` call creates a new task and binding, even when the
same plugin owner and immutable AgentDefinition identity are used by multiple
Chatroom Rooms. Only `target.mode=bind` may reuse an active binding for its
explicit opaque task. Host task handles are random opaque values backed by a
private generation-local session map; serialized bindings are correlation data
and never authorize access.

`send` reuses `turns.submit`, so accepted text wakes the bound task. The Host
then projects the existing Provider Fleet lifecycle ledger into ordered
AgentLoop pages:

- user and assistant text messages;
- observed approval pending and resolved states;
- binding created/bound/closed and turn started/completed/failed lifecycle.

Subscriptions install their live listener after a fixed replay snapshot and
are fenced by binding generation, plugin owner, unsubscribe, fiber disposal,
and runtime disposal.

## Existing authority reused

The client never accepts caller identity, grants, policy, provider adapters, or
native handles. Calls are authorized by the existing `PermissionBroker` using
`tasks.create`, `tasks.content.read`, and `turns.submit`. Existing denied,
undeclared, out-of-scope, timeout, adapter-unavailable, and task-unavailable
outcomes are mapped to the Protocol's typed denied/unavailable states. Approval
events are observations only and never grant authority.

Provider task creation and lifecycle reads use a token-bound launcher-private
RPC. Public `ctx.platform` remains unchanged and does not accept effective
prompt instructions or expose the lifecycle transport.

## Consumer sequence

An internal Chatroom plugin:

1. declares the existing task create/read/turn submit capabilities;
2. injects `agentLoop` and submits a complete AgentDefinition catalog;
3. retains the returned active `AgentLoopTaskBinding` as opaque correlation
   state alongside that exact Room, and does not call create again for it;
4. subscribes from `-1` (or its last processed sequence), then sends text with
   the Room's saved binding;
5. projects message, approval, and lifecycle events into its own data/UI;
6. unsubscribes and disposes with its fiber.

Chatroom must not infer provider sessions from `binding.task`, move room data
into Host state, or ask the Host to render plugin UI.
