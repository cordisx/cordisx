# Launcher package delivery hardening

## Authority and scope

The normative contract is `cordisx-protocol@832d319` (package source v1,
package/lifecycle v2, activation v1). This note maps that contract to the Host;
it does not define another protocol.

PR #73 remains the single owning implementation:

- `launcher/plugin-package.ts` owns the immutable staged package and module;
- `launcher/plugin-activation.ts` owns dependency validation plus active,
  candidate, and last-good activation records;
- `launcher/plugin-lifecycle.ts` owns the public lifecycle coordinator;
- the existing renderer runtime/registries own generation visibility.

`launcher/packages/` is only a Host-private hardening layer. It does not keep a
second activation state, coordinator, graph, registry, loader, or public result
projection. It is not exported to renderer code and does not touch Manager DOM.

## Source v1 and separated package v2

`stagePluginPackageSourceV1()` accepts exactly `local-directory`,
`local-package`, and `downloaded-tarball`. All locations are query-free `file:`
URLs. A downloaded tarball additionally requires HTTPS discovery attribution;
that attribution is not download or Marketplace trust authority.

Every source is first copied/extracted into a private immutable candidate
snapshot. Links, hard links, special files, escaping archive paths, and an
optional SHA-256 mismatch are rejected before parsing. The package-v2 resolver
then verifies explicit-local/unsigned distribution, entry and manifest paths,
exact dependencies, compatibility schemas, canonical public source, runtime
manifest digest, and package/runtime id equality.

The public `cordisx/vite` production helper emits the formal
`dist/artifact.json` beside the indexed browser ESM graph. A portable package
manifest points its browser entry at the adjacent prebuilt `dist/module.js`.
Host staging validates every indexed module, stylesheet, asset, and digest
before retaining the same formal graph in the immutable store.

The resolved candidate is projected into the existing `StagedPluginPackage`
store. Its private v3 durable envelope preserves the source runtime-manifest
digest as provenance and separately records the digest of the normalized bytes
persisted as the immutable runtime object. Entry validation checks the source
digest; store readback checks the normalized-object digest. The two identities
are never substituted for each other. Package-v2 remains limited to the prior
runtime manifests. Package-v3 may reference formal manifest-v4; the Host
revalidates its 22-capability declarations against the sensitivity catalog both
before staging and after immutable readback, then projects the same manifest
into the renderer generation loader. Runtime manifest v1 remains a compatibility
input.

Runtime manifest parsing rejects connection, transport, mapping, limits,
credential, `secretRef`, `secretState`, process-lifetime, and data-directory
values as launcher-configuration tunnels. Manifest-v3 Channel declarations may
only describe `configuration.kind=host|none`; the actual Channel configuration
and allowed `keychain:`/`host-secret:` references remain in the launcher-owned
service plane. `none` does not synthesize an empty configuration. CLIProxy,
Agent Trace, UI demos, and ordinary Schemastery Config remain separate renderer
configuration planes.

This delivery slice makes no claim of remote signature verification,
Marketplace install trust, or security sandboxing.

## Host-private authority seam

`PackageLifecycleAuthority` wraps the existing `PluginActivationStore`. Its
atomic journal contains transaction/token/permission/rollback metadata plus
frozen candidate fence snapshots; it is not another active package state.

`prepare()` reads the existing active and candidate activation records,
recomputes the reverse dependency closure with `pluginDependentClosure()` and
`topologicalPluginOrder()`, and issues random branded candidate, impact,
permission-review, and later rollback tokens. Only token hashes are durable.
Every access is bound to owner, profile, activation revision,
runtimeGeneration, exact package version/digest, moduleGeneration, exact
dependencies, permission plan revision, and the shared registry epoch.

Generation Runtime uses the same resolver at four boundaries:

- `resolveCandidate(access, 'plan'|'stage'|'publish'|'rollback')` returns a
  frozen Host-authoritative `candidateFingerprint`, expected/current/after/
  last-good tuple, and expected/after registry epochs; the fingerprint is the
  same value returned by `prepare()` and binds private registry receipts;
- `resolveImpact()` returns only the Host-recomputed closure and ordering;
- `resolveRuntimeModule()` returns package identity plus a Launcher-only
  immutable graph root and its `./module.js` entry. Relative chunks, CSS, and
  static assets remain inside that same authenticated graph; no runtime
  manifest, source directory, or permission scope reaches the renderer.

The shared registry transaction remains D-owned. It gives the candidate a
private readiness view, flips one active closure epoch atomically, and retains
the hidden retiring closure until commit-last-good or rollback. C consumes only
Host-branded readiness and rollback receipts for that shared epoch; it creates
no registry.

## Permission and rollback gates

`createHostPermissionReviewAuthority()` is an authentication wrapper around
the existing Permission Broker, not a second policy engine. It binds the broker
result to the candidate identity/fence and stores only bounded fingerprints,
decision ids, plan revision, and opaque allow-once ids. Required unresolved or
denied authority fails closed before stage, readiness, and activation. Optional
deny/allow-once/persistent allow retain Permission Broker semantics. Abort,
rollback, recovery, uninstall/replacement cleanup revoke transaction one-shot
grants; raw scope and secrets are never journaled.

After an atomic after-epoch publish, a later failure follows this sequence:

1. `beginRollback()` durably records `rollback-pending` and pins both after and
   last-good artifacts;
2. Generation Runtime flips the shared registry back to the complete last-good
   closure and disposes the after closure;
3. it returns a Host-branded receipt containing the restored epoch, active
   last-good observation, and disposed-after observation;
4. `completeRollback()` re-resolves the rollback boundary, verifies the full
   observations, restores the durable #73 active record when needed, revokes
   one-shot grants, and ends the journal.

Abort, another transaction, last-good release, and GC cannot cross
`rollback-pending`. Recovery returns `rollback-published` for any possibly
published transaction and `discard-staged` only for definitely pre-publication
work. After restart, `resolveRollback(rollbackAccess)` authenticates the
fresh recovery token and returns the complete expected-published/rollback-target
tuple plus candidate fingerprint needed to sign the shared-registry receipt. A
recovered review never binds to a new candidate.

## Leases and GC

GC derives references from the single #73 active, candidate, and last-good
records plus non-terminal journal fences. Last-good history is an explicit
lease released only after the Generation Runtime confirms old-generation
disposal. Orphan package objects and logically uninstalled objects are removed
only after all those references are absent and the grace period has elapsed.

Focused tests cover all three source forms, source/runtime integrity faults,
configuration tunneling, owner/profile/token forgery, required permission
denial and one-shot cleanup, full tuple/epoch fences, Host-branded readiness,
publish-after rollback-pending, forged/stale rollback receipts, recovery,
concurrent transaction/abort/GC gates, and immutable-object cleanup.
