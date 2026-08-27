# Dynamic plugin packages and generations

## Status and boundary

This document is the approved architecture for dynamic plugin installation,
activation, upgrade, disablement, reload, and removal. The delivery order is:

1. this architecture checkpoint;
2. the normative package, dependency, activation, operation, and snapshot
   schemas in `cordisx-protocol`;
3. the launcher-owned package store, dependency graph, activation journal, and
   stable renderer generation runtime;
4. the Host-owned manager actions and profile preferences;
5. local fixtures plus simulated and isolated real-`app://` smoke evidence;
6. exact merged protocol and Host pins in `cordisxmono`.

The merged runtime can snapshot one explicit local directory, build an
immutable package artifact, and drive a per-plugin generation through the
launcher/CDP/renderer lifecycle chain. Its current renderer staging still
mounts candidates into live registries after disposing the previous closure.
The generation-visibility checkpoint below closes that remaining atomicity
gap; package-v2 source adapters and durable transaction authority remain
launcher-owned follow-up work.

The current protocol accepts only a user-explicit source that is already
local: a directory, an explicit package/archive, or an already-downloaded
tarball. A configured marketplace remains discovery metadata and does not
become an installation authority. `downloadedFrom` is attribution only;
remote installation, publisher signing, transparency, malware isolation, and
an untrusted-code sandbox are later security stages. The local package still
executes as trusted renderer code after activation.

## Stable Host and minimum replacement scope

The launcher keeps one Host runtime alive for the current Codex renderer and
loads each package as an independently built, immutable plugin module
generation. A plugin module generation may use Host services but must not
bundle another Cordis runtime. The launcher rejects artifacts that would
introduce a second runtime identity.

The lifecycle planner selects the minimum safe scope for a requested change:

| Change | Apply scope | Observable effect |
| --- | --- | --- |
| a `live` configuration field | `config-live` | publish the committed value to watchers; do not call `apply()` again |
| a `restart` configuration field or explicit reload | `plugin-restart` | dispose and recreate only the owning plugin fiber from its current module generation |
| package code, entry, version, or declared dependency changes | `plugin-generation` | replace the target plus its transitive dependents, leaving unrelated fibers and Host services untouched |
| CordisX Host implementation or shared renderer ABI changes | `runtime-generation` | replace the complete CordisX renderer generation without restarting the Codex window |
| executable, Chromium profile, process environment, or startup arguments change | `app-restart` | explicitly require a new host process; never present it as plugin reload |

A package operation cannot silently escalate its own scope. A Host may return
a fresh plan that explicitly requires `runtime-generation` or `app-restart`,
but cannot apply it under a previously accepted one-plugin plan. In particular,
the manager does not edit the launcher file and restart the complete launcher
while claiming a plugin hot reload. A runtime ABI mismatch fails staging and
reports that a compatible CordisX runtime is required; it does not silently
apply an app restart.

## Package source and immutable store

An `inspect-source` request contains one validated
`plugin-package-source.v1`: `local-directory`, `local-package`, or
`downloaded-tarball`. Every source location is a canonical local `file:` URL.
The renderer cannot read it, choose an entry outside it, submit JavaScript
text, or receive a staged filesystem path. `downloadedFrom` is a canonical
public HTTPS attribution and grants no install, package, signature, or
permission authority.

The launcher snapshots a directory or verifies the exact package/tarball bytes
before parsing. It rejects path traversal, normalized-path collisions,
escaping links, special files, concurrent directory changes, and bounded
size/count/depth violations. A supplied expected SHA-256 digest is checked
before manifest inspection or code execution.

The frozen `plugin-package.v1` embedded-runtime-manifest shape remains readable
only for compatibility. New candidates use `plugin-package.v2`, which declares:

- stable plugin id and semantic package version;
- a package-relative browser entry and optional adjacent README;
- exact runtime ABI and required protocol schema ids;
- explicit plugin dependencies by id and accepted package version;
- a separate package-relative runtime-manifest path, exact v1/v2/v3 schema id,
  and SHA-256 digest; and
- an optional canonical public HTTPS source URL used only for sharing.

