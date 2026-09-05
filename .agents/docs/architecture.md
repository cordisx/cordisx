# CordisX architecture

## Goal

CordisX lets trusted local plugins augment the Codex Desktop interface without modifying the installed application or replacing native React content. It is a UI-host project, not an alternative agent loop and not an authentication or API relay.

The initial design is based on two source snapshots inspected on 2026-08-22:

- `qqheling/codexplusplus@a114ae5`: launches Codex with a loopback CDP port, selects the Codex page target, installs scripts with `Page.addScriptToEvaluateOnNewDocument`, evaluates them in the current document, and repairs UI changes with DOM observation.
- `deepseek-ai/deepseek-harness@b150a55`: uses Cordis fibers and reversible effects for plugin lifetime, loads browser client modules separately from the agent loop, and exposes named slots instead of making each plugin patch a shell component directly.

The installed macOS host inspected during the spike is `/Applications/ChatGPT.app` 26.818.41509 (bundle 6962, identifier `com.openai.codex`). Its child process names still identify Codex renderers. The launcher therefore probes both the older standalone `Codex.app` location and the current unified `ChatGPT.app` location.

## Product boundary

OpenAI's [supported plugin UI](https://developers.openai.com/plugins/build/chatgpt-ui) is an MCP UI resource rendered in an isolated iframe alongside a conversation or in a host-controlled fullscreen presentation. That mechanism is suitable for plugin-owned task UI, but it does not expose arbitrary Codex shell replacement points such as the sidebar, header, or composer.

CordisX therefore has two explicit modes of extension:

1. Use official MCP UI for portable, conversation-owned UI.
2. Use CordisX only for local Codex shell augmentation where official UI resources cannot express the feature.

CordisX must never label its injected shell integration as an official Codex plugin API.

## Runtime

```text
cordisx run/config -- esbuild immutable bundle --+
                                                  |
cordisx dev/config -- Vite ESM graph + HMR -------+--> launcher/CDP bootstrap
                                                          |
                                                          v
                                                    Codex renderer
                                                          |
                                                          v
Cordis Context -- SlotService -- semantic slots -- Codex DOM adapter
        |                                  |
        +---- plugin fibers/effects -------+
```

### Launcher plane

The Node launcher owns configuration, plugin entry resolution, Codex process
startup, CDP target discovery, injection identifiers, and cleanup. Formal runs
compose an immutable browser bundle with esbuild. Development runs serve the
Host and all enabled plugin entries as one Vite ESM graph. Both paths preserve
one Cordis runtime identity for plugin contexts and services.

Dynamic package delivery evolves that composition into one stable Host runtime
plus independently built immutable plugin module generations. Configuration
live publication, owning-fiber restart, plugin dependency-closure replacement,
complete runtime-generation replacement, and app restart are separate apply
scopes. The package store, activation ledger, candidate/last-good transaction,
generation fencing, explicit-local directory/package/downloaded-tarball source
boundary, separate package/runtime manifests, staged registries, and atomic
closure publication order are specified in
[`dynamic-plugin-lifecycle.md`](dynamic-plugin-lifecycle.md). Until its runtime
slice lands, the single-bundle behavior in the next sections remains the
implemented current state.

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

Online Chrome DevTools support is opt-in. `--online-devtools` adds `https://chrome-devtools-frontend.appspot.com` to `--remote-allow-origins`; once connected, that origin has full renderer debugging authority for the isolated instance.

### Renderer plane

The injected bundle creates a new Cordis `Context`, mounts `SlotService` at `ctx.slots`, then mounts each configured plugin as a child fiber. A second injection first disposes the previous host. Plugin startup is fail-loud; already-started fibers unwind in reverse order if a later plugin fails.

The renderer generation also installs one Host-owned React 19 singleton before
plugin factories run. Plugin builds resolve `cordisx/react`, its automatic JSX
runtime subpaths, and `cordisx/ui` to this singleton; a plugin artifact that
contains React, React DOM, or a private React component library is rejected.
`defineReactPage` mounts a React component only in the existing page-v3 body
seat and unmounts it on abort or generation disposal. Manager chrome and
Schemastery configuration remain Host-owned. The public authoring and lifecycle
contract is specified in
[`plugin-react-runtime.md`](plugin-react-runtime.md).

The production Agent conversation shell is a separate Host-owned renderer
kernel under `renderer/host-ui/conversation`. Its immutable render model is a
private, already-localized projection: it contains only bounded room,
participant, entry, status, action and composer data. The renderer owns the
single top chrome, the only timeline scroll container, message grouping,
exact participant AvatarRef rendering, conditional Host-generated initials,
status announcement, ephemeral draft, fixed composer geometry, focus and
responsive behavior. An explicit participant AvatarRef is rendered on every
incoming Agent message. The legacy `host-initials` presentation controls only
descriptor-less initials in a multi-participant projection. Identity actions
remain gated by an exact AgentDefinition identity presentation rather than a
display-name guess.

The associated command controller preserves the exact owner id,
`agent-desktop` shell, binding id, owner generation, separate snapshot
generation, and a Host-private snapshot-sequence freshness fence. It creates
scope-discriminated Host command contexts; only message scope carries canonical
`itemId`, while composer submit
carries a bounded primitive string. Before execution, the complete request and
all nested binding, reference, command arguments and context data are cloned
and deeply frozen, so caller mutation cannot change the observed command. The
`new-room` selection discriminator directly contains exactly one enabled
`newRoomAction`; its projection contains
no timeline and forbids the separate header-action list. Models contain no callback,
DOM, CSS, media URL, Connector handle or renderer component.

The production adapter preserves the formal v1 compatibility path and consumes
the exact formal `@cordisx/protocol/agent-conversation-shell/v2` export for
Agent identity, active runs, presence, acknowledgement sources and reactions. A plugin injects
`agentConversationShell`, calls `registerSource(factory)`, and gives the
returned Host-owned `mount` to its normal `pages.register` declaration. The
Host invokes the factory only after it has issued an immutable binding for the
current page route; the plugin then supplies only the formal
`snapshot/subscribe/dispose` source. The adapter validates and clones the
complete snapshot, exact binding and generation, accepted subscription
descriptor, replay watermark, serialized cursor, monotonic updates and
terminal disposal before projecting any data. Registration, page unmount,
generation replacement and terminal source updates all release the runtime
handle and source.

