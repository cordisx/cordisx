# Dynamic plugin package store and installation transactions

## Status and scope

This document defines the launcher-owned implementation boundary for dynamic
plugin packages. The normative, implementation-independent package and
lifecycle contract belongs to `cordisx-protocol` and must be merged before this
module is released. Until that dependency lands, names in this document are
internal Host vocabulary and are not a competing public protocol.

Version 1 accepts only an explicitly selected local directory, explicit local
package, or already downloaded local tar archive. It does not fetch a remote
URL, establish Marketplace trust, verify a publisher signature, or isolate
plugin execution. Installed plugins remain trusted local code. The package
store must not be described as a sandbox.

The implementation lives in new Node/Launcher-only modules. It does not render
Manager DOM and does not perform renderer-generation replacement. The
Generation Runtime receives a narrow immutable candidate and reports a fenced
activation/readiness outcome.

## Ownership and filesystem boundary

The launcher owns a private package root below the selected CordisX Home:

```text
packages/
  state.v1.json
  objects/sha256/<digest>/
  staging/<transaction-id>/
```

Ordinary renderer plugins receive none of those paths. They cannot choose an
object path, read an arbitrary file, edit the Home configuration, publish a
package record, or load a package directly. Runtime composition consumes only
the launcher-produced package projection.

Every accepted source is first copied or extracted into staging. An object
directory is immutable only after validation and publication. The launcher
rejects symbolic links, hard links, devices, sockets, archive path traversal,
and any entry that resolves outside the staged root. A deterministic tree hash
covers the relative path, entry kind, executable bit, byte length, and file
bytes. The final object directory is addressed by that SHA-256 digest and is
made read-only after an atomic same-filesystem rename.

Canonical source identity and package identity are different facts:

- source identity is the canonical real `file:` URL plus the explicit source
  kind (`local-directory`, `local-package`, or `downloaded-tarball`);
- package identity is exactly plugin id, semantic version, and SHA-256 content
  integrity;
- a package manifest is static intake metadata and remains separate from the
  renderer/Node runtime plugin manifest;
- two paths with identical bytes may resolve to one immutable object while
  retaining distinct source observations;
- moving or editing a local source never mutates an installed object.

## Durable state model

`state.v1.json` is a strictly validated, atomically replaced journal snapshot.
Every writer holds an exclusive package-store lock and supplies the expected
store revision. The root retains:

- immutable package records and their canonical source observations;
- per-profile active and last-good selections;
- at most one candidate transaction per profile;
- terminal and non-terminal transaction journal records; and
- rollback leases and deferred-GC eligibility, never eager uninstall deletion.

The active selection remains the published runtime truth until a candidate is
ready and confirmed by the Generation Runtime. Staging never overwrites active
or last-good. A successful commit atomically publishes the candidate as active,
moves the previous active selection to last-good, advances the store revision,
and makes now-unreferenced objects eligible for later GC.

## Dependency graph

The launcher resolves one explicit graph from immutable package descriptors.
Each required edge names a plugin id and semantic-version range. Resolution
fails closed for a missing dependency, incompatible version, duplicate plugin
identity, self-edge, or cycle. A candidate update computes the reverse
dependent closure so the Generation Runtime receives every affected plugin in
dependency-first activation and reverse dependency order for drain/dispose.

Uninstall is refused while another selected plugin depends on the target.
There is no implicit cascade. Disable uses the same affected-closure check and
cannot leave an enabled dependent with a missing provider. Reference counts
include active, last-good, candidate, non-terminal journal, and rollback-lease
records. Physical object deletion is a separate launcher GC transaction after
a grace period and a fresh zero-reference read.

## Transaction, reload, and generation seam

The Host exposes an internal typed service with this fixed order:

1. `plan` canonicalizes and snapshots local sources, verifies integrity and the
   separate static package manifest, resolves compatibility and dependencies,
   computes the affected closure and persists a candidate.
2. `permission review` uses the existing Permission Broker plan/decision
   contract. A denied or unresolved required declaration prevents activation.
   Optional decisions keep the existing ask, deny, allow-once, and persistent
   allow semantics.
3. `activationCandidate` returns an immutable projection containing package
   identities, launcher-resolved entry points, dependency order, reverse drain
   order, expected runtime generation, per-plugin generations, and an opaque
   transaction id. It returns no store root or arbitrary filesystem handle.
4. The separate Generation Runtime activates that projection and reports
   readiness. The package store does not implement renderer switching.
5. `commit` accepts only the exact transaction id, store revision, runtime
   generation, each affected plugin generation, candidate fingerprint, and
   package identities. It then publishes active/last-good atomically. `abort`
   retains active/last-good and records the typed failure.

Install, enable, disable, upgrade, and uninstall share this journal. No path
from renderer code can call these state transitions directly. Reload escalation
uses the fixed ladder `config-live`, `plugin-restart`, `plugin-generation`,
`runtime-generation`, and `app-restart`; the package module records the planned
minimum but delegates execution to the owning runtime/launcher layer.

## Crash recovery and stale fences

Every phase transition is persisted before its external effect. On launcher
restart:

- an imported or permission-blocked candidate is aborted without changing
  active/last-good;
- an activation-requested candidate requires an exact Generation Runtime
  recovery observation;
- an exact matching ready runtime/plugin generation tuple may be committed
  idempotently;
- a missing, stale, mismatched, or ambiguous observation restores last-good and
  records recovery failure;
- late activation callbacks, permission decisions, commits, aborts, and GC
  requests fail the store-revision fence.

Every stale-operation fence binds all three authority dimensions:

1. current runtime generation;
2. every affected plugin generation; and
3. exact `(pluginId, version, sha256 integrity)` package identity.

Recovery never guesses that an old process is still authoritative and never
silently promotes candidate bytes.

## Permission seam

Package intake retains the normalized capability declarations from the static
package manifest but grants no authority. The existing launcher/Permission
Broker builds the install-or-enable authorization plan using the canonical
package source and plugin id. The package transaction persists only the opaque
plan identity/fingerprint and exact authorization outcome required for
activation fencing. It does not create a second grant store.

## Validation and negative boundary

Focused tests cover deterministic integrity, all three local intake forms,
path/link rejection, dependency compatibility and cycles, affected closure,
uninstall-in-use refusal, CAS conflicts, permission denial, normal commit,
interrupted-phase recovery, stale runtime/plugin/package callbacks, reference
counts, rollback leases, and deferred GC. Fault injection covers integrity,
write/rename failure, and interruption between durable phases.

The release gate is focused tests, full `npm run check`, build/typecheck,
`npm audit --audit-level=high`, package allowlists, and `git diff --check`.
A real launcher smoke may verify store creation and a dry-run candidate, but
this task cannot claim renderer generation switching or Manager installation UI.