The referenced runtime manifest remains the authority for capabilities,
scopes, reasons, and services, and its id must equal the package id. Package
inspection must not copy, widen, drop, or reinterpret those declarations.
Manifest-v3 launcher service configuration remains separate from renderer
`Config`: credentials, transport, queues, data directories, and process
lifetime state cannot travel through a renderer plugin value. Its Node Channel
service configuration kind remains exactly `host` or `none`: `host` keeps
connection, transport, mapping, and limits Host-only, while `none` creates no
empty configuration document. Launcher `secretRef` accepts only `keychain:` or
`host-secret:` references; the renderer descriptor exposes redacted
`secretState` and never the reference. Ordinary renderer plugins continue to
use Schemastery `Config` on the separate renderer plane.

The source tree is validated and bundled before it enters the store. The
launcher computes a SHA-256 digest over the normalized manifest and built
browser artifact, then publishes it at a content-addressed location under the
CordisX home. Store directories are immutable after publication. Local source
paths are retained only in launcher-private operation audit; manager snapshots
receive the digest and an optional public canonical source, never the source
directory.

The package distribution state is exactly `explicit-local-v1` with
`signature: unsupported`. Integrity means reproducible local content hashing
and readback, not publisher authenticity. The manager must call it `integrity`,
not `signature` or `verified publisher`.

## Dependency graph

There is at most one active package version for a plugin id in a profile. The
candidate graph must have unique ids, installed dependencies with compatible
versions, and no cycles. A required capability denied by the permission plan
also makes the candidate graph not ready.

For a code change to plugin `P`, the replacement closure is `P` plus every
active plugin that directly or transitively depends on `P`. Existing fibers in
that closure dispose in reverse topological order; candidates start in
topological order. A plugin restart has no dependency closure because its
module identity and provided service declarations do not change.

Disabling or uninstalling a plugin with active dependents is destructive to
the same reverse-dependency closure. The manager confirmation names every
affected plugin. The operation may proceed only through the lifecycle broker;
deleting package files first is forbidden.

## Activation transaction

Every mutation is profile-scoped and serialized by an activation revision.
The renderer submits the expected revision and current renderer/runtime
generation. Public results retain product-safe package summaries and affected
plugin ids. The opaque `candidateId` and `impactToken` resolve inside the Host
to one immutable plan containing the complete affected closure and every
member's exact expected/current/after tuple: plugin id, version, SHA-256 digest,
module generation, enabled state, dependency bindings, activation revision,
and runtime generation. The launcher compares the complete plan—not only the
requested plugin—against the current active record and rejects any stale tuple
before invoking plugin code. The transaction has these durable phases:

1. `requested`: validate the operation shape, source boundary, and current
   activation revision;
2. `validated`: parse the package manifest, compatibility, dependency graph,
   integrity inputs, and permission authorization plan;
3. `staged`: publish the immutable package artifact and a candidate activation
   record without changing the active record;
4. `loading`: evaluate the candidate closure against transaction-owned staged
   registries and staged dependency bindings, never the live registries;
5. `ready`: all required permissions are granted and Host-observed entry,
   fiber, service, registry, and dependency checks have completed;
6. `committed`: atomically publish the complete staged registry/dependency
   closure together with its package identities and runtime/module generations,
   replace the profile activation record once, and increment its revision;
7. `rolled-back` or `failed`: restore the complete last-good module/fiber
   closure and keep the prior activation record.

Candidate and last-good records contain profile id, activation revision,
runtime generation, per-plugin module generation, package digest, dependency
edges, and enabled state. Publication uses write-to-new-file, file sync,
atomic rename, restrictive permissions, and readback. A launcher interruption
may leave a candidate journal or an unreferenced immutable artifact, but not a
partially rewritten active record. On startup the launcher marks incomplete
candidates aborted, loads the last committed activation, and schedules
unreferenced artifacts for delayed garbage collection.

Commands, pages, routes, surfaces, outlets, services, configuration
renderers/watchers, Agent, Channel, Platform, and every other candidate effect
remain transaction-owned and invisible to live consumers through readiness.
The old last-good closure is the only live projection until the single atomic
publication. Consumers must never observe a new command with an old page, a new
service with old dependency bindings, or a new module generation with the old
package digest.