For Session-compatible Shell v4 identity actions, the same Host Agent/Session
authority resolves each accepted or recovered `AgentSetup` catalog with the
established AgentDefinition inheritance, prompt, and avatar rules, then retains
the complete exact effective catalog on the owned Session and its current Agent
generation. Shell identity resolution consults this authority alongside the
byte-preserved AgentLoop v4 catalog, so recovered member and message-avatar
actions still open the exact identity detail and Recent tasks retains its agent
label. Owner, Session, connection, or Agent generation replacement removes the
stale live presentation; unresolved identities continue to use the members
search fallback. Active Session navigation consumes only the Host-issued
`AgentDetailReference` carried by the Shell v4 run.

Conversation commands remain normal owner commands registered through
`ctx.commands`. The Host verifies the renderer freshness fence and injects the
formal, deeply frozen `AgentConversationShellCommandContext` as
`CordisXCommandContext.hostContext`; plugins never create that context. This
data-provider service does not add a manifest permission capability: its
Cordis injection name is `agentConversationShell`. The UI Playground may
construct a package-local, debug-only private projection and mount this
production renderer; production renderer and adapter modules never import
Playground fixtures or selectors.

Shell v9 extends that command boundary with three disjoint Host-owned
admission paths. A mounted Room with an exact Session-backed active run receives
the normal immutable v1 `AgentCommandOrigin`; the plugin uses v3 to issue one
opaque target capability per known delivery, reserve its exact Agent handle, and
capture before private driver submission. A mounted Room with no such known
Session-backed target receives a bootstrap origin, but may use v5 only to
declare `{roomId, participantId, memberId, runId}` through
`agentAdmissionBootstrapRoomTargets.issue`. The clone-safe v5 receipt is
retained with the same live binding and its paired reservation captures the
newly acquired exact Agent handle before driver submission; it cannot transfer
across a route or binding replacement. A fresh/no-Room composer, whose handler
creates a Room and then navigates to it, uses v6 only: the plugin declares each
exact `{roomId, participantId, memberId, runId, route:{routeId, param:'roomId',
roomId}}` through `agentAdmissionBootstrapRouteDeclarations.declare`. The Host
returns one opaque continuation per declaration; an accepted submission records
the exact `{sessionId, messageId}` under it. When the matching same-owner Room
route obtains its new Host binding, the Host-only claim atomically moves—not
copies—that source capture to the new binding before navigation resolves or
deferred scenario work can run. Every path binds the full
`PluginOwnerIdentity`, command, binding, connection, execution, Room and exact
target; a plugin-id match alone never spans generations. The old binding is
never retained as live authority. Capabilities, receipts, reservations and
claims are one-shot and fail closed on command completion, target/Room/owner
substitution, unmatched route activation, binding/generation/connection
replacement, revocation, or disposal. The frozen Shell v8 target-origin path
is unchanged and has no bootstrap fallback.

The renderer also owns one fixed-height Room header and one reusable
`HostConversationRightInspector`. The header projects the Room title and
description, members/settings/more actions, and a raw composite of the exact
ordered participant AvatarRefs; it does not infer membership from names or
decorate the composite with another badge surface. Members, settings, more,
and Agent identity content all share the same inspector. At sufficient
container width it is a split pane which compresses the conversation; below
the container breakpoint it is a drawer with a scrim, focus trap, Escape and
outside-close behavior, and exact focus return. Resize and snapshot
replacement preserve the active inspector and focused control. Inspector state
is local presentation state and does not add native-history entries.

The public plugin surface follows DeepSeek Harness: plugins declare injected
services and use `ctx.slots.inject/register` for structured shell data. Both
methods install Cordis effects through the service proxy, so the caller's fiber
owns every registration and update handle. There is no parallel
`ctx.cordisx.contribute()` facade.

### Slot plane

The five feasibility-era direct-DOM slots were removed together. Registrations
now contain only validated actions, navigation items, menu entries, sections,
rows, and update handles. The host owns DOM, styles, keyboard/a11y behavior,
loading/error projection, ordering, overflow, and cleanup.

Complex UI registers a page and route, then mounts only inside a declared
CordisX outlet. `app`, `main`, and `session.content` are initial host adapter
declarations, not a closed union. React anchor disconnection is only a
reconciliation signal: the same `contextKey` migrates the same outlet and page
state, while a changed key aborts/disposes the page. Native React nodes remain
in place, visible, and subscribed. The complete contract and test matrix live
in [`data-contribution-routing.md`](data-contribution-routing.md).

The current Codex session tree may retain a legacy thread drop-target around
the newer main-thread timeline seat. `session.content` treats that nesting as
one semantic region: one identity-matched current timeline seat wins, and the
legacy drop-target is considered only when no current seat exists. Multiple
matching seats at the same priority remain unavailable. This ordering is an
adapter compatibility rule, never a geometry or application-body fallback.

Structured shell surfaces are not page overlays. The private Codex adapter
projects them through minimal host-owned insertion seats in the resolved native
layout. Buttons sit before or after their semantic control, navigation rows
join the native list, and environment rows and sections join the native panel.
If a precise seat is unavailable the contribution remains pending; the adapter
does not fall back to a fixed covering card. Mutation repair may reinsert a
detached seat after React replaces its parent, but plugins never receive that
DOM.

The bounded `composer.reasoning-intensity` and `session.backdrop` surfaces are
the same ownership rule applied to presentation data. The Host alone observes
the native range and renders the control, ambient geometry, transitions,
pointer policy, and cleanup. A plugin may supply ordered semantic materials and
one embedded transparent PNG portrait per backdrop stage; it cannot supply a
selector, network URL, CSS, HTML, or executable renderer. The backdrop retains
the last observed stage only for the same active session and is removed on
session change, contribution withdrawal, or adapter disposal.

