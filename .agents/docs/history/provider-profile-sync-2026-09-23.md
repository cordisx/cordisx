# Provider profile synchronization delivery - 2026-09-23

Status: implementation candidate on `feat/provider-profile-sync`, based on Host
main `5ad828763c3e111d2ce02d796fb74e772433d256`. This is a dated delivery
record, not permanent maintenance instruction or a public plugin contract.

The change extends the Host-owned provider model with explicit connection and
target-profile binding identities. Native discovery remains read-only. Managed
connections synchronize through target adapters without treating names, URLs,
model ids, or credentials as identity.

## Scope

- SYNC-1: keep native-owned connections in their original target/profile
  configuration, discover them with zero writes, and require explicit import or
  adoption without duplicating URL or credential requirements.
- SYNC-2: configure Host-neutral managed connections once and explicitly bind
  them to target profiles through a production Codex adapter; report other
  adapters as partial or unsupported instead of implying support.
- SYNC-3: persist stable connection, binding, target-profile, and local provider
  identities; make startup, import, adoption, rename, disable, delete, and
  detach behavior explicit and idempotent.
- SYNC-4: use field-group L/S/T comparison. Preserve an ordinary Host edit,
  skip its coherent conflicting group, warn non-modally, and continue applying
  independent non-conflicting groups and connections.
- SYNC-5: validate before an atomic target commit, fence concurrent edits and
  recovery, then project the actual parsed target plus separate CordisX
  metadata. Persisted state never claims runtime activation, and existing
  catalog discovery/overlay/script behavior and path semantics remain intact.

## Write boundary

This task owns the Host launcher/config/provider implementation, its fixture
tests, this dated record, and the owning Host reference. It does not modify
`plugin-cli-proxy-api`, public Protocol contracts, unrelated renderer UI, real
user configuration, credentials, installation, publication, or live App state.

## Candidate verification

- Fixture coverage passes for discovery, identity, idempotency, import/adopt/detach,
  rename/delete/disable, conflicts, unknown TOML/comment retention, concurrent
  edits and recovery, actual-target projection, catalog compatibility, and
  adapter capabilities.
- The focused core group passes 46 tests across provider synchronization, home
  configuration, and managed catalog composition. The native resource
  integration group passes all 4 tests, including committed credential delivery
  and conflict exclusion through the production composition.
- Changed-file dprint and staged ESLint pass. Changed provider/config/composition
  modules add no TypeScript errors. The reused dependency tree still reports the
  pre-existing `vite-development.ts` HMR option mismatch outside this change.
- No real App, user configuration, live credential, publication, or installation
  acceptance was performed.

PR CI, squash merge, and exact-main readback remain delivery gates. Coordinator
continuation remains required until all coordinated owners complete their work.
