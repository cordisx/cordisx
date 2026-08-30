# Platform capabilities architecture

Status: implemented Host architecture for Platform permission v1 compatibility,
the formal permission-v2 non-DOM contract, permission-v3 controlled structured
rendering, and the permission-v4 bounded Host DOM contract. Normative
plugin-visible behavior lives in `cordisx-protocol`; the Host consumes formal
permission contracts and not closed experimental branches.

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
      PlatformService validation             capability availability registry
             |                                / provider / scope / reason \
             v                               v                             v
 host-owned PlatformAdapter boundary   manager projection        activation reconciliation
       |                 |                    ^
       v                 v                    |
 current connection   Provider Fleet    Host-local Agent ledger/history/config
```

The launcher derives `source` from the canonical local entry URL. A module may
declare a version-1 manifest but cannot replace its runtime source or id. The
runtime extends each plugin context with a private symbol carrying that
identity. `ctx.platform` reads the identity from the calling Cordis context;
no public method accepts an identity argument.

The Permission Broker normalizes and freezes declarations before plugin
activation. Its authorization key is the launcher profile, canonical source,
plugin id, capability, and normalized scope. A capability or scope change, or
a profile/source/id change, has policy `ask`. `required` and localized `reason`
are current declaration metadata rather than authority-key material. The broker
records in-memory audit timestamps and denial counts. Policy storage and prompt
UI are host-owned, while current trusted renderer execution means neither is a
tamper-proof security boundary.

## Capability availability authority

Permission policy and runtime availability are independent axes. The Broker is
authoritative for `ask` / `deny` / `allow`, exact identity, declaration scope,
and audit. It is not authoritative for whether a route currently exists. A
Host-owned capability availability registry instead aggregates reports from
the service, provider, or adapter that owns each route. A report names the
provider, provider kind, capability, `supported` / `unavailable` / `degraded`
state, localized reason, and the provider scope it can route.

`CordisXPlatformAdapterStatus.supportedCapabilities` describes only that one
adapter. It must never be interpreted as the global Host capability catalog.
The current implementation has these distinct authorities:

| Provider boundary | Owned route | Availability authority |
| --- | --- | --- |
| Desktop current connection | native model/task/turn and Agent delivery routes | the private current-connection Platform/Agent adapter; the product default remains unavailable |
| External Provider Fleet | model/task/turn routes for configured provider ids | each active or failed Fleet provider generation, scoped by its canonical provider id |
| Host-local Agent event ledger | `agent.events.read` | the live ledger service; native feed diagnostics do not erase local ledger support |
| Host Agent history | `agent.history.read` | the launcher history binding and its adapter status |
| Host configuration | validated configuration descriptors and mutation bridge | the configuration registry/bridge; this is not a Platform-v1 permission name |
| Host console | plugin DevTools Console contracts | its owning Host service; protocol presence alone does not claim runtime support |
| Host package lifecycle | inspect/stage/activate/rollback contracts | the launcher generation/lifecycle bridge introduced by the dynamic delivery runtime; protocol presence alone does not claim runtime support |

The last three remain separate service planes. They are represented as distinct
provider families for runtime diagnostics, but the Host does not invent
Platform manifest capabilities for contracts that do not define one.
Package-family availability therefore reuses the existing lifecycle bridge and
activation registry; the Platform layer does not create a parallel package
registry.

Resolution is declaration-specific. Provider ids in `scope.providers` and
Platform session references are matched against routable provider scopes. If
at least one allowed route can serve an otherwise provider-open declaration,
the capability is supported. If an explicit multi-provider scope is only
partly routable, or an owning provider reports reduced coverage, it is
degraded. If no route can satisfy the declaration, it is unavailable. Agent
`sessionIds` are evaluated only against Agent providers and never against a
same-named Platform provider. Provider reports and results are immutable and
computed independently for each bound plugin declaration, so one plugin's
scope cannot change another plugin's projection.

## Authorization duration, persistence, and migration

Manifest-v4 uses the exhaustive 22-entry Host sensitivity catalog. Persisted
policy is `ask` / `allow-persistent` / `deny-persistent`; runtime decisions are
`allow-once` / `allow-persistent` / `deny-once` / `deny-persistent` subject to
the catalog. High-risk capabilities never expose persistent allow. Required is
orthogonal to sensitivity, and current availability is orthogonal to policy.
The dedicated Host review surface renders catalog facts and validated plugin
rationale as text nodes; plugin markup, links, security claims, and Host
impersonation are rejected before projection.

One `PermissionBroker` owns one profile ledger index and one policy engine.
Version-1 manifests enter that Broker through a compatibility adapter; they do
not create a second broker, registry, ledger, or policy store. The durable Home
configuration and authenticated `__cordisxPermissionPolicyRequestV1` bridge
carry v1, v2, v3, and v4 records in one array. Persistent identity is the exact
profile/source/plugin/capability/normalized-scope/security-fingerprint tuple.
Security fingerprint includes the catalog version plus the normalized
declaration security and rationale. Proven narrowing may carry a compatible
policy into one exact v2 record; expansion, unrelated scope change, source or
profile change, security/rationale change, and ambiguous candidates return to
`ask`.

Allow-once is held only by the Broker's in-memory exact-grant ledger. Runtime
requests bind operation id, runtime generation, module generation, and request
id. Install/enable decisions are additionally fenced by the exact candidate
id and are projected to the matching activation generation before first use.
No allow-once value is accepted by persistence. Disable, identity replacement,
candidate abort, rollback, generation disposal, and Broker disposal revoke the
matching grants.

Product launches pass only the selected profile id and that profile's
validated permission projection into the bundle. Writes cross an authenticated,
bounded CDP binding whose launcher handler can mutate only one bounded batch of
normalized permission records through the existing exclusive-lock/atomic Home
configuration writer. Required and optional decisions from one review therefore
commit together or not at all. The renderer and plugins receive neither the Home path nor an arbitrary
configuration document/writer. Development launches without that binding use
an explicitly profile-scoped browser fallback and do not claim launcher-durable
authorization.

The previous browser `cordisx.platform.permissionPolicies.v1` entry is a
read-only migration source, not an active second ledger. It is migrated only
when source/id/capability/fingerprint match the exact current normalized scope.
Home configuration permission-policy v1 records migrate to v2 only when a
manifest-v4 declaration has the same profile/source/id/capability/scope and the
catalog permits the corresponding persistent outcome. The old entry is retired
only after the atomic v2 write and readback are acknowledged.

The persistent configuration key excludes runtime generation. An allow-once
ticket is instead bound to profile, identity, capability, exact scope, and the
current generation; it is consumed once and cleared by plugin disable,
identity replacement, or generation disposal.

Permission v3 adds only `ui.extension-points.render`, scoped to one or more
formal extension-point ids. The Host catalog is the sole authority for its
`dom-rendering` and `certifiedImplicitApproval` metadata; the original 22
capabilities remain non-DOM and never receive implicit approval. A valid,
Host-private exact Certified projection for the current source, plugin id,
version, and artifact digest may let an `ask` DOM plan skip the visible dialog.
The same Broker still creates a profile- and scope-bound generation lease and
records its `certified-implicit` origin, projection fingerprint/revision, review
policy, evidence, and audit reason. Official state is not present in this API.

The current production Manager projection is not that Host-private authority.
Its source store and model live in the shared renderer main world where plugin
code also executes. Production therefore does not pass it to the Broker. This
keeps Certified implicit approval fail-closed until either Marketplace source
and trust state are Launcher-owned with monotonic revocation, or plugin code is
formally isolated from Host globals and storage. Isolated tests inject the exact
projection only to verify Broker, lease, audit, and revocation mechanics.

The extension-point descriptor registry and adapter probes remain availability
authorities only. Production route, page, surface, menu, and toolbar access use
the Permission Broker decision after descriptor validation. The former browser
extension-point/control policy stores are read-only migration inputs and cannot
authorize production rendering. Exact artifact or certification changes,
source-feed revocation, disable/unload, module/runtime generation replacement,
scope expansion, and expiry remove the implicit lease. User persistent deny
remains authoritative over certification.

Permission v4 adds `ui.host-dom.read` and `ui.host-dom.modify`; neither is an
alias for `ui.extension-points.render`. Scope contains only canonical Host root
ids and closed operation names. The Host returns opaque handles and serialized,
bounded projections. It never accepts or returns a selector, DOM path, raw
Node/Event/function, HTML, style/class, script, event handler, `document`,
`window`, private renderer handle, or raw bridge. Read operations are
`inspect-structure`, `read-text`, `read-attributes`, and `read-state`; modify
operations are `set-text`, `set-attribute`, `insert-owned-structured-child`,
`remove-owned-child`, and `focus`.

The same Host-private exact Certified projection may select
`certified-implicit` for these two catalog entries. The Broker still creates and
audits the lease. Persistent deny wins, and `ui.host-dom.modify` never permits
persistent allow. An eventual Marketplace authority must deliver invalidation
as a signal only; the consumer must reread its exact snapshot/lookup, then
remove or replace the projection. Expiry is independently timed inside the
Broker.

Authorization does not establish safe runtime availability. Production holds
each manifest-v5 Host DOM artifact as source data, executes it only inside the
opaque-origin Host DOM worker boundary, and injects the bounded client only
after that boundary is ready. The bundle and dynamic CDP lifecycle paths never
evaluate such an artifact in the renderer main realm. The worker receives no
`document`, `window`, raw node, selector, network API, nested worker, or Host
client object; its MessagePort RPC is serialized, bounded, generation-fenced,
and bound to a per-boundary random token. Native DOM and MessagePort primitives
are captured before any plugin module factory runs and reused by later dynamic
generations. Startup failure, dispose, disable, uninstall, or generation
replacement reports the capability unavailable and releases the client.

This is a narrow boundary for the manifest-v5 Host DOM surface, not a claim
that the complete CordisX renderer is a sandbox. Legacy structured plugins and
explicit `origin: local-dev` development entries retain the version-0.1 trusted
renderer model and never receive the bounded Host DOM client. Local development
file identities cannot satisfy a configured public Marketplace exact-artifact
Certified lookup. No production code may infer worker availability from
certification, Official state, a permission grant, or renderer ownership.

## Activation and manager behavior

At startup the broker registers every bundled manifest. A required declaration
with current policy `deny`, or with no capability provider that can satisfy its
declared scope, prevents that plugin fiber from mounting and yields
`permission-blocked` plus an explicit owning reason. A degraded route remains
mountable because at least one provider can satisfy it; calls outside the live
subset still fail through normal parameter/provider validation. `ask` is
unresolved authority, not automatic denial or grant; the host prompts at call
time. Optional denial or unavailability does not stop the fiber.

Installing, updating, or enabling a manifest-v4 plugin uses one normalized v2
authorization plan containing every required and optional declaration.
Low/general declarations are batch-eligible; sensitive/high-risk declarations
receive explicit per-capability review. The dedicated dialog shows Host facts,
plugin rationale, scope, sensitivity, availability, and only the catalog-allowed
decisions. A denied required declaration leaves the candidate inactive;
optional denial remains an explicit degradation.

Package-v3 is the only package boundary that may reference manifest-v4. The
launcher snapshots and digests the separate runtime manifest, stages it in the
existing immutable package store, and exposes the v2 plan over an authenticated
Host-private lifecycle envelope. Public lifecycle request/result v1 schemas are
unchanged. The reviewed v2 decision is then bound to the existing
`PackageLifecycleAuthority` receipt and generation transaction, reaches the
same renderer Broker before readiness, and is revoked on abort/rollback by that
authority. Enable/restore of an already active permission-blocked v4 plugin
uses the same Broker directly. No parallel installer authority is introduced.

Package-v4 is the only package boundary that may reference manifest-v5. Its v4
review contains the original 22 non-DOM declarations plus the two Host DOM
declarations in one plan. Items already satisfied by exact persistent policy,
or by an exact Certified eligibility returned from the optional Launcher-owned
lookup, are omitted from the explicit dialog. Production opens the formal
Launcher authority once per selected profile, and the coordinator rereads its
exact lookup at plan and apply so revocation between them fails closed. Lookup
failure requires explicit review; renderer lifecycle envelopes cannot submit a
projection, Official flag, or attestation payload. Every remaining item is
reviewed and the complete plan/decision stays bound to the same candidate id,
package digest, module/runtime generation, lifecycle receipt, rollback, and
Broker commit.

The decision returns the protocol envelope rather than a bare array. The Broker
checks its schema version, generation-bound `planId`, operation, profile,
source/plugin identity, and every exact normalized capability scope before one
atomic commit. A stale plan or a caller-supplied profile, identity, capability,
or scope is rejected. `decisionRequired` distinguishes a missing exact-key
record from an explicit persisted `ask`; only the former identifies new or
expanded authority.

The installed-plugin detail page adds a `权限` tab. Its model retains:

- plugin source and id;
- capability and required/optional status;
- retained `LocalizedText` and its current resolved projection;
- requested scope and current `ask`/`deny`/`allow` policy;
- last allowed use, last denial, denial count, and blocked reason.

The permission tab follows the shared hierarchy and de-duplication rules in
[`manager-content-design.md`](manager-content-design.md). Its first projection
is deliberately smaller than the retained model: a flat row shows a host-owned
localized capability name and icon, resolved reason, required badge, compact
availability state, and an always-editable localized policy selector.
Unavailable or degraded status never replaces or disables the selector;
support and policy remain orthogonal.

Selecting a row opens a third-level permission detail. That page owns the raw
capability id, non-empty declaration scope, required/optional state, structured
availability, provider routes and their scopes/reasons, policy selector, and
current-run audit. The list does not repeat raw provider diagnostics,
connection/bridge facts, blocked reason, or the security statement. The
current-connection diagnostic and provider-family diagnostics appear once
under the plugin `运行状态` tab's collapsed `诊断` disclosure.

Policy and provider changes reconcile the plugin fiber: changing a required
capability to `deny` or losing every satisfying route disposes it; restoring a
satisfying route and moving every denied required declaration to `ask` or
`allow` permits a fresh mount. Denying or losing an optional declaration never
stops the plugin. A new runtime generation rebuilds provider reports rather
than retaining availability from the previous generation. Locale changes
reproject declaration and availability reasons through the existing
LocalizationKernel subscription.

Runtime and activation prompts follow the same hierarchy rules. The review
body does not repeat its dialog title, required and optional capabilities are
flat rows rather than nested cards, and decision text appears once beside the
owning declaration. Light and dark themes retain visible focus, primary,
secondary, and destructive states.

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
false`, and `rawBridgeExposed: false`. Those facts describe only the Desktop
current-connection provider. They do not remove Host-local Agent ledger/history
or external Fleet routes from the availability registry.

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