`extension-point-control` v1 adds a Host-owned control plane to the existing
`slots.register()` path; it does not add a second full-declaration API. A
plugin may add only a local claim id, mode, priority, and requested safe
bindings. The Host stamps the canonical source/plugin/point/contribution,
launcher principal, legacy order, and generation. Legacy registrations remain
`compose` with `priority = -order`; `replace`, `overlay`, `proxy`, and
`hide-native` default to denied. Exclusive decisions and partial claim grants
are resolved by the Host policy broker before ordered claims, and every command
invocation is rechecked against the current principal, generation, grant,
selection, point state, and allowlisted scalar arguments.

The returned controlled contribution handle exposes only a claim-scoped lease:
a scalar snapshot, invalidation subscription, and Host-brokered command
request. It never contains selectors, nodes, CSS, native callbacks, native
events, or business command results. Claim denial, point-local access denial,
switching, ancestor suppression, generation replacement, and disposal remove
its projected properties and commands and reject invocation. Lifecycle
subscriptions remain attached with a scrubbed state-only snapshot so recovery
is observable; unloading revokes the lease. Adapter effects are separate from
this state machine. For `composer.reasoning-intensity`, replace/legacy rendering
hides and restores the native presentation, overlay retains it, proxy performs
no DOM effect, and hide-native uses a reversible Host visibility lease.

Manager receives a separate read-only diagnostic projection with candidates,
exact claim policy, durable user group choices, current group decisions, and
suppression reason chains. The durable choice drives the selector even while
the point is not mounted; the current decision separately reports runtime
effect. Manager writes call the Host policy broker; plugins cannot submit a
selected winner.
The projection, opaque principal handles, stored policy, and diagnostics are
removed from the public runtime snapshot. Policy storage contains only
principal bindings, exact authorization records, and group choices under a
profile-qualified local-storage key inside the CordisX Chromium profile; it
contains no presenter, selector, native value, or generation metadata. A
missing plugin leaves a dormant policy with no runtime effect, and a later
generation of the same canonical source/plugin/origin reuses its Host principal.

The generic resolver implements and tests transitive parent/subtree
suppression and same-generation restoration. The current production Codex
control catalog binds `composer.reasoning-intensity` and
`composer.toolbar.items`. The toolbar point exposes the exact
`cordisx.composer-submit-celebration/v1` profile through one host-priority,
exclusive `proxy` claim: property `celebrationProfile`, event
`submitActivated`, and commands `presentCelebration` / `dismissCelebration`.
The Host emits a five-second, opaque, single-use activation only for an enabled
native submit activation. It alone owns the pointer-inert full-window confetti
DOM, styles, timer, idempotency, and removal on timeout, unload, replacement,
candidate abort, rollback, or adapter disposal. The plugin receives no native
event, selector, node, stylesheet, timer, or presentation handle. Real-App
evidence for a parent control point still must not be claimed until such a
semantic parent is cataloged and adapted.

The host-neutral surface/outlet vocabulary, current Codex adapter availability,
DeepSeek Harness intent mapping, explicit replacement refusals, contextual
identity boundary, PR order, and validation matrix are maintained in
[`ui-extension-catalog-codex-adapter.md`](ui-extension-catalog-codex-adapter.md).
The catalog distinguishes implemented, experimental, and reserved points;
protocol reservation is never evidence that the current Codex adapter can
project a point.

The manager-settings A compatibility pair remains host-neutral:
`manager.settings.tabs` accepts structured tab records and
`manager.settings.content` accepts same-owner routes/pages for controlled body
mounts. These are Manager extension points, not Codex adapter surfaces, and
require no selector or native anchor. The current product IA has no top-level
Settings destination, so both points remain registered and diagnosable but
report current context `not-mounted`; CordisX must not manufacture an empty
Settings page to project them. Their closed versions, point-policy identities,
Host-owned header boundary, and fallback semantics for a Host that does expose
Settings remain specified in
[`manager-settings-tabs.md`](manager-settings-tabs.md).

Catalog v4 adds the distinct B pair
`manager.settings.navigation-items` / `manager.content`. B inserts a
Host-rendered first-level Manager destination across the stable virtual
settings seam and opens a standard Manager page; no visible Host Settings row
is required. Its item contains only a same-owner route. Route v2 supplies
navigation title and description, while page v3 supplies the required Host
icon and standard header title/description/actions. The active destination
falls back to `host:plugins` when it becomes ineligible. A's stable id and
body-only outlet remain unchanged. The merge model, routing, lifecycle,
configuration planes, file-overlap audit, delivery order, and validation
matrix are normative in
[`manager-settings-navigation.md`](manager-settings-navigation.md).

An active authorized `manager.content` page also receives the optional,
page-scoped `managerCollection` registry in its mount context (and therefore
in shared-React page props). The Host creates the collection root as a sibling
of the contributed page body and never exposes that root to the plugin. One
registration supplies only immutable registration/source data; the Host owns
view selection, exact Unicode search and final filtering, rows and visuals,
route activation, menus, text-input and confirmation dialogs, clipboard,
feedback, focus, keyboard, accessibility, and theme. A route change, page
close, owner disposal, or generation replacement aborts pending queries,
unsubscribes, disposes the source exactly once, and removes all Host UI. The
registry is absent from `manager.settings.content`; separate first-level
Manager routes register separate collections rather than sharing private view
state across routes.

Manager content navigation v1 and v2 share one owner-qualified declaration and
route collision domain. V2 alone accepts an optional localized tab label; the
Host projects it into the unchanged projection-v1 tab text, otherwise derives
that text from the target route title. An owner may atomically replace one
mixed-v1/v2 declaration catalog together with its record-title catalog; every
declaration still passes its own exact version validator before the transaction
becomes visible. V1 remains closed and keeps its existing target-page-title
behavior. Tab labels never alter headers, breadcrumbs,
record titles, routing, history, selection, or lifecycle, and do not introduce
a redirect or default-child route.

