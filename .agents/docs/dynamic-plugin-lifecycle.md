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

The current merged runtime has only two related mechanisms: configuration may
publish live or recreate the owning plugin fiber, and the manager can
block/restore a module already present in the one renderer bundle. It does not
currently install, update, remove, or independently replace plugin code. The
implementation slices following this document must preserve that distinction
until their contracts and tests land.

Version 1 dynamically installs only an explicit local package directory. A
configured marketplace remains discovery metadata and does not become an
installation authority. Remote download, publisher signing, transparency,
malware isolation, and an untrusted-code sandbox are later security stages.
The local package still executes as trusted renderer code after activation.

## Stable Host and minimum replacement scope

The launcher keeps one Host runtime alive for the current Codex renderer and
loads each package as an independently built, immutable plugin module
generation. A plugin module generation may use Host services but must not
bundle another Cordis runtime. The launcher rejects artifacts that would
introduce a second runtime identity.

The owner of a requested change selects exactly one scope:

| Change | Apply scope | Observable effect |
| --- | --- | --- |
| a `live` configuration field | `config-live` | publish the committed value to watchers; do not call `apply()` again |
| a `restart` configuration field or explicit reload | `plugin-restart` | dispose and recreate only the owning plugin fiber from its current module generation |
| package code, entry, version, or declared dependency changes | `plugin-generation` | replace the target plus its transitive dependents, leaving unrelated fibers and Host services untouched |
| CordisX Host implementation or shared renderer ABI changes | `runtime-generation` | replace the complete CordisX renderer generation without restarting the Codex window |
| executable, Chromium profile, process environment, or startup arguments change | `app-restart` | explicitly require a new host process; never present it as plugin reload |

A package operation cannot escalate its own scope. In particular, the manager
does not edit the launcher file and restart the complete launcher for a plugin
upgrade. A runtime ABI mismatch fails staging and reports that a compatible
CordisX runtime is required; it does not silently apply an app restart.

## Package source and immutable store

An install request contains a user-selected absolute local directory only as
input to the launcher broker. The renderer cannot read that directory, choose
an entry outside it, submit JavaScript text, or receive a staged filesystem
path. The launcher resolves the real directory, rejects symlinks and special
files that escape the package boundary, and reads a single
`cordisx.plugin.json` package manifest.

The package manifest declares:

- stable plugin id and semantic package version;
- a package-relative browser entry and optional adjacent README;
- exact runtime ABI and protocol compatibility versions;
- explicit plugin dependencies by id and accepted package version;
- the runtime manifest used for capability authorization; and
- an optional canonical public HTTPS source URL used only for sharing.

The source tree is validated and bundled before it enters the store. The
launcher computes a SHA-256 digest over the normalized manifest and built
browser artifact, then publishes it at a content-addressed location under the
CordisX home. Store directories are immutable after publication. Local source
paths are retained only in launcher-private operation audit; manager snapshots
receive the digest and an optional public canonical source, never the source
directory.

Version 1 integrity means reproducible local content hashing and readback, not
publisher authenticity. The manager must call it `integrity`, not `signature`
or `verified publisher`.

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
generation. The launcher rejects a stale revision or generation before doing
work. The transaction has these durable phases:

1. `requested`: validate the operation shape, source boundary, and current
   activation revision;
2. `validated`: parse the package manifest, compatibility, dependency graph,
   integrity inputs, and permission authorization plan;
3. `staged`: publish the immutable package artifact and a candidate activation
   record without changing the active record;
4. `loading`: evaluate the candidate module in the stable Host and build the
   affected plugin-generation closure;
5. `ready`: all required permissions are granted and every candidate fiber has
   completed startup;
6. `committed`: atomically replace the profile activation record and increment
   its revision;
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

The stable runtime exposes a launcher-authenticated candidate seat, not a
public plugin API. It fences every handle, service call, contribution, route,
page, command, subscription, and configuration watcher by owner and module
generation. Calls from a disposed generation fail as stale. Snapshot
publication and the active activation record change only after readiness.

Module top-level code executes inside the current trusted renderer model and
cannot be rolled back. Package guidance therefore requires top-level code to
be declarative and side-effect free; effects begin in `apply()` and belong to
the owning Cordis fiber. This requirement is lifecycle hygiene, not a sandbox.

## Install and upgrade

The launcher-owned install chain is:

```text
explicit local directory
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

Upgrade is the same transaction with an existing active id. A failed build,
manifest check, dependency check, permission decision, candidate startup, or
activation readback leaves the old digest and generation active. An update
never mutates the old immutable package.

## Disable, reload, enable, and uninstall

Disable first fences the target closure against new calls, then disposes its
fibers and publishes the disabled activation state. Enable builds a permission
plan, loads the existing active digest, performs readiness, and publishes the
new enabled state. Explicit reload keeps the digest and module generation and
only recreates the target fiber.

Uninstall uses this order:

1. compute and present the reverse-dependency impact;
2. fence the affected generations and reject new invocations;
3. dispose owning fibers, services, pages, routes, commands, surfaces,
   renderer seats, subscriptions, configuration watchers, and permission
   one-shot grants in reverse dependency order;
4. wait for registry and route cleanup and reject stale handles;
5. atomically remove the affected activation records;
6. retain package artifacts until no active or last-good record references
   them, then remove them through delayed garbage collection.

Any failure before activation publication remounts last-good and keeps the
old active record. A failure to restore last-good is reported as a distinct
`rollback-failed` state and never reported as successful uninstall.

## Manager contract

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
- install validation, build failure, readiness failure, permission denial, and
  activation readback failure preserve last-good;
- interruption recovery ignores incomplete candidates;
- stale runtime/module generation requests and stale handles are rejected;
- uninstall fences new calls and cleans services, pages, routes, commands,
  surfaces, subscriptions, renderer seats, and one-shot grants;
- package artifacts referenced by active or last-good records are not garbage
  collected;
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
