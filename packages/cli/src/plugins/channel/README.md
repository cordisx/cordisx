# Channels

Channels is the CordisX product surface for launcher-owned messaging connections. It contributes a structured Manager navigation record plus a same-owner standard page route, and declares one Node-side `channel-adapter` service using the versioned `channel-service-config/v1` Host schema.

## Current status

- **Implemented:** immutable packaged service artifacts are validated, bundled, staged, integrity-checked, authority-projected, and loaded into a generation-bound Node Cordis context.
- **Verified:** the local simulator covers activation/disposal; the official Feishu/Lark WebSocket adapter and the shared Host service-config API are covered by automated tests for `service-restart` CAS, opaque-handle preservation, redaction, and last-good publication.
- **Implemented and verified:** the bounded Host body renderer provides a fixed searchable Channel card list, a Host-owned candidate-only create flow, and Configuration / Logs / Connections & sessions details through `manager.content`. The Host renders navigation, forms, theme, accessibility, and cleanup; it never projects `secretRef` or credential material.
- **Experimental:** the renderer receives only the launch-time Channel projection. It is not a continuous transport or live connection feed.
- **Not yet verified:** a real Feishu/Lark account connection and message smoke. Automated adapter verification is not evidence of a user-account session.
- **Unavailable:** credential creation broker and WeCom adapter support.
- **Planned:** real-account smoke evidence and lifecycle-wired live renderer projections.

The renderer module has no user configuration fields. Only account connection
configuration belongs to the launcher service declaration. The closed manifest
`restart` value maps to the Host's precise `service-restart` plane and exposes a
Host-owned Schemastery descriptor; task mapping, models, workspaces,
notifications, retry policy, and task dispatch belong to independent consumer
plugins. A service with no configuration must declare `configuration.kind:
"none"`; CordisX does not create placeholder fields.

Credentials are opaque Host handles. They must not appear in plugin configuration, renderer state, logs, Manager snapshots, or this README's examples.

The Manager never claims a connection from an application identifier alone.
Credentials remain Host-held; a real account or message result is shown only
after a separately verified connection path, never inferred from configuration.

## Plugin-to-plugin messaging facade

Launcher-side Cordis plugins can request the high-level `ctx.channel` service. It exposes:

- `ctx.channel.connections.list()` for permission-brokered safe connection status;
- `ctx.channel.messages.subscribe()` for source-bound inbound user messages;
- `ctx.channel.messages.send()` for audited outbound notifications with a delivery handle; and
- `ctx.channel.adapters.register()` for adapter packages running inside the launcher service host.

The facade preserves package source, plugin id, and generation identity. Consumer plugins never receive raw transports, credentials, queues, stores, or adapter connection objects. A remote message remains a sourced `role: "user"` input and cannot become a system or developer prompt.

The product bundle declares every operational capability as optional so the read-only Settings diagnostics remain available when a service permission is denied. Each service operation still fails closed at the broker. A future real adapter package may make the capabilities needed for its selected transport and configured route required within its explicit account, tenant, conversation, provider, workspace, or session scopes.

## Identity and reliability

Accounts use `adapterId + accountId + tenantId`. Threads additionally use `conversationId + threadId`, and task bindings use the composite `providerId + remoteSessionId`; display names and coincident remote ids never collapse these identities.

Delivery is at least once with durable inbox/outbox records, event-id idempotency, retry/backoff, dead letters, cursor checkpoints, restart recovery, generation fencing, and last-good revisions. CordisX does not claim exactly-once delivery.

## Real platform boundary

The built-in service supports the local simulator and the official Feishu/Lark
WebSocket adapter. The adapter uses official platform APIs and Host-held
credentials, but a real account/message smoke has not yet been verified.
WeCom remains unavailable. Personal WeChat client reverse engineering,
unofficial hooks, fabricated subscriptions, and renderer-owned web servers are
out of scope.