Native menu contributions use the same boundary: CordisX inserts host-rendered
rows into the opened Codex Help or account menu and never adds an independent
fallback menu trigger. Compact shell actions are icon-only and inherit the
interaction pattern of adjacent native Codex controls. Their host-owned glyph
token reduces only the decorative SVG by four pixels while preserving the
existing wrapper, native button hit box, alignment, tooltip, focus, and
accessible name; the separately sized brand manager trigger and composer
toolbar appearance are excluded.

For `session.header.actions`, the host renders a new button inside its own
`no-drag` seat before the complete adjacent native control wrapper. A native
TooltipTrigger may use a `display: contents` wrapper; CordisX anchors beside
that wrapper and never inserts into it, delegates activation to it, or reuses
its tooltip. The CordisX tooltip is a body portal owned and disposed by the
current renderer generation. The same public host control boundary marks the
seat, icon button, and every rendered descendant as Electron `no-drag`; this is
shared by title-bar/header structured controls rather than implemented by an
Agent Trace selector or plugin listener. Native drag space stays outside the
seat, and the host verifies the button remains the pointer hit-test target.

Toolbar button state and spacing are also Host-owned. The renderer does not
copy a native reference button's `className`: Codex may add unconditional
pressed background/foreground utilities to that node, and copying the class
would project one native toggle's state onto every CordisX sibling. CordisX
uses a stable 28-pixel toolbar variant and projects idle, hover, focus-visible,
open, disabled, and route-toggle pressed states on each generated button. Only
an exact presented route produces `aria-pressed="true"` and the pressed style.
The Host-owned pressed semantic token uses the current theme text color at five
percent, with a ten-percent hover/open layer, primary foreground, the existing
focus ring, and 40-percent disabled opacity. It is scoped to the exact
generated button state rather than its toolbar seat, so no sibling or native
control is activated with it.
The independent `--cordisx-toolbar-action-gap` and
`--cordisx-toolbar-outer-group-gap` tokens are both verified as six pixels for
the current host: the first separates actions inside the CordisX seat and the
second separates the seat from the adjacent native summary toggle. Workspace
slot sizing continues to add only measured contribution widths to the native
minimum; it must not add `roots.length * gap`, so the verified two-root slot
remains 126 pixels and retains the native `ms-auto` alignment.

Route-backed controls may opt into protocol-v3 `toggle` behavior. The host
binds contextual session parameters, compares the exact owner-qualified route
and parameters with current outlet state, and projects `aria-pressed`; plugins
do not keep a parallel open boolean. Re-activation, Escape, policy close,
session change, plugin block, and generation disposal all converge on the same
outlet lifecycle. An explicit close restores focus to the still-connected
host-rendered trigger when practical.

Plugin routes use Codex's current React Router MemoryHistory as their only
back/forward authority. Executable inspection of Desktop 26.818.61809 shows
that `window.history` remains length 1 with null state while the native title
bar can still go back. The private adapter therefore discovers the existing
React Router Context navigator from the live React root and requires its
`index`, `location.key`, `push`, `replace`, and `go` seam. It wraps those three
mutation methods reversibly so native PUSH/REPLACE/POP can be
reverse-projected, but never calls the navigator's single-listener `listen`
method or replaces React Router's listener. A failed probe makes route
navigation unavailable; it never activates a CordisX memory-history fallback.
A successful `ctx.routes.navigate()` validates the complete
owner/permission/params/page/outlet/session tuple, preserves Codex's native
pathname and state, then adds a closed namespaced route projection while
advancing that same MemoryHistory. Consequently native title-bar buttons,
keyboard shortcuts, trackpad gestures, page-chrome Back/close, and plugin jumps
all traverse one history. Same route ids with different params are distinct
entries.

Initial injection and reload restore only the current validated projection. A
single browser-history record stores that current reload checkpoint, bound to
the native pathname/search/hash; it is replaced or cleared after every Codex
navigator transition and is never a back/forward stack.
Same-id plugin generation replacement rebinds that entry without adding or
replacing history; an invalidated, blocked, or uninstalled current route is
removed with REPLACE at the same index. A non-current stale entry cannot be
rewritten until native navigation reaches it, at which point validation either
mounts it or replaces its invalid projection. CordisX never queries or clicks
the native controls and never patches an installed application file.

Sidebar Room history uses the Host public structured-collection lifecycle, not
plugin DOM and not Playground task fixtures. A plugin registers one
`sidebar.navigation.items` collection source with a localized group label and
an atomically replaced, monotonically revised list of route-only descriptors.
The source orders its Room descriptors latest-first; the Host clones and
freezes each replacement, validates bounded ids/text/icons/routes, renders the
group heading and rows with the shared SidebarItem primitive, and derives the
single selected row from the exact owner-qualified route plus parameters.

The Playground unified Recent tasks list uses the same Host SidebarItem
primitive and keeps a task/history semantic icon. Agent identity Avatars belong
to conversation participant surfaces, not to generic task navigation. A future
per-Room composite leading visual must come from an exact row-scoped collection
contract; the Host must not infer it from the current Room selection or title.

Playground Agent/Session runs enter that same Recent tasks and Simulator detail
surface through a Host-private read projection of the single Agent/Session
authority. The task key and details route are the exact `SessionId`; every
conversation, tool, approval, and lifecycle row retains its originating
`SessionEvent` and sequence. Live status comes from the current Agent generation,
while recovered status is derived only from the persisted event terminal. The
projection is merged additively beside the byte-preserved AgentLoop Simulator,
but is never written to the browser task-snapshot registry: restart recovery
comes exclusively from the launcher-owned Playground SessionEvent store. This
prevents Recent tasks from becoming a second execution or causation ledger.

