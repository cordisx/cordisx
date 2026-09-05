# Launcher runtime composition

Type: implementation reference for the Host-private Node/CDP composition.
This page owns the detailed launcher integration constraints moved from the
[architecture overview](architecture.md#launcher-plane). Topic references
linked below own their feature semantics; public plugin contracts remain in
`cordisx-protocol`. A version or implementation statement here is not evidence
of release, real-App validation, or user acceptance.

## Launcher plane

The Node launcher owns configuration, plugin entry resolution, Codex process
startup, CDP target discovery, injection identifiers, and cleanup. Formal runs
compose an immutable browser bundle with esbuild. Development runs serve the
Host and all enabled plugin entries as one Vite ESM graph. Both paths preserve
one Cordis runtime identity for plugin contexts and services.

Explicit-entry bundles and dynamic package generations are separate composition
paths. Configuration live publication, owning-fiber restart, plugin dependency-
closure replacement, complete runtime-generation replacement, and app restart
are separate apply scopes. The package store, activation ledger, candidate/
last-good transaction, generation fencing, explicit-local source boundary,
package/runtime manifests, staged registries, and atomic publication order are
owned by [dynamic plugin lifecycle](dynamic-plugin-lifecycle.md). That reference
records the implemented runtime and its remaining gaps; the earlier single-
bundle feasibility path is not the status of installed dynamic packages.

The explicit `cordisx dev <entry>` and `cordisx dev --config ...` paths use
Vite as their Host-private development transport:

```text
Host sources + plugin sources -> Vite server -> HTTP modules/maps -> native renderer
                                     |                                  |
                                     +--- Vite HMR WebSocket ------------+
                                                                        |
launcher -> CDP small initial entry                  Host HMR / plugin fiber replacement
```

Vite serves one Host and plugin ESM graph with the Host React singleton and
React Refresh runtime. A refresh-compatible component module can update through
React Fast Refresh and retain component state. Plugin entry, manifest, `apply`,
and other non-refresh-boundary changes invalidate only the owning plugin and run
the renderer's reversible Cordis generation transaction. Replacement cleans up
the old fiber; a failed candidate rolls back, and an unsuccessful rollback
pauses updates. The Host itself can restart without refreshing the native
document; server-originated Vite full-reload messages become a Host-only restart
event on Vite's existing channel. Client-originated Vite recovery (such as
reconnect or a failed circular import) still follows the upstream client's
page-reload behavior. Updates never carry module source over CDP. Independent
windows apply updates locally; there is no development-wide atomic publication
guarantee.