After publication, the launcher commits that exact tuple as last-good before
disposing retired fibers. A candidate crash between publication and the
last-good commit fences the candidate and restores the complete previous
last-good closure. Failure before publication discards every staged effect and
leaves live registries, activation revision, and last-good unchanged.

The stable runtime exposes a launcher-authenticated candidate seat, not a
public plugin API. It fences every handle, service call, contribution, route,
page, command, subscription, and configuration watcher by owner and module
generation. Calls from a disposed generation fail as stale. Snapshot
publication and the active activation record change only after readiness.

Module top-level code executes inside the current trusted renderer model and
cannot be rolled back. Package guidance therefore requires top-level code to
be declarative and side-effect free; effects begin in `apply()` and belong to
the owning Cordis fiber. This requirement is lifecycle hygiene, not a sandbox.

## Host-private generation visibility transaction

The renderer has one `GenerationVisibilityCoordinator` per stable Host runtime.
It is the only authority for the active module generation of every plugin and
for the single in-flight activation epoch. It stores activation identity and
visibility metadata only. Commands, pages, routes, surfaces, localization,
configuration, Agent, Platform, and extension-point records remain stored in
their existing registries; no shadow registry, copied contribution store, or
public generation API is introduced.

The Host writes an unforgeable candidate seat into the plugin's child Cordis
`Context`. A plugin cannot submit or override its plugin id, module generation,
transaction id, or epoch. Every registry derives those fields from the Context
and records an internal owner key of `(pluginId, moduleGeneration, logicalId)`.
The existing public owner and qualified-id projections remain unchanged.
`CORDISX_PLUGIN_GENERATION` is therefore an enforced registry identity, not
diagnostic metadata.

The coordinator API is Host-private and has these responsibilities:

- `bindActive(record)` installs the full authoritative activation tuple for a
  newly started runtime;
- `begin(expected, after)` revalidates profile revision, runtime generation,
  package id/version/digest, module generation, enabled state, and exact
  dependency bindings, then recomputes the affected reverse closure from both
  graphs and issues the candidate seat;
- `view(context)` returns the authenticated active or candidate generation
  view used by registration, lookup, dependency resolution, and callbacks;
- `preparePublish(seat, readinessReceipt)` asks every participating registry to
  validate the complete closure without changing the active pointer;
- `publish(barrier)` synchronously replaces the complete active-generation map
  and increments one visibility version before any observer runs;
- `rollback(barrier)` synchronously restores the previous complete map;
- `abort(seat)` rejects and drains hidden candidate effects without notifying
  live observers; and
- `completeLastGood(seat)` releases the rollback lease only after retired
  fibers and effects have been drained and disposed.

Registries consume the coordinator through the same exact private hooks:

- `register(context, logicalId, record)` derives an authenticated
  `{ owner, moduleGeneration, logicalId }` physical key and marks the owning
  transaction dirty without publishing it;
- `read(context?)` selects the candidate transaction view for a candidate
  fiber and the active view for ordinary Host/Manager consumers;
- `assertCallable(record, context?)` fences stale callbacks and handles before
  execution;
- `prepare(transition)` verifies duplicates, references, mounts, policies, and
  configuration projections entirely against `candidate + unaffected-active`;
- `notify(visibilityVersion)` reconciles that already-published version once;
  unregistering a hidden candidate or retiring record does not notify; and
- `disposeGeneration(owner, moduleGeneration)` removes only the exact physical
  generation, so an old disposer cannot remove its replacement.

Candidate code resolves services and dependencies through its candidate view,
so members of one staged closure can see each other. Ordinary consumers keep
the active view and cannot see candidate records. Registration and candidate
cleanup do not notify live subscribers. On publish or rollback, the coordinator
first performs the one non-throwing map flip, then delivers at most one
versioned notification to each participating registry. A synchronous listener
may read any other registry and will see the same new version. Listener errors
are isolated and asynchronous listeners are not awaited inside the barrier.
All potentially failing participant checks happen in `preparePublish`; a
prepare failure leaves the active map and every live projection unchanged.
Before a Host-side generation probe establishes its baseline, the private
runtime may await `settleRegistryProjection()`. This is a bounded microtask
fixed-point barrier for already-completed live localization/diagnostic
projection; it neither advances the registry epoch nor delays candidate stage,
and it fails if the projection cannot settle.