AgentLoop v2 commands are accepted only when the Host can provide the formal
owner/provider durable-ledger semantics. The explicit Playground mock uses
session-scoped persistence for disposable simulator state. A real/local-cli
renderer without the launcher-owned durable RPC fails v2 create/send closed as
`reconciliation-required`; it must not advertise an accepted operation backed
only by renderer memory or localStorage. Real provider task recovery across a
Host restart remains unavailable until the launcher-owned, generation-fenced
ledger and provider reconciliation service is delivered.

Collection subscriptions are owned by the calling Cordis fiber. Plugin block,
generation replacement, registration disposal, or runtime teardown
unsubscribes the source, removes the whole group in one published surface
epoch, and rejects late or same-revision mutation. The collection is a
projection rather than a Host Room database: after reload, the plugin or its
provider must restore the complete source snapshot before registration. This
Host-specific navigation lifecycle does not extend the room-neutral
Conversation Shell Protocol.

Page-v2 `body-only` is a general structured chrome policy with a host outlet
gate. The current adapter accepts it only for `session.content`, whose overlay
begins below the retained native session header. The host does not create a
CordisX header/title/close row in that mode; `app` and `main` reject it because
they cover native chrome. No plugin can supply substitute header DOM, CSS, or a
selector.

Route and page outlets remain independent overlays. `app` paints through the
native title-bar and supplies its own draggable chrome with a macOS
traffic-light safe inset; `main` paints the entire region to the right of the
sidebar from `y=0` through a body-level portal and supplies draggable chrome
there. The portal avoids being trapped below the native main-toolbar stacking
context while its geometry still follows sidebar collapse and width changes.
Interactive controls are always explicit `no-drag` regions. This keeps native
window dragging and ordinary page controls from competing for the same
hit-test region.

Both chrome variants are the same host-owned structured projection. Plugins
declare only validated title/icon/breadcrumb/tab/action data, and header
actions reference commands that the host dispatches after checking the active
outlet policy. Plugins receive a body mount container, never a header seat,
node, component, or render callback. Covering the native header therefore
changes geometry only; it does not transfer shell rendering authority to the
plugin.

The host may improve selectors without requiring plugin changes. Plugins that query Codex DOM directly opt out of that compatibility boundary.

### Host-owned form plane

Host-owned configuration, import, Marketplace, permission, Provider, and
Channel forms share the scoped primitive, theme, validation, and state model in
[`host-form-system.md`](host-form-system.md). Plugins still provide structured
schema data and bounded custom field content only; they never receive a UI
library instance, form root, selector, CSS, or portal authority.

The Host bundles a reproducible subset of the official
`tdesign-web-components@1.2.10` Web Components implementation. It imports only
the supported controls, keeps component CSS in their open Shadow roots, scopes
base tokens to `.cxf-scope`, and attaches dropdowns to a CordisX-owned Shadow
portal. The full npm graph and global stylesheet are not installed. A thin
Host adapter supplies the missing accessibility/theme seams without a React
root or second schema registry. This is an implementation boundary, not a new
plugin contract.

### Built-in manager plane

The built-in Manager implementation uses a Host-owned React 19 component tree.
React owns rendering and local interaction state only; Cordis remains the
runtime and plugin lifecycle authority. Manager components consume immutable
Host snapshots and brokered Host actions through an external store. They do
not expose React, DOM nodes, portals, CSS, or UI-library instances to plugins.

The implementation is split by responsibility:

- `renderer/host-ui` contains reusable Host primitives and interaction hooks;
- `renderer/manager/model` adapts runtime snapshots and actions into a React
  external store;
- `renderer/manager/components` contains Manager shell and feature panels;
- `renderer/manager/hooks` contains Host lifecycle, theme, focus, and scrolling
  policies; and
- `playground` composes the development host but owns no Manager behavior.

The previous imperative Manager is a migration seam only. New behavior must be
implemented in the component/store layers rather than appended to that file,
and each migrated feature removes the corresponding imperative ownership.
There is one React root per renderer generation and it is unmounted before the
generation's Cordis resources are disposed.

The local plugin manager is host chrome, not a plugin contribution and not a
new public slot. Its trigger is mounted beside Codex's workspace switcher by a
private adapter probe, and a mutation observer remounts it when the host React
tree replaces that row. The manager and every listener, observer, and DOM node
it creates are disposed with the CordisX renderer generation.

The manager reads a runtime-owned snapshot rather than scraping plugin UI. The
snapshot joins three internal sources:

- build metadata supplies the CordisX package version;
- the runtime tracks each bundled plugin module, Cordis fiber, configuration,
  and active or blocked state;
- the structured registries attribute commands, surfaces, routes, pages, and
  outlets to the calling plugin fiber and report validation, context, and mount
  state.

Blocking a plugin disposes only that plugin's Cordis fiber, which reverses its
slot registrations and effects. Restoring it creates a fresh fiber from the
already bundled trusted module. The blocked-id set may be retained in renderer
storage for the current Chromium profile, but this is activation state rather
than package removal: module top-level code is already in the trusted bundle,
and the manager does not edit `cordisx.config.json`, install packages, enforce
permissions, or create a security boundary.

The dynamic lifecycle follow-up replaces renderer-local block state with a
launcher-owned profile activation record for package enable/disable. It keeps
explicit reload as an owning-fiber operation and uses plugin generations only
for code, entry, version, or dependency changes. The manager remains a brokered
projection and never receives filesystem or arbitrary module-loading authority.

The manager has five non-spoofable Host primary navigation views:

1. searchable installed-plugin inventory and local runtime controls;
2. semantic extension points with attributed plugin use and enforced policy;
3. routes/pages as a separate associated-resource inventory;
4. marketplace discovery from validated feeds; and
5. product identity, version, and verified external support links on About.

Eligible `manager.settings.navigation-items` records may join only on the two
sides of the virtual settings seam. They are independent plugin pages rather
than fixed Host views. Host core order and bottom-anchored About cannot be
overridden.

