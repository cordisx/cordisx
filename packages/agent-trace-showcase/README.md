# CordisX Agent Trace Showcase

Development-only CordisX plugin for validating the public Agent injection and
session event-ledger contract through a session-scoped Timeline.

The package is intentionally independent from CordisX core. It uses structured
host surfaces and the `session.content` page outlet; CordisX never imports the
plugin. The default launcher/setup configuration does not enable it.

Current stacked state:

- fixture UI and a deterministic typed fake are allowed;
- fixture operations never touch a real conversation;
- merged Agent protocol
  `cordisx-protocol@08dcdc11aae38ea9c0e91e4ad17cf31b8c756747` supplies
  `cordisx.agent-events/v2`, `cordisx.agent-delivery/v1`, and the reference
  `test-vectors/agent-events-v2/valid/control-and-contributions.json` fixture;
- merged host `e0929a0ca7bc0e0b5f32c1c4f1b0f487928f0dc4` supplies the public
  Agent ledger, fenced delivery handles/clear, pre-step, and prompt disposables;
- current Codex observations still report partial/unavailable when the private
  current-connection seat is absent; user-triggered deliveries then retain the
  Host's real failed terminal events and are never called model-consumed;
- the current-session entry contribution uses catalog v2 and the public
  `ctx.slots.register` service from merged host
  `e0929a0ca7bc0e0b5f32c1c4f1b0f487928f0dc4`; the host renders the unique
  native session-header seat;
- no raw Electron, app-server, CDP, DOM-session, adapter-store, or Permission
  Broker access is permitted.

See
[`../../.agents/docs/agent-trace-showcase.md`](../../.agents/docs/agent-trace-showcase.md)
for product behavior, dependency mapping, lifecycle, and validation boundaries.

Fixture mode is opt-in and requires the active native session id:

```json
{
  "entry": "./packages/agent-trace-showcase/src/index.ts",
  "config": {
    "mode": "fixture",
    "sessionId": "<active-session-id>",
    "permissionPolicy": "allow"
  }
}
```

The fixture exposes six explicit page controls and never runs one on plugin
activation or page mount. Its host-rendered `session.header.actions` entry
opens the registered route for the explicitly configured fixture session; it
accepts only the immutable host-owned invocation context and rejects direct or
plugin-spoofed identity.

Live mode binds the route and every public Agent operation to the host-issued
current session key:

```json
{
  "entry": "./packages/agent-trace-showcase/src/index.ts",
  "config": { "mode": "live" }
}
```

It requests optional `agent.events.read`, `agent.messages.append`,
`agent.prompt.section`, and `agent.prompt.context` through the manifest and
Permission Broker. Every operation requires an explicit page click; cancel,
clear, page close, block, and generation disposal use only the public fenced
handle or contribution disposable. It never reads a raw bridge or writes a
parallel trace event.
