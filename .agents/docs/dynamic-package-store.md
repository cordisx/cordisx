# Launcher package-store implementation mapping

## Authority and scope

The normative dynamic package and lifecycle contract is
`cordisx-protocol@832d319`, including package source v1, package/operation/
result v2, activation v1, and the staged-registry/atomic-publication rules from
`9fa3085`. [`dynamic-plugin-lifecycle.md`](dynamic-plugin-lifecycle.md) maps
those contracts into the Host architecture. This document records only the
Launcher implementation and does not define another public protocol.

The implementation is under `packages/cli/src/launcher/packages/`. It is
Node/Launcher-private: the `cordisx` package exports only `./contracts`, so
renderer code receives no package-store API. This slice does not render
Manager DOM and does not implement Generation Runtime registry publication.

## Intake and immutable objects

`resolvePluginPackageSourceV1()` accepts exactly `local-directory`,
`local-package`, or `downloaded-tarball`. It converts a query-free local
`file:` URL into a Host path; `downloadedFrom` is required HTTPS attribution
for the tarball form and never grants download authority. `ImmutablePackageObjects`
then snapshots the complete source before manifest parsing. It rejects links,
special files and escaping archive paths, calculates a deterministic SHA-256
tree digest, and publishes a read-only object at `objects/sha256/<digest>`.

`JsonPackageManifestV2Resolver` keeps package metadata and runtime authority
separate. It validates the package-v2 distribution statement
`explicit-local-v1`/`signature: unsupported`, exact dependencies, required
protocol schemas, the package-relative entry, the independent runtime-manifest
path/digest/schema, and matching package/runtime ids. Formal runtime-manifest
validators are injected by the owning Host instead of being reimplemented by
the store.

Manifest-v3 Channel configuration retains only its `kind=host|none`
declaration. Connection, transport, mapping, limits, credentials, `secretRef`,
`secretState`, process lifetime, and data-directory values are rejected as a
runtime-manifest tunnel. Actual Channel service configuration stays in the
launcher-owned plane implemented by `@cordisx/channel-runtime`; the renderer
continues to receive only its redacted descriptor. CLIProxy, Agent Trace, and
ordinary plugin Schemastery `Config` remain independent renderer configuration
planes.

## Journal, graph, and activation records

`JsonPackageStore` keeps a private atomically replaced `state.v1.json` behind
an exclusive lock and filesystem CAS revision. Profile activation revision is
separate from that storage revision. Records include immutable package
identity `(pluginId, version, sha256 integrity)`, active/candidate/last-good
selections, exact dependency bindings, transaction phases, rollback leases,
and delayed-GC eligibility.

The graph accepts exact dependency versions only. The Host recomputes the
reverse dependent closure at every token resolution and rejects missing,
conflicting, duplicate, self, or cyclic edges. Activation order is dependency
first; drain/dispose order is the reverse. Uninstall/disable refuses an enabled
required dependent unless a later confirmed lifecycle plan explicitly owns
that entire closure.

`PackageLifecycleHost.activationRecords()` projects product-safe
`plugin-activation.v1` active/candidate/last-good records. They contain no
local/store/artifact path. Last-good is a profile-level snapshot, so a new
installation is not incorrectly copied into the activation record that
preceded it.

## Host-private Generation Runtime seam

`prepare()` returns random branded `PackageCandidateToken` and
`PackageImpactToken`; only their SHA-256 hashes are journaled. Both are bound
to owner, profile, activation revision, the full runtime/module/package fence,
and the Host-computed closure. The Generation Runtime calls the same methods at
all four boundaries:

- `resolveCandidate(access, plan|stage|publish|rollback)` returns a frozen
  `PackageActivationPlan` with `expected`, `current`, `after`, and `lastGood`
  complete tuples;
- `resolveImpact(access, boundary)` recomputes and verifies changed ids,
  affected closure, activation order, and drain order;
- each package projection contains exact identity/dependencies plus the
  Launcher-only `artifactDirectory`, `runtimeEntry`, and runtime-manifest
  digest; `resolveRuntimeModule(access, boundary, pluginId)` rereads and
  validates the separate manifest from the immutable object on demand.

The renderer cannot submit a tuple or authoritative affected ids. Every
boundary rereads the journal and verifies activation revision,
`runtimeGeneration`, `moduleGeneration`, package digest, owner, profile, and
token hash before Generation Runtime work proceeds.

## Permission gate

`createHostPermissionReviewAuthority()` wraps the existing Permission Broker;
it is not a policy store. The broker returns the exact authorization plan
revision and decision plus opaque allow-once grant ids. The wrapper issues a
branded `HostPermissionReviewToken`; its hash and a bounded decision/input
fingerprint are journaled, never raw scope, capability, credential, or secret
values. The durable package record likewise stores only the runtime entry and
manifest digest; the immutable package object remains the single copy of the
formal runtime document.

Install, update, and enable bind that review to owner, profile, candidate and
impact tokens, immutable package identity, candidate fingerprint, and the full
generation fence. `PackageCandidateAccess` must contain the Host review token.
Unresolved or denied required authority fails before plan/stage/publication and
readiness. Optional deny, allow-once, and persistent allow remain Permission
Broker decisions. Candidate abort/recovery revokes candidate allow-once ids;
disable, uninstall, update, or dependent generation replacement revokes the
retired generation's ids. A terminal or recovered transaction cannot reuse a
review token for another candidate.

## Publication failure and rollback

Generation Runtime owns transaction-local staged registries and the single
closure publication. The store never makes a staged contribution visible.
After `requestActivation()`, readiness produces a receipt that must match the
candidate token/fingerprint and every affected runtime/module/package fence.
Only the exact receipt may commit the new profile revision and last-good
snapshot.

If the `after` tuple may have published but commit-last-good does not complete,
the required sequence is:

1. `beginRollback(candidateAccess, failureCode)` durably records
   `rollback-pending` and returns a branded `PackageRollbackToken` plus
   `expectedPublished=after` and `rollbackTarget=lastGood`;
2. Generation Runtime atomically restores the entire last-good closure and
   drains/disposes every after-generation member through the injected
   `HostRollbackCompletionAuthority`;
3. `completeRollback(rollbackAccess)` accepts only that Host-issued receipt,
   rereads the rollback boundary, verifies active observation equals
   `rollbackTarget` and disposed observation equals `expectedPublished`, then
   marks the journal aborted and releases candidate permission/artifact refs.

While rollback is pending, ordinary abort fails, a new profile transaction is
blocked, candidate/last-good objects remain referenced, and GC cannot cross
the fence. Startup recovery returns `rollback-published` with a fresh rollback
token for activation-requested, readiness-confirmed, observed-after, or an
existing rollback-pending transaction. It never promotes an interrupted
candidate or misclassifies a potentially live after-generation as disposable.

## Leases and validation

Reference counts cover installed, active, profile last-good, per-plugin
last-good, rollback, non-terminal candidate, and transaction refs. Logical
uninstall precedes physical cleanup. `collectGarbage()` removes an immutable
object only after every lease is gone and its grace period has elapsed;
cleanup failure cannot reactivate it.

Focused coverage includes all three sources, package/runtime digest failure,
link/archive rejection, Channel configuration-tunnel rejection, exact graph
conflict/cycle/closure, required permission denial, permission-token forgery,
allow-once cleanup, four-boundary stale fences, readiness mismatch, process
interruption, rollback-pending concurrency/GC, forged and stale rollback
receipts, uninstall-in-use, activation-v1 last-good projection, lease release,
and atomic-store fault injection. Release gates are full `npm run check`,
audit, focused fault tests, and `git diff --check`.