Manager-owned content follows one semantic context at a time: a title,
breadcrumb, or selected tab is not restated by body headings or redundant
cards. The reusable hierarchy, flat-list/card, exceptional-state,
accessibility, and visual-regression rules are normative in
[`manager-content-design.md`](manager-content-design.md).

Plugin inventory is a list page rather than a permanent list/detail split.
Selecting a plugin opens a second-level detail page inside the manager; its
header provides an icon-only back action and the breadcrumb `插件 / <name>`.
Every manager header reserves one fixed-size leading slot: a primary page puts
its page glyph in that slot, while a second- or third-level page replaces the
glyph with the back action. Both controls share the same geometry, so changing
levels never moves the title horizontally. The back action has an accessible
name without visible text. Returning preserves the list search query. The same
list-to-detail navigation pattern is used by marketplace discovery so dense
details do not crowd catalog results.

Installed plugin detail is local tab navigation inside that second-level page,
not another semantic extension point. Its default `README` tab renders the
plugin's adjacent `README.md`; `配置管理` shows the configuration available to
the current bundle; `运行状态` owns activation state, injected services,
failures and block/restore actions; `扩展点位` lists only attributed surface or
outlet use; and `路由` separately owns routes, pages, and their outlet
associations. Runtime status does not repeat route/page inventory. The launcher
reads the adjacent README while
composing the browser bundle so the renderer does not gain filesystem access.
The manager renders a deliberately limited Markdown subset by creating DOM
nodes and text nodes only: raw HTML is never interpreted, and remote media or
script execution is not supported. A missing README produces an explicit empty
state rather than synthesized package documentation.

Marketplace discovery adds a searchable catalog assembled from validated
feeds with a two-tab `概览` / `作者与来源` detail. Source management belongs to
the Plugin Store workflow rather than a general Manager Settings category.
The current IA removes the top-level `配置` destination and its empty
`运行状态` / `启动器` placeholders. The former settings-content extension
points remain registered compatibility identities with current context
`not-mounted`; the Host does not render a shell solely for them. Feed
aggregation keys
plugins by canonical `(source, id)` identity; the first configured feed wins a
duplicate. Source settings and blocked plugin ids are separate profile-local
state. Catalog entries can link to authors, their public source, optional
homepage, manifest/icon, and feed provenance, but cannot install or activate
code in this stage. External navigation first hides the manager modal and then
uses the browser's uncancelled `_blank` navigation with `noopener noreferrer`.

The primary manager navigation keeps Host `插件`, `扩展点`, `路由`, and
`插件商店` as separate top-level contexts. Eligible B entries are grouped on
the two sides of the stable virtual settings seam; there is no rendered
`配置` row. About remains anchored last. Searchable browse pages omit aggregate
result and usage counts. The content viewport is the single vertical scroll
owner and restores query/scroll state after a detail back action.

Configuration has two distinct application planes. CLI-resolved executable,
debug port, profile, launch environment, and other process-start values are
frozen for the current process and are not Manager global settings. Runtime
configuration stays in the owning plugin detail beside permissions and
declares `live`, `plugin-restart`, `service-restart`, or `app-restart`.
CLIProxy owns Provider configuration. A staged app-restart value does not
mutate the current fiber or watchers; service-restart requires an owning
launcher handler and is not downgraded to a plugin restart. Removing Manager
placeholders does not remove CLI parsing, launcher stores, or diagnostics.

The normal CordisX Home document and an explicit Playground launcher
composition are also separate storage envelopes. They share the same
owner/profile/generation-scoped plugin candidate ledger and revision CAS, but
each read-modify-write uses its own parser. A Playground Manager save replaces
only the selected plugin profile state inside the validated launcher document;
launcher fields such as `codex` and unconsumed forward-compatible fields remain
unchanged. The Host never normalizes that launcher document through the Home
schema, and both stores retain the same lock, no-follow read, atomic rename,
file-mode, candidate ownership, commit, and abort fences. A disposable
Playground home continues to receive a fresh fixture, while an explicitly
selected stable home materializes each launcher and Home document only when it
is absent. Existing documents are adopted only after their respective formal
parsers accept them and are never replaced from a changed source fixture;
malformed or incompatible documents fail startup without rewriting either
file. This startup path is distinct from the explicit preview-reset authority,
which remains the only operation that intentionally restores the fixture.
After a successful Playground commit, the owning session publishes one
effective-composition change for each advancing plugin revision. The Vite
server invalidates only its cached virtual composition, so a reload rebuilds
from that committed ledger; commit publication, composition rebuild, reset,
and disposal are serialized so the next generation cannot hydrate an
intermediate document. Abort, conflict, rejected, and stale-generation requests
never publish a change.

Codex's `app://` renderer rejects direct arbitrary network reads, including the
official raw GitHub feed. The launcher therefore owns a narrow, private CDP
binding for marketplace JSON retrieval. It accepts only configured public
HTTPS URLs, resolves and rejects non-public network addresses, follows a small
number of individually revalidated HTTPS redirects, applies timeout/response
size/concurrency limits, and returns text to the manager for protocol
validation. The binding is reserved host infrastructure rather than a plugin
API and catalog code is never evaluated. This reserved name is not capability
enforcement: plugins are still trusted renderer code and can inspect globals,
so the public-HTTPS, address, redirect, concurrency, timeout, and size limits
are damage-reduction boundaries rather than isolation from a malicious bundled
plugin.

That renderer bridge and the renderer Marketplace model are display-only trust
projections. They are not permission or lifecycle authorities because a bundled
plugin shares the renderer realm and may mutate `localStorage`, bridge/global
objects, or primordials before Manager initialization. Exact Certified
eligibility is instead evaluated by
`launcher/marketplace-certified-authority.ts`. It loads at most eight enabled
roots from Host-owned home config, fetches and parses feeds in the Launcher
realm with bounded public-HTTPS requests, and exposes only strict
`source + pluginId + version + sha256 integrity` lookup plus revision-only
subscription. Official identity never enters this API.