The broker is meaningful policy enforcement for calls made through CordisX
Host APIs. It does not turn legacy trusted renderer plugins into confined code,
so the Manager must not label the complete runtime a sandbox. For
`ui.host-dom.read` and `ui.host-dom.modify`, however, the production composition
adds the required isolated worker plus bounded capability RPC before reporting
availability; the exact grant/lease remains owned by the same Broker.

## Dependencies and PR boundaries

1. `cordisx/cordisx#2` architecture and `cordisx/cordisx-protocol#2`
   LocalizedText/MessageRef are merged dependencies.
2. `cordisx/cordisx#3` LocalizationKernel is the real projection dependency;
   Platform does not create a second localization service.
3. Permission v2 uses the formal Protocol manifest-v4, package-v3, catalog,
   plan, decision, policy, schema vectors, and localized catalogs. The closed
   experimental public lifecycle-schema branch is not consumed. Agent Trace is
   a consumer only; Console, Luna Log, configuration, generation visibility,
   theme, menu, and toolbar ownership remain unchanged.
4. The host PR owns TypeScript contracts, profile-scoped Home configuration,
   bounded persistence RPC, Broker duration behavior, enable/restore batch UI,
   runtime prompt, capability provider aggregation, activation reconciliation,
   manager projection/UI, tests, and live smoke. It depends on merged Protocol
   `main` but does not import a checkout at runtime.
