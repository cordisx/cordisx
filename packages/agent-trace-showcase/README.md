# CordisX Agent Trace Showcase

Development-only CordisX plugin for validating the public Agent injection and
session event-ledger contract through a session-scoped Timeline.

The package is intentionally independent from CordisX core. It uses structured
host surfaces and the `session.content` page outlet; CordisX never imports the
plugin. The default launcher/setup configuration does not enable it.

Current stacked state:

- fixture UI and a deterministic typed fake are allowed;
- fixture operations never touch a real conversation;
- the merged protocol baseline is
  `cordisx-protocol@2ec9ca15234e778853104d1667c7d1c4bffff1d9`, retaining
  `cordisx.agent-events/v1` from ancestor `e615572`;
- live Agent operations and live trace data remain unavailable until the
  compatible host implementation from task
  `01a03038-8aa4-7441-83f9-05f88908a47e` is merged and pinned;
- the current-session entry contribution uses catalog v2 and the public
  `ctx.slots.register` service from stacked host head
  `2897c6c3bc230805009572f43e37e99d2ac4a4ee`; the host renders the unique
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
