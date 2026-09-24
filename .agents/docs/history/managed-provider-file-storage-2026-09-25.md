# Managed Provider file storage checkpoint - 2026-09-25

Status: local FILE-STORE candidate on branch
`fix/native-catalog-management`. This is a dated implementation checkpoint, not
a formal merge, package, installation, native-App acceptance, or public plugin
contract.

The candidate moves CordisX-managed Provider connection records and API keys
from the Provider-specific Keychain namespace into the selected profile in the
existing owner-only CordisX `config.json`. Native Codex `config.toml` providers
remain independent and are not imported or duplicated.

## Scope

- Add strict `apps.<app>.profiles.<profile>.managedProviders` parsing with a
  64-record bound and duplicate-ID rejection.
- Read, create, update, remove, and reload managed Providers through the shared
  validated and atomic home-config writer while preserving unrelated concurrent
  edits.
- Preserve stable connection identities, scope and credential revisions,
  discovery, supplements, scripts, overlays, routing, and Host-private
  credential use.
- Store catalog cache, script, and overlay state as validated plaintext JSON
  with owner-only permissions, atomic replacement, and external-edit detection.
- Use the versioned `<profile>.lock.state.v2.json` path so a preserved legacy
  encrypted `<profile>.lock.state` cannot block valid file-backed Providers.
- Remove all Provider-owner and catalog-state Keychain access. Existing legacy
  Keychain records are neither read, migrated, nor deleted.
- Redact managed secrets and credential references from printable CLI
  configuration, management snapshots, and diagnostic projections. Surface an
  unavailable managed catalog with a generic warning while leaving unrelated
  native providers usable.

## Verification

- Focused Vitest: 55 tests pass across home config, managed Provider owner,
  managed catalog composition, script persistence, Manager channel composition,
  and native resource composition.
- `npm run typecheck --workspace=cordisx` passes.
- Fixtures cover create/update/remove/reload, model discovery with zero Keychain
  calls, plaintext catalog/script/overlay reload, `0600` files, concurrent edit
  preservation, malformed input non-overwrite, legacy Keychain preservation,
  legacy encrypted-state isolation, redacted CLI/snapshots, and exact native
  `config.toml` byte preservation.
- No real Provider request, real credential, real user configuration, Keychain,
  running App, installation, packaging, publication, or user acceptance was used.
- The new CLI redaction case passes independently. An accidental full-file CLI
  integration run also passed that case and 19 existing cases, but 14 unrelated
  build-fixture/timeout cases failed in the reused dependency environment; those
  failures are not claimed as passing evidence for this checkpoint.

## Dependency and release handoff

The FILE-STORE delta starts after local checkpoint `cc34216`. The three prior
local-only commits are `951d23f`, `426bacc`, and `cc34216`; they implement native
catalog management/discovery/control preservation and are not wholesale
dependencies of the storage design. The storage implementation itself depends
on the earlier formal managed Provider/profile synchronization foundation already
below those commits. Its only direct overlap with the three local commits is the
small managed-catalog availability warning and combined native-catalog fixture in
`native-submission-composition.ts` and its integration test. RELEASE should
consume this exact FILE-STORE delta onto its selected START/MENU compatible base
and reconcile that composition hunk, not replace the package with this full old
branch.

## RouteSpecHandoff

- route: FILE-STORE
- routeTaskRef: `01a0c7a0-2f65-7423-9128-418409a67fb6`
- formalMain: `bc54b83790ba07e28d76a7aafee929b2d5b7954a`
- stageBase: `cc34216bcb60a1a24ee297b90756d3aebfcd8f28`
- outputRef: `.agents/docs/history/managed-provider-file-storage-2026-09-25.md`
- ownedRequirements: FILE-1, FILE-2, FILE-3, FILE-4, FILE-5
- sourceCheckpoint: `ed60928bd9aab1790c39a877efa4167dea5ccb90` plus the
  compatibility follow-up commit containing this revision
- remainingGaps: integrated
  START/MENU/PREF/CAPS candidate, packaging, native-App verification, and user
  acceptance remain separate
- coordinatorContinuationRequired: true
- coordinatorMayComplete: false