JavaScript source maps are served separately. Before reloading a native target,
development grants that exact `app://` origin loopback access through CDP and
enables renderer CSP bypass; cleanup restores the permission to `prompt` and
disables the bypass. Vite listens only on loopback under a random per-launch
base path. The launcher owns its server and session state. Dependency optimizer
data uses the user-private `CORDISX_HOME/cache/native-vite` tree keyed by the
CLI/workspace roots and runtime dependency versions, so compatible later
launches of the same workspace can reuse it. Initial bootstrap or
module validation errors stop the launch; later transform or activation errors
preserve the active plugin. Config and Node-plane changes still require
restarting the command. Node services, formal plugin dependency graphs, and
isolated Host DOM plugins remain outside this renderer transport. Local paths
and diagnostics stay Host-private. Details and evidence are in
[`vite-native-development.md`](vite-native-development.md) and
[`distribution-and-cli.md`](distribution-and-cli.md#explicit-local-development-entry).
AI-first development uses the same plane with a normal project created by the
published plugin scaffolder. The launched Host receives that project's exact
entry and explicit-development mode as launcher-owned environment facts,
allowing its Codex agent to edit the already-watched source without a shared
scratch plugin, second watcher, or restart. Build, publication, rollback,
fencing, diagnostics, and shutdown remain the existing local-generation
authorities.

### Package and bundle composition

The launcher implementation of that boundary is specified separately in
[`dynamic-package-store.md`](dynamic-package-store.md): it maps source-v1 and
package-v2 intake plus a Host-private journal/token/permission/rollback layer
onto the single package and activation stores implemented by the generation
runtime slice. It does not create another store/registry, switch renderer
generations, or render Manager UI.

Plugin bundles layer a Host-owned management registry and coordinator over the
same single-plugin package lifecycle. A bundle is immutable installation and
policy metadata, never executable code or a permission principal. The
coordinator stages explicit-local member packages, compares exact
`(id, version, digest)` tuples, applies dependency-first, compensates failures
in reverse order, and records bundle/direct/runtime-dependency claims. Shared
members have one installed runtime identity; disabling removes only active
enable intent, while uninstall removes only that bundle's ownership claim.
Direct Manager removal is fenced while any bundle claim remains.

Bundle permission choices bind exact member permission ids. Enabled bundle
policies merge `deny > ask > allow`; one explicit plugin override replaces the
merge globally for that exact plugin permission. Disabling or removing a more
restrictive bundle persists its former result as a safety floor until a
confirmed permission review accepts widening. The launcher publishes the
revision-fenced bundle snapshot and private lifecycle RPC into the production
renderer composition. Manager owns the bundle list, detail header, exact
`README / Members / Permissions / Relations / Records` tabs, and all actions.
The complete behavior and verification ledger are in
[`plugin-bundles.md`](plugin-bundles.md).

### Host profiles, cleanup, and Skill deployment

The launcher binds CDP to `127.0.0.1`, records every `Page.addScriptToEvaluateOnNewDocument` identifier, and removes those identifiers on shutdown before asking the live page to dispose CordisX.

For interactive UI development, the normal `shared` launch creates a separate
Codex/ChatGPT process with an ephemeral loopback CDP port and a persistent,
CordisX-profile-scoped Chromium `user-data-dir`. Its launch environment is
empty, so the inherited `HOME` and `CODEX_HOME` intentionally retain the
existing account, conversations, projects, and model configuration without
reading, copying, or changing browser cookies. `CORDISX_HOME` independently
scopes CordisX configuration and state; when explicitly set to a concrete
user-owned directory, the launcher may tighten that directory only to `0700`
before using it and never recurses into Host roots. `--profile-dir` only
changes the independent Chromium directory. `--system` is the explicit escape
hatch to the normal Host Chromium profile. The advanced `host-isolated` mode
projects private Host roots and a private Chromium profile; legacy v1
`dataMode: "isolated"` is a non-destructive alias for it, never a synonym for
independent CordisX configuration. Neither mode shares request association,
in-flight turns, subscriptions, approvals, current UI context, or a live
connection state. The launcher starts its Host in a private process group and,
on shutdown, removes CDP injections then terminates only that group plus
helpers fenced by its exact CordisX-managed user-data directory; an explicitly
user-supplied `--profile-dir` never grants a broad helper-cleanup target.

Immediately before a named Host launch or a direct-entry development launch,
the launcher deploys the versioned `cordisx-plugin-development` Skill shipped
in its npm distribution. A normal
`shared` launch targets the resolved real `HOME`; `host-isolated` targets only
the private `HOME` projected by that launch plan. `CORDISX_HOME`, the selected
CordisX profile id, its independent Chromium `user-data-dir`, and Codex's
official `CODEX_HOME` remain separate concepts and are never substituted for
the Skill installation HOME. Deployment stages and content-hashes the complete
Skill before publication, updates only a target with a valid matching CordisX
management marker, and fails closed without changing a pre-existing unmanaged
or locally modified target. It neither scans nor copies sibling user Skills,
writes a repository `AGENTS.md`, creates a Studio checkout, nor changes the
launcher's current working directory, so repository-local instructions and
`.agents/skills` remain in scope for the Host process.

### Platform, Agent, and Session authority

The second Desktop process is a UI development host, not a transparent platform
bridge. CordisX must not start another app-server to impersonate or replace the
Desktop current connection, and must not create a second AppHost that overwrites
WebContents registration. Reuse of a controlled existing Desktop connection
remains experimental. An explicitly configured independent Provider Fleet
connection is a separate plane and never changes these current-connection facts.

The version-1 Platform capability architecture and its honest unavailable
default are specified in [`platform-capabilities.md`](platform-capabilities.md).
It introduces no second app-server and exposes no raw Desktop bridge.

Separately managed provider connections are specified in
[`multi-provider-sessions.md`](multi-provider-sessions.md). They run below a
launcher-owned Provider Fleet with provider-specific persistence and structured
session identity. They never claim to be the Desktop current connection. This
separation preserves the one-current-connection rule while allowing an
explicitly independent provider plugin to own its own Codex app-server and
conversation store.

The UI-neutral Agent event ledger, DSH-aligned messaging facade, permission
chain, and private Codex event adapter are specified in
[`agent-events.md`](agent-events.md). They share the Platform broker and host
adapter generation, retain only stable projection identities, and define no
Timeline, session header, DOM surface, or outlet.

The internal text AgentLoop bridge is specified in
[`agent-loop.md`](agent-loop.md). It injects one principal-bound
`ctx.agentLoop` client per plugin fiber, resolves the Protocol AgentDefinition
catalog, creates a fresh binding or binds one explicit opaque task, wakes it
through the existing Provider Fleet, and proactively projects
assistant text, observed approvals, and lifecycle. It reuses the existing task
permissions and prompt runtime, owns no Chatroom data or plugin UI, and returns
typed unsupported for `image-ref` until a controlled resolver exists.
For internal development and Playground composition, the explicit
`codex.agentLoopBackend="local-cli"` option adds `codex-local` to that Provider
Fleet. Its launcher-owned app-server reuses the authenticated local Codex home,
publishes only the existing token-bound provider RPC, and starts tasks with a
read-only sandbox plus `approvalPolicy=never`. It is an independent connection,
not the Desktop current connection or a raw app-server plugin API.
The alternative `codex.agentLoopBackend="mock"` is fenced to the explicit UI
Playground and substitutes only a Host-private deterministic in-memory
AgentLoop host. It uses the same broker and public client but creates no
provider, model, App Server, Codex task, process, connection, or login state.
Its `debug:agent-loop/mock/v1` task registry and trace page are development
diagnostics, not public runtime state or a permanent CLI contract.

The additive Agent/Session/Approval runtime keeps authorization in the same
Host `PermissionBroker` and resolves one exact `SessionId` before every
capability decision or lease. Only the explicit Playground composition may
create the opaque development authorization authority, and it may use that
authority only for the launcher-marked, ready local-development artifact whose
plugin id and `file:///cordisx-local-dev/` identity match. That path writes the
ordinary exact in-memory development policy and returns the normal revocable
lease without opening a dialog; installed plugins, production hosts, and
ordinary Playground plugins retain the interactive fail-closed path. No
wildcard or plugin-provided flag is accepted. Connection, route, permission,
and plugin-generation replacement abort pending Agent runtime prompts before
fencing leases, so an obsolete dialog cannot survive as inert UI.
Plugin manifest/package v6 adds public exact route-scoped declarations for all
twelve Agent runtime capabilities, including independent `approvals.request`
and `approvals.answer` authority. A dynamic declaration is optional and binds
only `sessionIds` to the authenticated owner's route-v2 `:sessionId` parameter;
the named route must contain that parameter exactly once. The Host captures the
active route instance and exact value, then materializes only that Session id
through the existing permission-v4 policy and lease ledger. Static lists remain
non-empty, unique, and non-wildcard. Route, plugin generation, connection, or
policy replacement revokes the lease; foreign owners, stale generations,
inactive routes, malformed values, and duplicate declarations fail closed.
Navigation retains a Host-private route-owner coordinate containing the
launcher-authenticated source, local plugin id, and module generation. Agent
authority resolves through that coordinate without parsing its composite
ledger owner, so equal local ids from another source cannot capture a route.
An approval answerer is a same-owner lifecycle registration, not a permission
grant: registration requires the installed declaration and a valid owned route
definition but creates no route lease. The exact active Session route and
permission policy are rechecked immediately before every handler invocation.
No Room identifier is reinterpreted as Session authority and no approval-specific
ledger or writer exists.
Plugin manifest v8 additionally permits only `approvals.answer` to declare an
`authorityRequester` route scope. After the Host has accepted the exact v3
requester/authority correlation, the requester route's `:sessionId` remains
the route fence while the ordinary policy record and leased target remain the
distinct authority Session. The broker retains both values so the lease is
active only on that same requester route instance; `host-create` and
`host-exact` sources cannot obtain this authority scope. Route, owner,
connection, resolver, answerer, or generation replacement still retires it
fail closed.
An explicitly enabled Playground scenario may temporarily add one exact
delegated Session route to that same broker without replacing the visible Lead
Room route. The Host derives its owner and route identity from the active Lead
route and its `SessionId` from the Room-admitted scenario actor; fixture data
cannot supply any of those authority fields. The supplemental route is guarded
by an opaque Host-only authority, authorizes through the ordinary exact policy
and lease path, and is removed on run completion, visible-route change,
permission or plugin-generation fencing, connection replacement, reset, or
runtime disposal. Removal fences only leases issued for that supplemental
route instance, so the Lead route is neither broadened nor replaced.
The explicit Playground Host also owns a private durable Agent Session ledger
under its selected Playground home. The renderer receives only a per-composition
generation token and commits each new Session or contiguous `SessionEvent`
batch through the launcher before publishing it to memory or live subscribers.
The launcher validates lossless structured-clone/JSON data, exact `SessionId`,
Session generation, and expected cursor, serializes updates, and replaces the
ledger file atomically. The same Session record may also retain its Host-validated
`AgentSetup` catalog as identity metadata; this is not an execution fact or a
second ledger. Create commits it atomically with the Session, and resume may
enrich an older setup-less record only through the exact Session generation
fence. A later Playground process hydrates the same Session headers, event
sequences, and optional setup before plugin activation, preserving opaque
Session ids, identity presentation, and plugin-supplied Room/Simulator
correlation; the deterministic transport continues its turn counter from the
events. Existing v1 ledgers without setup remain valid. Old composition tokens
fail closed, and an explicit Playground reset clears this ledger with the other
fixture state. This store is not installed in production or Desktop, whose
current native Agent Session transport remains the persistence authority.
The `dev:ui` session mints that provenance only for enabled, non-built-in local
entries explicitly named by the source Playground composition. It compiles
them through the normal verified local-development builder, carries its full
watch graph into Vite invalidation, and assigns a Host-generated artifact
generation; `loadConfig` never accepts equivalent provenance from JSON. The
ordinary local-development artifact retains its inline source map. Only the
copy secondarily embedded into the Vite Playground composition is built without
an inline `sourceMappingURL`, so decoded virtual React/UI sources cannot be
reinterpreted as filesystem imports without changing shared-runtime module
resolution or real-App diagnostics. The builder's virtual React/UI metafile
inputs are likewise never projected as filesystem watch files; only its real
input graph participates in local-development invalidation.

### Owner documents and Connector broker

Small plugin-owned durable state uses the Host public
`cordisx.owner-documents/v1` service at `ctx.documents`. The renderer receives
one client bound to the Host-issued plugin principal; callers cannot choose a
profile, source, plugin id, or runtime generation. The launcher keys the store
by exact profile, source, and plugin id while deliberately excluding module
generation, so normal reload, disable, uninstall/re-enable, and upgrades from
the same stable source retain the owner's data. A source replacement is a new
owner and cannot inherit it. Ordinary disposal never purges state, and v1
exposes no purge operation.

The launcher, rather than plugin code or renderer local storage, owns the JSON
document files. A per-owner atomic lock with dead-process recovery serializes
compare-and-swap across launcher instances and processes, so one expected
revision has at most one winner. The Host issues one authenticated token per
exact profile, source, plugin id, runtime generation, and module activation
generation; the wire never accepts a caller-selected owner. Package reload,
disable, rollback, and replacement update the launcher lease registry and
renderer binding in the same lifecycle transaction. The authority repeats its
principal lease fence under the owner lock immediately before atomic rename,
after temporary bytes are written and synced: retirement before that point has
no side effect, while a completed rename always returns its accepted snapshot.

Each snapshot carries a monotonic revision plus a consumer-owned schema
version; consumer migration is an explicit CAS replacement. Invalid JSON,
unsupported Host envelope versions, and quota violations fail closed without
overwriting the recoverable original. Renderer subscriptions emit full snapshot
replacements and share one single-flight poll per bound owner/document, with
global request and per-client watch/listener bounds. Unsubscribe, principal
generation retirement, fiber disposal, and runtime disposal prevent late
delivery. Playground and installed consumers use the same public
`ctx.documents` browser bridge and launcher authority; only Playground's
explicit Reset operation clears its isolated Home.

Durable adapter history is a separate Node/Host read service specified in
[`agent-history.md`](agent-history.md). It gives plugins permission-scoped,
redacted Agent-v2 pages and opaque cursors without renderer filesystem access
or mutation of the live Agent ledger.

The Host also owns the Connector broker and injects one principal-bound
`connectors` client into each plugin context. Plugins cannot supply caller
identity, authorization, a native bridge, or a transport. The Host binds each
request to the live principal and PermissionBroker, stamps registrations and
generations, keeps conversation/run handles opaque and bound, and returns only
typed accepted, denied, or unavailable results. Subscription wire results are
serializable descriptors; their runtime page iterator is Host-owned, installs
its listener before the replay watermark, serializes replay then live delivery,
and is fenced by unsubscribe, owner disposal, and replacement. Client discovery
is a redacted snapshot only. The first built-in `agent.connector` is wired only
to the existing Host Agent adapter; it does not inspect renderer globals, use a
raw bridge, or create a second connection. Until that adapter has an audited
current-connection command seat, its open, send, stop, and close commands
remain typed unavailable.

Production-renderer Connector integration tests may statically compose a
repository-controlled Host bootstrap closure into a temporary isolated smoke
bundle. The closure runs before ordinary plugin activation, is absent from
runtime metadata, configuration, CLI inputs, environment variables, renderer
globals, public snapshots, and release artifacts, and is disposed with the
runtime. It may drive only redacted Host assertions; normal smoke plugins still
receive the same principal-bound `connectors` client as product plugins. This
test seam neither creates a second current connection nor turns a Host-private
adapter or producer into a plugin API.

The plugin detail development Console, issuance-bound attribution, automatic
Host capability aspect, scoped console facade and explicit shared-renderer
blind spots are specified in
[`plugin-devtools-console.md`](plugin-devtools-console.md).

### Channel services

The Channel runtime is specified in
[`channel-runtime.md`](channel-runtime.md). It adds a launcher-owned Node
service extension point, durable inbox/outbox and binding core, and
Feishu/WeCom/WeChat adapters over the existing Platform/Agent authority. A
renderer plugin receives only a brokered snapshot/action API and controlled
manager/session surfaces; it never owns credentials, webhook/long-connection
transport, queues, cursors, or retry workers.

The formal `channel-task-gateway/v1` prerequisite is implemented only in the
launcher-private plane. A named Host workspace registration resolves one alias
to a real, authorized directory; a Node-safe projection of the existing
durable Permission Broker policy ledger evaluates the complete
provider/model/workspace request before a short-lived single-use grant is
atomically consumed. The Provider Fleet then dispatches create or
follow-up on its already-owned connection and records a separate sanitized,
per-session lifecycle ledger. Id-less provider notifications are normalized
before persistence; raw frames, absolute paths, grants, callback handles, and
provider configuration never enter CDP, a renderer projection, or Manager.
`created-initial-turn-failed` preserves the created Channel binding and queues
one idempotent failure delivery. This does not enable any Feishu fixed-create
consumer or claim a Desktop current connection: Channel routes still fail
closed without a persisted permission decision, an enabled provider, and an
explicit workspace registration.

The host-neutral core, simulator, and source-bound Node Cordis `channel` service
are implemented. Plugin-package v3 / plugin-manifest v4 service entries are
source-validated, bundled for Node, included in the immutable package digest,
read back from the package store, resolved through the lifecycle authority, and
activated in a generation/source-bound Channel service context. Normal launcher
lifecycle orchestration of those service fibers and real transports remain
planned. The launcher-side package also validates
`cordisx.channel-service-config/v1` and generates the redacted
`cordisx.channel-service-config-descriptor/v1`. Connection credential fields are
restricted to opaque `keychain:` or `host-secret:` references and become only
readiness state in that descriptor. A service declaring `configuration.kind=none`
produces no placeholder document or Manager form. This Node service plane is
separate from renderer plugin Schemastery `Config`/`configApplies`: the built-in
Channel renderer module exports no Config and contributes only a structured
`manager.settings.navigation-items` record plus a same-owner
`manager.content` route and standard page. The Host now projects eligible B
records into its first-level navigation, renders the route-v2 navigation label
and the page-v3 standard header separately, and mounts a bounded child seat
only after same-owner, surface/outlet/page permission, generation, and route
checks. The internal Host body renderer consumes a bounded, redacted Channel
Manager projection for
read-only accounts, routes, composite task bindings, and diagnostics; it never
receives service configuration, `secretRef`, transports, queues, or credential
values. It presents a Host-owned searchable card list and card-detail tabs;
the only create result available before a Host writer exists is an explicitly
session-local, credential-free candidate, never an external connection. The
read-only Feishu target `cli_aaba90fcc4389cb3` is a known enabled test
application, not a connected account; no secret, callback, event subscription,
or external configuration is read or written by this renderer. Live launcher
projection, configuration writes, credential actions, and a single
launcher-to-Manager simulator orchestration remain planned. The
Channel config adapter consumes the shared
launcher service-configuration foundation: the closed manifest `restart`
declaration maps to `service-restart`, the schema is
`standard/renderable=false`, revision/generation/owner fencing and last-good
publication use the shared narrow API, and opaque credential handles are
preserved only launcher-side across non-secret updates.

For a Channel connection on macOS, the launcher-private secret store issues a
scoped opaque capture id and accepts only that id plus a transient secret. It
maps the value to `keychain:cordisx/channel/<profile>/<connection>` using a
fixed stdin-fed helper backed by `Security.framework`; values never enter
argv, environment, configuration, launcher logs, descriptors, or Manager
projection. Capture results contain only `set`/`unset`/`unavailable` and an
opaque operation token. Non-macOS returns `unavailable`, rather than claiming
a portable credential backend. The Feishu/Lark launcher adapter reuses the
same Keychain read backend when it resolves an opaque connection reference.

### Debugging authority

Online Chrome DevTools support is opt-in. `--online-devtools` adds `https://chrome-devtools-frontend.appspot.com` to `--remote-allow-origins`; once connected, that origin has full renderer debugging authority for the isolated instance.