The authority persists the last valid feed body/digest, a non-decreasing
`generatedAt` fence, equal-revision divergence state, projection revision, and
local expiry under the selected profile in
`CORDISX_HOME/state/marketplace-certified`. State is private, bounded,
symlink-rejecting, and atomically replaced. A source disable/removal clears its
projection while retaining the rollback fence; a newer revocation replaces an
older active feed; an older replay cannot restore it; and an active
certification disappears at `expiresAt` even without network activity. A
successful malformed or identity-mismatched feed fails closed. Transport
failure may retain only a still-unexpired last-good projection. No renderer RPC
can submit roots, feed bodies, Official/Certified assertions, projections, or
attestations to this authority. PermissionBroker and PackageLifecycleAuthority
must re-read the private exact lookup at plan/apply and treat absence or any
fingerprint/revision change as revocation.

The production Launcher-to-Broker handoff does not reuse the display-side
Marketplace model. A random future-document take key is emitted only in the
new-document bootstrap. CDP atomically takes one endpoint and keeps its
RemoteObject in the debugger; the renderer receives no projection-setting
global or reusable credential. Every authority notification and bounded
heartbeat performs a fresh Launcher snapshot read, then delivers an exact
profile/runtime/document-epoch envelope with monotonic sequence and revision.
Context destruction, target replacement, timeout, replay, equivocation,
delivery failure, or endpoint close clears Certified eligibility in the same
PermissionBroker. The current already-running document remains fail-closed.

Manifest-v5 artifacts declaring `ui.host-dom.read` or
`ui.host-dom.modify` use a separate production execution path. Bundle and CDP
carry their source only as data; the renderer creates an opaque-origin sandbox
iframe which owns a locked-down classic Blob worker. The worker receives a
frozen serialized `{ hostDom, onDispose }` facade and JSON configuration, not
Cordis context, DOM objects, selectors, raw bridges, or ambient renderer
globals. The Host captures native DOM/MessagePort primitives before plugin
activation, binds every RPC envelope to a per-boundary random token, and keeps
the real `BoundHostDomClient` in the Host renderer. Worker readiness is the
availability signal; dispose, disable, uninstall, generation replacement, or
Broker invalidation terminates the transport and rolls back owned DOM effects.
This narrow boundary does not relabel legacy structured/local-development
plugins as sandboxed code.

Manifest metadata, dependency graphs, compatibility declarations, immutable
local packages, and activation transactions are described in
[`dynamic-plugin-lifecycle.md`](dynamic-plugin-lifecycle.md). General-purpose
untrusted execution isolation for legacy structured plugins remains a later
stage; the Host DOM worker is deliberately capability-specific.

### PublisherGrant authorization seam

`launcher/publisher-grants.ts` is a launcher-only seam for the normative
`publisher-grant.v1` protocol. It verifies a Host-registered Ed25519 issuer
key, creates or retrieves one macOS Keychain machine identity outside
`CORDISX_HOME`, and keeps signed-grant/import state inside each selected home.
This persistence boundary also applies to direct-entry and config-based
development launches: project/config roots resolve project inputs, while the
PublisherGrant store remains under `CORDISX_HOME/state/publisher-grants`.
Their default project-scoped Chromium profile likewise remains below the
selected `CORDISX_HOME/projects`; only an explicit `--profile-dir` relocates
that profile. Non-dry development applies the canonical CordisX Home ownership,
real-directory, and `0700` policy before either write, and creates new default
or explicit profile directories as `0700`. Dry-run development performs
neither write.
The default `direct-device-bound` path accepts a publisher grant only when its
public-key digest matches that machine identity; no CordisX registry is needed.
It persists a non-decreasing accepted-statement time for expiry/offline grace.
An optional registry-enhanced request may add first-claim semantics but cannot
block the direct path when absent. Marketplace v4 may expose external purchase,
manage, and recovery URLs; the Host adds the device challenge only at navigation
time. A narrow launcher binding offers the Manager challenge, scoped status,
and statement import but no private key, payment data, registry credential, or
raw bridge. There is no local-file private-key fallback.

The Host gates CordisX package/feature projection only; it does not claim to
stop source or a modified Host outside CordisX. It never receives payment,
order, price, currency, refund, tax, invoice, chargeback, settlement, or KYC
data, and no payment webhook exists in this architecture.

The Platform slice adds versioned capability declarations, an identity-bound
Permission Broker, and manager permission projections. These controls govern
cooperative `ctx.platform` calls only; package installation, signatures,
untrusted execution isolation, and marketplace activation remain later stages.

The same Broker also owns controlled extension-point rendering authorization.
Its permission-v3 catalog adds one DOM/rendering capability and keeps every
existing Platform, Agent, and Channel capability non-DOM. A configured
Marketplace trust root may provide an exact Certified artifact projection; only
that projection and only the catalog-designated DOM capability may skip the
visible confirmation. The Host still issues and audits a profile/scope/security-
fingerprint/generation-bound lease. Official provenance never enters this
decision. Extension-point availability probes stay independent, and legacy
point/control policy stores are migration inputs rather than a second runtime
authorization authority.

The multi-provider Platform slice routes every model and session operation by
structured provider-aware identity. Its launcher-private RPC exposes normalized
operations only; credentials, child processes, app-server messages, and raw
transport stay outside the renderer. An external provider becoming available
does not change the honest status of the native current-connection adapter.
The renderer adapter authenticates the narrow CDP binding with a per-launch
closure-bound token before any Platform operation is dispatched. Plugins use
only `ctx.platform`, so the Permission Broker retains canonical source identity,
composite requested session/model targets, policy outcome, and user-visible
audit state. This reduces accidental binding bypass inside the current trusted
renderer model; it is not a substitute for a future isolated plugin realm.

### Host icon-theme authority

The Host owns icon DOM, accessibility, sizing, color, pointer policy, and the
private Reicon fallback. Plugin themes register bounded normalized descriptors
only. Provider and principal handles, raw geometry, source paths, and callbacks
do not cross the public Manager snapshot. Manager concepts missing from the
formal Protocol catalog remain Host-private builtin glyph choices; the Host
does not route them through an unrelated semantic key to a selected provider.