5. A future private current-connection adapter is a separate experimental PR
   blocked on a stable auditable host seat.
6. CordisXMono updates the two pushed gitlinks only after compatible validation.

The task does not initialize or modify `roadmap`, add a generic Dialog/theme
framework, or expand into a complete Marketplace implementation.

## Validation boundary

Automated coverage must include Desktop unavailable with Host-local Agent
events/history available; Desktop unavailable with an external Fleet route;
truly unsupported and degraded capabilities; explicit scope served by only a
subset of providers; policy editing while unavailable; identity/scope
separation between plugins; required block/restore and generation rebuild;
provider/model validation; allow/ask/deny;
required/optional activation; scope denial; identity non-spoofing; declaration
upgrade reset; two-phase create success and retained-task partial failure;
read-only projection and write refusal; unavailable diagnostics; manager data
and locale reprojection; always-editable policy controls, localized
availability reasons, third-level provider/scope navigation and recovery,
collapsed runtime
diagnostics, conformance with the shared manager content hierarchy plus the
Platform-specific fact placement above; generation cleanup; and
absence of a raw bridge or second app-server in the Platform surface.

Repository validation is `npm run check`, `npm audit --audit-level=high`, and
`git diff --check` in each owning repository. Live validation builds and
injects the real renderer bundle, opens the manager permission list and its
third-level detail, then confirms Agent Trace Agent ledger/history permissions
are not erased by Desktop unavailability, CLIProxy permissions follow Fleet
provider state and scope, truly current-connection-only capabilities remain
unavailable, and the current-connection diagnostic is confined to the
collapsed runtime diagnostic disclosure while the existing UI still
mounts/disposes. It cannot claim real native model/task writes until the
private current-connection adapter exists.

Authorization-specific validation additionally covers exact profile/source/id/
capability/scope separation; capability/scope upgrade re-prompt; fail-closed
legacy migration; runtime allow-once consumption with zero durable write;
persistent allow before dispatch; deny; required/optional batch behavior;
bounded RPC identity/scope rejection; atomic configuration readback; manager
`ask`/`allow`/`deny` editing; non-duplicated visible headings; keyboard/focus;
and both renderer color schemes. Agent event contracts and Agent Trace special
cases are an explicit negative diff boundary.
