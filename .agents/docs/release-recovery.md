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

The publisher writes `.release-cache/npm-release-recovery.json` after each
upload and before every propagation attempt. The checkpoint records the
GitHub run id and attempt, exact tag and commit, prepared-artifact SHA-512,
per-package tarball integrity, uploaded package names, phase attempt, and next
action. A resumed attempt must restore that file beside the same prepared
artifact. It verifies the complete identity before using the checkpoint, then
rechecks registry metadata instead of trusting the saved package list.

Only these stages are resumable: `upload`, `visibility`, `verification`, and
`clean-install`. A visibility or verification resume never rebuilds and never
submits another publish request. An upload resume may repeat `npm publish` only
to cover a crash between registry acceptance and checkpoint persistence; an
`EPUBLISHCONFLICT` still requires matching integrity and immutable metadata on
readback. A completed checkpoint makes the publisher a no-op.

The workflow owner must persist and restore
`.release-cache/npm-release-recovery.json` after publication starts. That is a
CI integration boundary, not part of the registry scripts. The state file is
deliberately narrower than a general release manifest and can consume a future
Route A identity only if it supplies the same exact tag, commit, artifact
SHA-512, and package integrity map.

## Timing model

Before this change, the recovery model was a whole-job rerun. Older releases
also waited for one package to propagate before the next upload, so two packages
with seven-minute propagation delays could spend about 14 minutes before clean
installation, plus repeated install/build preparation when the artifact cache
was unavailable.

After this change, all missing packages are submitted first. Visibility and
immutable verification share one exponential-backoff window: 5, 10, 20, 40,
then at most 60 seconds per wait, with a hard 10-minute wall-clock deadline.
In a deterministic two-package model where each package becomes visible after
seven minutes, the configured backoff observes both at 7 minutes 15 seconds;
the previous per-package serial flow would take about 14 minutes 30 seconds.
Recovery starts at the saved stage and reuses the exact prepared artifact, so the retry
adds no `npm ci` or build time; only the remaining registry and clean-install
work is repeated.

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

Pull-request CI remains risk-tiered. A package or lockfile dependency hotfix runs
all Node test groups and package checks, plus the browser group only when the
resolved browser dependency set changes. Release automation, metadata, and
packaging changes retain the full safety gate. The release tag workflow then
runs the focused release tests and package gates before saving a reusable
prepared artifact.
