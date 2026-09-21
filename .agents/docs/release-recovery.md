# Release recovery

Use this maintainer runbook when the trusted-publisher job has submitted one or
more npm packages but registry metadata, provenance, dist-tags, or installation
has not converged yet. It does not authorize creating, moving, or deleting a Git
tag, publishing from a feature branch, bypassing the `npm-release` environment,
or publishing with a long-lived npm token.

## Before expensive preparation

Run `npm run check:release:entry && npm run check:release` on the intended
revision before installing or building. These offline Node checks catch ESM
linkage and local release metadata errors. They do not verify registry
availability: confirm required Protocol and bundled plugin versions/source
revisions have completed their owner release before preparing the Host release.
Use the existing `cordisxSources`, manifests, and lockfile as the dependency
record; retain the normal package and clean-registry gates for release evidence.

## Normal recovery

1. Keep the original `v<semver>` tag and tagged commit unchanged. Confirm the
   release run is for `cordisx/cordisx`, `.github/workflows/release.yml`, and the
   expected `npm-release` environment.
2. Read the failed publish log. A message that a package is still propagating is
   recoverable; an integrity, `gitHead`, repository, license, bin, engine, or
   channel-safety mismatch is not.
3. Rerun the failed job for the same workflow run. The exact-SHA prepared
   artifact cache is saved before publication starts, so the rerun verifies and
   restores its `node_modules` and workspace `dist` outputs instead of repeating
   `npm ci`, build, release metadata, and package allowlist gates.
4. Let the publisher inspect every package version first. Matching packages are
   skipped. Missing packages are all submitted in dependency order before remote
   convergence begins. A publish conflict caused by a prior submission is
   accepted only as a cue to continue readback; it is never treated as proof of
   matching content.
5. Wait for the unified readback. Registry 404/target misses, delayed
   attestations, and delayed selected dist-tags use exponential backoff from 5
   seconds to a 60-second cap, within a 10-minute total window. Each retry logs
   elapsed time, attempt number, next delay, and deadline.
6. Treat the workflow as complete only after clean registry installation and
   generated-project verification pass for both packages.

## Release manifest and state

Create one immutable `cordisx/release-manifest/v1` record only after the exact
commit is the intended release candidate, its tracked working tree is clean,
every required CI gate has passed for that SHA, and review is approved or has a
recorded authorized bypass. The manifest binds:

- repository, full commit SHA, version, Git tag, registry, and npm dist-tag;
- each package's dependency inputs and exact tarball filename, byte size,
  SHA-512 hex digest, and npm `integrity` value;
- required CI and review evidence, each independently tied to the same commit;
- the ordered `PUBLISHED`, `VISIBLE`, `VERIFIED`, and `DISTRIBUTED` lifecycle.

Keep mutable recovery progress in the separate
`cordisx/release-state/v1` record. `PUBLISHED` means every upload was accepted
or an immutable identical version already existed. `VISIBLE` means registry
metadata and provenance are readable. `VERIFIED` means the clean-install and
runtime package checks passed. `DISTRIBUTED` means the intended dist-tag and
downstream distribution evidence are complete. A phase may complete only after
its predecessor, and repeating an already-complete phase is an idempotent no-op.

The state records the manifest SHA-512 digest, exact commit, last completed
checkpoint, and next phase. Resume by verifying the manifest, every tarball,
and the state before taking the next phase. A changed commit, changed tarball,
changed manifest field, non-contiguous phase history, or mismatched gate SHA
invalidates the recovery point; do not rebuild or publish under the old state.
The CLI entry is:

```text
node scripts/release-manifest.mjs create --input <input.json> --manifest <manifest.json> --state <state.json>
node scripts/release-manifest.mjs verify --manifest <manifest.json> --state <state.json> --artifact-root <dir>
node scripts/release-manifest.mjs advance --manifest <manifest.json> --state <state.json> --artifact-root <dir> --phase <phase> --evidence <evidence.json>
node scripts/release-manifest.mjs resume --manifest <manifest.json> --state <state.json> --artifact-root <dir>
```

The manifest/state scripts define identity and recovery semantics only. The
release workflow and registry publisher remain responsible for creating the
inputs and advancing phases at their existing safety boundaries.

### Before and after this primitive

Before this manifest, the reusable archive had one aggregate digest while
per-package integrity and recovery progress were reconstructed from workflow
logs and live registry queries. After adoption, one manifest binds every
publishable tarball to the exact commit and one state file names the next of
four phases. Reading a recovery point performs zero installs, zero builds, and
zero registry calls; it reads two JSON files and hashes each package tarball.
An identity failure therefore stops before any remote mutation.

This primitive alone does not reduce the first release run's wall-clock time.
The CI artifact and registry publication routes must integrate it before
measuring the 20-30 minute narrow-hotfix and 30-45 minute Host-plus-Creator
targets. Until then, report the existing workflow duration unchanged rather
than attributing speculative savings to this script.

## Stop conditions

Do not rerun publication after an immutable mismatch. Preserve the log and
compare the visible registry version with the tagged source:

- `dist.integrity` mismatch means the version contains different tarball bytes;
- `gitHead` mismatch means the version was published from another commit;
- repository, license, bin, or engines mismatch means the visible package is not
  the tagged release contract;
- a prerelease moving `latest` is a channel-safety failure.

npm versions are immutable. These conditions require maintainer diagnosis and a
new corrected version; another workflow rerun cannot repair them.

## Prepared artifact boundary

The cache key includes the exact Git SHA, runner operating system, Node version,
and npm version. Its sidecar records the tag, package set, archive size, and
SHA-512 digest. A cache hit is verified before extraction. Cache miss or any
identity/digest mismatch fails before extraction; there is no fallback that
silently trusts a partial or cross-commit artifact. If the cache itself is
damaged, delete that exact cache entry in GitHub Actions and rerun the unchanged
tag so the normal install, test, build, metadata, and package validation path
can create it again.

The prepared archive sidecar protects the reusable build cache. The release
manifest additionally protects the publishable tarballs and the durable phase
checkpoint. Neither record substitutes for the other.

Pull-request CI remains risk-tiered. A package or lockfile dependency hotfix runs
all Node test groups and package checks, plus the browser group only when the
resolved browser dependency set changes. Release automation, metadata, and
packaging changes retain the full safety gate. The release tag workflow then
runs the focused release tests and package gates before saving a reusable
prepared artifact.