Every registry creates fresh builtin and plugin provider handles. Exact handles,
Host generation, provider generation, revision, and request correlation fence
runtime selection, resolution, rollback, disposal, and late results. Durable
profile preference stores only the approved provider identity, version, and
Host-derived artifact generation. A launcher-private same-profile broadcast
caches only the highest monotonic durable revision, distributes it to active
renderers, and replays it for every boot-ready document rather than treating a
CDP target as permanently delivered. Each document creates a Host-private
epoch and completes a launcher handshake after installing its runtime
subscription. Delivery is bound to the app/profile, target, launcher session,
document epoch, and exact execution context; the renderer must acknowledge the
same epoch and a current revision at least as new as the winner. Missing,
throwing, destroyed-context, stale-revision, and malformed acknowledgements do
not count as convergence. The private document preference state machine is
`booting -> ready-pending(requiredRevision) -> synchronized(ackedRevision >=
requiredRevision) | disposed/replaced`. A pending response carries the
launcher's required durable revision and the document's acknowledged revision;
the browser never completes runtime boot from its older embedded revision alone.
It reissues the same-epoch ready signal over two bounded backoff intervals, with
two immediate delivery attempts in each round. Exhausted rounds fail boot with
an explicit pending diagnostic; a later explicit ready signal can open a fresh
bounded round without losing the cached winner.

New ready ingress revokes and aborts the previous document before serialized
receiver installation. Delivery races exact-context CDP evaluation against that
cancellation, so replacement or target close unblocks the new epoch and a late
old-context result cannot acknowledge, mutate pending state, or affect current
document accounting. Before entering that serialized installation, the
profile-scoped hub atomically reserves the target/session/document epoch. The
reservation remains profile-wide pending through receiver registration, winner
replay, and the exact ready-response acknowledgement; another renderer cannot
report complete while that document is still booting. Replacement or target
close cancels the reservation, while a successful exact-epoch acknowledgement
converts it to synchronized active state. The reservation identity also pins the
exact CDP execution context; an epoch or context replacement invalidates every
old probe, retry, and acknowledgement. Ready completion first obtains an
exact-context probe, then revalidates and, when necessary, delivers the latest
winner. Its final response uses a three-stage Host-private lease: a short
serialized prepare records the exact entry generation, document/context
identity, and required winner; the external CDP response runs outside every
profile/global lock; and a short serialized finalize accepts only the
still-current lease and an exact-epoch acknowledgement of the latest required
revision. Advancing the durable winner cache synchronously invalidates older
prepared leases before delivery begins. A held old response therefore cannot
block cache advancement or later clear booting, while a response that completes
first may linearize before the next winner. The browser reads its actual bridge
revision while processing every pending or complete leased response, retains the
exact ready request across pending/replacement delivery, and echoes the accepted
opaque lease token and monotonic lease revision in its acknowledgement. Unknown,
expired, completed, duplicate, divergent-token, and actual-revision-mismatched
responses fail closed. Finalize compares that echoed identity with the current
lease before it may clear booting.
The hub keeps durable winner state
separate from each document's acknowledged and pending revisions, lets a higher
revision supersede pending lower work, and allows explicit same-revision retry
after each bounded attempt window. A durable write response reports document
synchronization as complete or pending;
pending delivery never turns a successful atomic write into a renderer rollback.
CAS conflicts cache and attempt the durable current preference before sending
the conflict response, so response-triggered navigation cannot open a replay
window. The browser bridge also retains a winner received before the
runtime subscription exists, and startup reconciles that current value
immediately after subscribing. Each renderer rebinds the winner to its own live
handle only after an exact identity, version, artifact generation, and
active-status match. Disposed documents and closed targets cancel pending work,
and each broadcast hub is bound to exactly one app/profile. Missing, changed,
failed, or disposed providers remain on pinned Reicon; the broadcast does not
add a public Protocol surface or weaken per-process fences.

## Trust and security

Version 0.1 legacy structured plugins and explicit local-development entries
use a trusted-code renderer model. Cordis provides lifecycle and dependency
composition; it is not a general security sandbox. Manifest-v5 Host DOM
artifacts are the exception: they are not evaluated in the renderer main realm
and receive only the isolated, bounded Host DOM worker RPC described above.

Public marketplace execution outside that narrow Host DOM surface still needs
a general isolated plugin realm, publisher signatures/source identity, CSP and
network policy, and capability RPC for every exposed Host service. The current
Permission Broker controls cooperative Host services and does not sandbox
legacy trusted renderer code. Local package content hashing must not be
described as publisher verification; Official and Certified source assertions
remain independent of execution provenance and never create general authority.

## Compatibility strategy

Compatibility is owned by adapter probes rather than a single brittle selector. A resolver tries narrow stable attributes first, then structural fallbacks. If no candidate is found, the slot remains pending and does not modify the page. Plugin mount failures are contained to that contribution and shown in its outlet while other plugins continue.

Adapter releases should record the Codex versions they were tested against. Unknown versions may run in best-effort mode, but the launcher and future manager must present that state distinctly from verified compatibility.

The built-in manager trigger follows the same rule: its workspace-switcher
probe stays in the host adapter, remains pending when no unique visible target
exists, and must not make plugins depend on Codex-owned class names.

The version-0.1 bundle and lifecycle were verified in a simulated renderer DOM. The installed 26.818.41509 host can also be exercised through an isolated second process, so live probes no longer require restarting the user's active application.

## Decisions deferred

- Whether the long-term distribution unit is an npm package, a signed archive, or a Codex universal plugin plus a CordisX-specific UI entry.
- Whether isolated UI should use an iframe, a dedicated Electron utility process, or both.
- Whether a future explicitly declared host-replacement protocol should allow one winner or require an explicit user choice; the structured-contribution slice does not expose replacement slots.
- A public signed-package source and transparency policy after the local-only
  package generation boundary is proven.