After publish, the old records are hidden-retiring but remain mounted under a
rollback lease. A successful launcher commit-last-good drains and disposes
them in reverse dependency order. A durable commit failure flips visibility
back to the old closure, disposes the candidate closure, and returns the
Host-observed `active` and `disposedAfter` tuples. Cleanup state remains until
all disposers succeed, so a failed cleanup retries without repeating the
visibility flip. Calls and handles capture their generation view; once that
view is no longer active, invocation fails closed as stale even while its
retiring record still exists.

Process recovery resolves the Host-private `rollback-pending` plan before
building a replacement renderer. The replacement is composed from the
authority-selected last-good closure at `rollbackRegistryEpoch`; its new Host
runtime generation is not substituted into the old transaction receipt. Once
the isolated `app://` runtime is ready, it verifies that the live package,
module-generation, enabled-state, and dependency closure matches the rollback
target and that no published candidate generation survived. The launcher then
issues the branded rollback receipt with the plan's original transaction tuple,
completes durable rollback, and adopts only the returned canonical active
revision. Repeated recovery uses the authority's fresh rollback token and never
reads or reconstructs journal fields in renderer code.

### Owning files and registry adaptation

| Owning file | Generation transaction change |
| --- | --- |
| `renderer/generation-visibility.ts` | coordinator, authenticated seat/view, closure/fence validation, prepare/publish/rollback barrier, versioned notification |
| `renderer/ownership.ts` | Host-only Context identity accessors; no public plugin input |
| `renderer/commands.ts` | generation-qualified records, view-filtered lookup/snapshot, callback fence |
| `renderer/navigation.ts` | generation-qualified page/route records; candidate-local reference validation; active-version stack/settings mount reconciliation |
| `renderer/surfaces.ts` | generation-qualified contributions; active projection; rendered state bound to an unrepeatable registration token |
| `renderer/configuration.ts` | generation-fenced config renderers/watchers while retaining one profile/plugin value and revision plane; active form remount on flip |
| `renderer/i18n.ts` | generation-qualified catalogs/injections; candidate-local winner; one active locale projection version |
| `renderer/agent.ts` | generation-fenced prompts, subscriptions, pending deliveries, and owner drain |
| `renderer/platform.ts` | generation-fenced service tickets/calls without changing permission policy identity |
| `renderer/extension-points.ts` | keep the descriptor catalog Host-owned; make plugin identity/policy decisions and usage generation-aware without changing public access shapes |
| `renderer/runtime.ts` | candidate/active/retiring fibers, closure readiness receipt, publish and cleanup orchestration |
| `launcher/cdp.ts` | all-renderer readiness, publish, rollback, and retryable cleanup observation handshake |

Configuration values remain keyed by profile and plugin id and are not copied
per generation. The generation seam applies to fiber-owned watchers and
renderer registrations only. Permission decisions likewise remain owned by
the Permission Broker; generation fencing limits the lifetime of candidate and
one-shot authority without creating another policy store.

The publish reconcile order is dependency bindings and callable services,
commands and localization, pages/routes/outlets, surfaces/settings, then the
single Manager/runtime snapshot. Existing open routes and settings content are
remounted only after the new page and contribution records are active. A
reconcile preparation failure occurs before the active-map flip. Reconciliation
after the flip is non-throwing and uses retained previous mount state for an
atomic rollback. `knownRegistrations` is generation-qualified and cannot
project or resurrect a retiring generation.

Implementation priority is:

| Priority | Required closure |
| --- | --- |
| P0 | configuration owner-only overwrite, i18n candidate winner, route/page mount identity, surface rendered-token isolation, permission/extension-point identity when package source changes |
| P1 | shared notification batching and Manager snapshot consistency, generation-qualified inactive diagnostics, active config-renderer remount without watcher churn |

### Generation transaction test matrix

