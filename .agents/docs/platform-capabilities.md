# Platform capabilities architecture

Status: approved implementation architecture for the version-1 Platform
slice. Normative plugin-visible behavior lives in `cordisx-protocol`.

## Evidence and safe landing boundary

The current renderer runtime owns Cordis fibers, the experimental slot service,
the LocalizationKernel, manager state, and a narrow launcher-owned marketplace
fetch binding. It does not own a Platform service or a safe reference to the
Desktop request client.

The installed Desktop renderer inspected for this work exposes a generic
`electronBridge.sendMessageFromView()` and a `connect-app-host` MessagePort.
The application bundle separately owns request scheduling, priority, request
ids, timeout, tracing, task history, and stream owner/follower coordination.
Those private objects are minified implementation details and are not stable
renderer globals that CordisX can safely capture.

Calling the generic bridge directly would bypass the application's request
client. Starting another app-server would create independent connection and
stream state. Both are forbidden. This slice therefore lands the stable
protocol, broker, adapter boundary, unavailable diagnostics, and controlled
read-only projection implementation. The default live adapter is unavailable
until a future host-private current-connection seat is auditable.

## Runtime shape

```text
launcher-owned (source, plugin id) + module manifest
                         |
                         v
              PermissionBroker ledger
              / policy / scope / audit \
             v                          v
plugin fiber ctx.platform        manager permission tab
             |
             v
      PlatformService validation
             |
             v
 host-owned PlatformAdapter boundary
       |                         |
       v                         v
 unavailable default     controlled read-only projection
                                 |
                                 v
                     future current-connection adapter
```

The launcher derives `source` from the canonical local entry URL. A module may
declare a version-1 manifest but cannot replace its runtime source or id. The
runtime extends each plugin context with a private symbol carrying that
identity. `ctx.platform` reads the identity from the calling Cordis context;
no public method accepts an identity argument.

The Permission Broker normalizes and freezes declarations before plugin
activation. Its persisted policy key includes source, id, capability, and a
deterministic fingerprint of required/reason/scope. A changed declaration has
policy `ask`. The broker records in-memory audit timestamps and denial counts.
Policy storage and prompt UI are host-owned, while current trusted renderer
execution means neither is a tamper-proof security boundary.

## Activation and manager behavior

At startup the broker registers every bundled manifest. A required declaration
with current policy `deny` prevents that plugin fiber from mounting and yields
`permission-blocked` plus an explicit reason. `ask` is unresolved authority,
not automatic denial or grant; the host prompts at call time. Optional denial
does not stop the fiber.

The installed-plugin detail page adds a `权限` tab. Its model retains:

- plugin source and id;
- capability and required/optional status;
- retained `LocalizedText` and its current resolved projection;
- requested scope and current `ask`/`deny`/`allow` policy;
- last allowed use, last denial, denial count, and blocked reason.

Policy changes reconcile the plugin fiber: changing a required capability to
`deny` disposes it; moving every denied required declaration to `ask` or
`allow` permits a fresh mount. Locale changes reproject permission reasons
through the existing LocalizationKernel subscription.

## Platform service and adapter boundary

The service exposes only `models`, `tasks`, `turns`, and a read-only adapter
status. It returns versioned result values and sanitized diagnostics. It never
returns the adapter, broker, raw bridge, transport, scheduler, request ids, or
stream state.

The service authorizes and validates every call before dispatch. Task creation
also queries current adapter models and rejects an unknown provider/model. It
then performs adapter `createTask` followed by `submitTurn` when an initial
message exists. A phase-two error returns the created task and does not invoke
delete or archive.

`UnavailablePlatformAdapter` is the default for the injected renderer and
reports `current-connection-client-unavailable`, `secondConnectionCreated:
false`, and `rawBridgeExposed: false`.

`ProjectionPlatformAdapter` consumes an immutable, host-produced snapshot. It
can support model, task-catalog, and task-content reads without exposing the
source. It refuses all writes. It is not wired to scraped visible DOM: a
partial sidebar or current conversation view is not an authoritative complete
projection.

A future `CodexCurrentConnectionAdapter` is conforming only if a host-owned
seat delegates through the existing request client and its scheduler, timeout,
request-id and owner/follower machinery. It remains a separate private adapter
PR and does not add `ctx.codex`.

## Security statement

The broker is meaningful policy enforcement for calls made through the
CordisX Platform API. It does not confine trusted renderer code, which can
still access Codex DOM and renderer globals. The manager must show that the
current runtime is not a sandbox.

Marketplace plugins require a structured host-rendered UI surface plus an
isolated Worker, iframe, or process and capability RPC before these grants can
be considered a security boundary. Signing, installation, activation, and
rollback are outside this task.

## Dependencies and PR boundaries

1. `cordisx/cordisx#2` architecture and `cordisx/cordisx-protocol#2`
   LocalizedText/MessageRef are merged dependencies.
2. `cordisx/cordisx#3` LocalizationKernel is the real projection dependency;
   Platform does not create a second localization service.
3. The protocol PR owns the version-1 specification, plugin-manifest schema,
   vectors, and conformance.
4. The host PR owns TypeScript contracts, broker, adapters, service, manager
   projection/UI, tests, and live smoke. It depends on the protocol PR but does
   not import a checkout at runtime.
5. A future private current-connection adapter is a separate experimental PR
   blocked on a stable auditable host seat.
6. CordisXMono updates the two pushed gitlinks only after compatible validation.

The task does not initialize or modify `roadmap`, and does not expand into a
complete Marketplace implementation.

## Validation boundary

Automated coverage must include provider/model validation; allow/ask/deny;
required/optional activation; scope denial; identity non-spoofing; declaration
upgrade reset; two-phase create success and retained-task partial failure;
read-only projection and write refusal; unavailable diagnostics; manager data
and locale reprojection; generation cleanup; and absence of a raw bridge or
second app-server in the Platform surface.

Repository validation is `npm run check`, `npm audit --audit-level=high`, and
`git diff --check` in each owning repository. Live validation builds and
injects the real renderer bundle, opens the manager permission tab, records
the adapter unavailable diagnostic, and confirms the existing UI still
mounts/disposes. It cannot claim real model/task writes until the private
current-connection adapter exists.