| Evidence | Required assertion |
| --- | --- |
| coordinator unit tests | full tuple and dependency fence, Host-recomputed closure, forged/stale seat rejection |
| two-registry consistency fixture | candidate self-view, ordinary live zero-visibility, same-plugin coexistence, one-version atomic publish, one bounded notification per registry |
| registry-focused tests | generation-qualified duplicate ids, active projection de-duplication, stale lookup/callback/handle rejection, hidden abort without notification |
| publish fault tests | registry prepare failure produces zero map/projection change; listener failure cannot split the epoch |
| command tests | active-only execute/has/snapshot, old disposer isolation, old in-flight abort after flip |
| navigation tests | same-path coexistence, candidate-local page resolution, active mount/stack preservation on abort, settings tab/content generation agreement |
| surface/adapter tests | no staged duplicate projection, one flip rebuild, rendered-token isolation, no native flicker |
| configuration tests | candidate settings self-view, Manager active view, schema/renderer flip, abort with zero watcher churn |
| localization tests | candidate-local catalog winner, active zero visibility, one locale version/notification, abort without diagnostic churn |
| extension-point tests | old/new source coexistence, active decision/usage until flip, rollback without authority leakage |
| runtime integration | staged snapshot/execute/navigate/DOM remain old, old fiber remains mounted, dependency-ordered closure readiness, one publish, rollback flip, commit-last-good retiring disposal, retryable cleanup observation |
| bundle snapshot tests | every Manager snapshot is entirely old or new and the runtime subscription publishes exactly once |
| lifecycle regressions | block/restore, permission blocking, config live/restart, unload cleanup of services/pages/routes/commands/surfaces/subscriptions/pending deliveries |
| isolated real `app://` smoke | candidate readiness and publish/rollback in one Codex window while unrelated fibers, native Codex DOM identity, page state, and data stream remain continuous |
| isolated process/recovery smoke | fresh profile and CDP port; pre-publish abort, post-publish rollback, process restart from rollback-pending, native Console `method + args[]`, zero pending permission/lifecycle dialogs, zero Crashpad dump delta, closed port, and no process retaining the profile |

The `smoke:isolated-app` runner owns a separate process group, starts the
isolated window minimized, waits for the actual CordisX runtime rather than
only a CDP page, and always terminates the smoke, launcher, Electron, and child
processes in `finally`. It fails the run if the loopback port remains reachable,
the exact profile has a live Electron process, a Crashpad dump appears, or the
live report contains an unhandled permission/lifecycle dialog. Visible windows
are never retained unless a user explicitly runs a non-cleaning visual review.

## Install and upgrade

The launcher-owned install chain is:

```text
explicit local directory / package / downloaded tarball
  -> package/manifest/schema/compatibility validation
  -> integrity digest and dependency candidate
  -> permission authorization plan
  -> immutable artifact staging
  -> module generation build/load
  -> dependency-ordered readiness
  -> atomic activation publication
```

Required capabilities must be granted before activation. Optional
capabilities may be `deny`, `allow-once`, or persistently `allow`; the latest
Permission Broker owns that decision and audit. Denying an optional capability
does not fail readiness. Denying a required capability leaves the artifact
staged but inactive and leaves last-good active state unchanged.

The permission plan is built from the complete separate runtime manifest.
Manifest-v4 produces a permission-v2 plan from the Host's exhaustive catalog;
batch-eligible low/general declarations and explicit sensitive/high-risk
declarations remain in one atomic review. Persistent allow/deny uses the exact
profile/source/plugin/capability/scope/security-fingerprint key in the same
Home ledger as runtime authorization. `allow-once` is non-durable, bound by the
Host-private plan to candidate id plus package/module/runtime generation, and
cleared by abort, disable, replacement, or generation disposal. A declaration
that the current plan/Broker cannot express or enforce blocks activation rather
than being dropped; optional declarations degrade only without fallback
authority.

Public lifecycle v1 schemas stay frozen. The authenticated renderer binding
has a Host-private review-plan/apply envelope for v2; its plan and decision are
revalidated by the launcher and then attached to the existing
`PackageLifecycleAuthority` permission receipt. The authority and Generation
Runtime carry that same decision into the single renderer `PermissionBroker`
before readiness. This is not a second lifecycle protocol, package registry,
policy engine, or permission store.

Upgrade is the same transaction with an existing active id. A failed build,
manifest check, dependency check, permission decision, candidate startup, or
activation readback leaves the old digest and generation active. An update
never mutates the old immutable package.

## Disable, reload, enable, and uninstall

Disable first fences the target closure against new calls, drains bounded
in-flight work, aborts at the Host deadline, then disposes its fibers and
publishes the disabled activation state. Enable builds a permission plan,
loads the existing active digest, performs readiness, and publishes the new
enabled state. Explicit reload keeps the digest and module generation and only
recreates the target fiber.

Uninstall uses this order:

1. compute and present the reverse-dependency impact;
2. fence the affected generations and reject new invocations;
3. drain bounded in-flight work, then dispose owning fibers, services, pages,
   routes, commands, surfaces,
   renderer seats, subscriptions, configuration watchers, and permission
   one-shot grants in reverse dependency order;
4. wait for registry and route cleanup and reject stale handles;
5. atomically remove the affected activation records;
6. retain package artifacts until no active, candidate, last-good, rollback,
   dependent, operation, or bounded diagnostic/in-flight lease references
   them, then remove them through delayed garbage collection.

Any failure before activation publication discards staged effects and keeps
the old live/last-good closure unchanged. A failure to restore last-good after
a publication is reported as a distinct `rollback-failed` state and never
reported as successful uninstall. Logical uninstall may succeed while physical
collection remains deferred; cleanup failure is retryable and never reactivates
the package.

## Existing configuration compatibility

Dynamic activation wraps the merged plugin configuration contract; it does not
replace or flatten it. Agent Trace remains the concrete regression fixture:
its exported Schemastery `Config` keeps `configApplies = plugin-restart`, the
`mode` choices `live`/`historical`/`fixture`, `historyPageSize` default 100 with
25–500 step 25, and `timelineWindowSize` default 500 with 50–500 step 50. The
existing package README plus English and Simplified Chinese labels/descriptions
remain package-owned product metadata across install, update, disable, enable,
and rollback.

Those renderer settings must not gain session/provider/profile identity,
local/store paths, permission policy, payload-redaction policy, credentials,
secret references, transport, or process-lifetime state. These remain
Host/launcher-owned and are never synthesized into the Config value, Manager
form, lifecycle result, or last-good package metadata.

## Manager contract

### Host-private local development generations

Direct `cordisx dev <entry>` generations reuse the renderer transaction and
readiness boundary but do not enter the durable package authority. The
launcher builds an immutable candidate from the transitive esbuild graph,
stages it beside the live fiber, publishes only after readiness, and disposes
the old fiber only in the normal completion phase. It must not reinject or
dispose the whole CordisX runtime while calling that operation a plugin reload.
New renderer targets receive the latest successful immutable bootstrap; an
already installed renderer changes only through the transaction.
This phase is renderer-only. Runtime manifest `services` and formal package
`dependencies` are rejected as unavailable before publication; local-dev does
not pretend that a renderer fiber also started Node services or resolved a
package dependency graph. Those declarations require the formal package
authority.

The local entry's absolute path and build status are Host-private Manager
diagnostics. They are not `plugin-package-source`, canonical source,
activation-journal, permission identity, public lifecycle result, or share
metadata. They are also removed from the plugin-facing/global renderer runtime
`snapshot()`; React Manager receives them through a separate Host-private model.
Before a first successful generation, Manager may show a
launcher-owned source diagnostic but must not synthesize an active plugin row.
After success it associates the diagnostic with the actual active plugin.
Build/readiness failure retains last-good and exposes the most recent bounded
error; repair creates a new fenced attempt. If a stale renderer makes rollback
temporarily unavailable, one controller-owned backoff timer retries that same
transaction and restores its bootstrap before rebuilding the latest source; it
does not require another file write after target pruning. Watcher shutdown
removes poll, debounce, and rollback-retry timers and waits for the single
in-flight attempt before the CDP runtime is disposed.

A renderer joins the Host generation participant set only after its bootstrap,
recovery projection, and local diagnostic synchronization finish. Immediately
after boot readiness it first holds an atomic join reservation: the reserved
session participates in durable cold-start rollback while new prepare/register
operations remain fenced. Successful recovery and synchronization commit the
reservation into a normal session; failure aborts it and target injection
retries. A concurrent generation fence rejects a target that loses the initial
reservation race. Terminal renderer rollback receipts are bounded and
idempotent; a partial multi-renderer rollback or finalize can therefore retry
the same Host transaction without admitting an overlapping generation. Both
published and unpublished Host-authorized rollback use the canonical monotonic
rollback epoch.

The installed-plugin page is a searchable list with states for installing,
updating, enabling, disabling, reloading, uninstalling, blocked, permission
blocked, failed, rollback, and active. Normal rows show product state, not raw
digests, revisions, local paths, or generation ids; those belong in the
existing collapsed runtime diagnostics or an operation failure.

The complete row body is one button-like navigation target. Pointer click,
Enter, and Space open plugin detail. It has no right chevron. A separate
Host-rendered action region contains icon-only controls with native tooltip,
hover, focus-visible, disabled, no-drag, and Material Symbol treatment. Action
activation stops row navigation.

The deterministic wide-row priority is enable/disable, reload, then favorite.
Controls that do not fit move to the overflow menu in the same order without
shrinking the title or status. Share and uninstall are always in the overflow
menu. Menu focus returns to its trigger on close and the menu/tooltip remains
inside the manager viewport.

Favorite is a profile-scoped manager preference and never changes a package or
activation record. Share exists only when the package has a public canonical
HTTPS source; it copies that URL and never a local path, package-store path,
configuration value, or credential. Uninstall requires a second Host-owned
confirmation with its dependency-impact summary. Actions that the active
lifecycle broker cannot perform are absent or honestly unavailable, not visual
placeholders that restart the launcher.

Plugins contribute no row DOM, button, tooltip, menu, confirmation, icon
token, or operation callback. They provide only validated manifest and runtime
state data.

## Validation matrix

Contract and runtime tests must prove:

- live configuration changes publish without a new `apply()`;
- explicit reload recreates one owning fiber inside a shared bundle;
- one plugin code upgrade changes only its generation and dependent closure;
- unrelated plugin fibers, state, contributions, and service handles survive;
- graph order, missing dependency, incompatible version, and cycle handling;
- directory/package/downloaded-tarball capture, digest mismatch, archive path
  escape/collision limits, and rejection of remote/Marketplace/signature trust;
- package-v2 and runtime-manifest v1/v2/v3 separation, exact schema/digest
  binding, and launcher service configuration remaining outside renderer
  `Config`;
- install validation, build failure, readiness failure, permission denial, and
  activation readback failure preserve last-good;
- candidate commands/pages/routes/surfaces/services and other effects remain
  absent from live registries until readiness and publish as one complete
  affected closure;
- candidate/impact tokens fence every expected/current/after package digest,
  module generation, dependency binding, activation revision, and runtime
  generation while public results remain product-safe;
- interruption recovery ignores incomplete candidates;
- stale runtime/module generation requests and stale handles are rejected;
- uninstall fences new calls and cleans services, pages, routes, commands,
  surfaces, subscriptions, renderer seats, and one-shot grants;
- package artifacts referenced by active or last-good records are not garbage
  collected;
- Agent Trace keeps restart-applied Schemastery `mode`, `historyPageSize`, and
  `timelineWindowSize`, README and bilingual copy, while identity/path/
  permission/redaction/secret fields remain Host-owned;
- row pointer and keyboard navigation do not fire from action buttons;
- responsive overflow ordering, menu focus return, bounded tooltip/menu,
  destructive confirmation, favorite persistence, and safe share projection;
- empty/search-filtered and blocked/failed/installing/updating list states; and
- a real isolated `app://` renderer installs a local fixture, enables,
  reloads, upgrades, disables, and uninstalls it without restarting the Codex
  window while screenshots capture the normal row, overflow menu, permission
  decision, and destructive confirmation.

Every owning repository runs its complete check/build, package audit, and
`git diff --check`. Exact mono gitlinks update only after all compatible owning
PRs merge.
