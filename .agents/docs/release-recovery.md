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
3. Rerun the failed job for the same workflow run. The workflow downloads the
   exact-SHA canonical candidate from its successful `Check` run, then restores
   the latest valid `release-state.json` saved by an earlier attempt. It reuses
   the manifest-bound tarballs instead of repeating `npm ci`, build, release
   tests, or package allowlist gates.
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

The manifest and state are the only release identity and lifecycle records.
The npm publisher consumes them directly: it recreates each workspace tarball,
requires its integrity to match the manifest, and only then publishes from the
workspace so npm records the tagged commit as `gitHead`. It advances
`PUBLISHED` only after every package has been accepted or read back with
matching immutable metadata. It then advances `VISIBLE` after one concurrent
registry readback observes matching integrity, `gitHead`, metadata, and
provenance for the complete package set.

The clean-registry verifier reopens the same manifest and state, rechecks live
registry truth on every incomplete resume, advances `VERIFIED` only after clean
installation and runtime/generated-project checks, and advances `DISTRIBUTED`
only after the selected dist-tag is correct. GitHub run id, run attempt, retry
attempt, submitted-package names, and other operational details are evidence
inside those phase entries; they do not define another identity or lifecycle
schema.

Only the canonical `PUBLISHED`, `VISIBLE`, `VERIFIED`, and `DISTRIBUTED`
phases are resumable. A `VISIBLE` resume never publishes again. A `PUBLISHED`
resume may repeat `npm publish` only to cover a crash before durable phase
advancement; an `EPUBLISHCONFLICT` remains only a cue for registry readback and
never proves matching content. A terminal `DISTRIBUTED` state makes registry
verification a no-op.

The workflow owner must create and persist the manifest, state, and referenced
tarballs before publication, then restore the same files for failed-job reruns.
The publisher defaults to `.release-cache/release-manifest.json`,
`.release-cache/release-state.json`, and `.release-cache/release-packages/`.

### Before and after this primitive

Before this manifest, the reusable archive had one aggregate digest while
per-package integrity and recovery progress were reconstructed from workflow
logs and live registry queries. After adoption, one manifest binds every
publishable tarball to the exact commit and one state file names the next of
four phases. Reading a recovery point performs zero installs, zero builds, and
zero registry calls; it reads two JSON files and hashes each package tarball.
An identity failure therefore stops before any remote mutation.

Publication now submits all missing packages before waiting. Visibility and
immutable verification share one exponential-backoff window: 5, 10, 20, 40,
then at most 60 seconds per wait, with a hard 10-minute wall-clock deadline.
In a deterministic two-package model where each package becomes visible after
seven minutes, the configured backoff observes both at 7 minutes 15 seconds;
the previous per-package serial flow would take about 14 minutes 30 seconds.
Resume reuses the manifest-bound tarballs and starts from the next canonical
phase, so it does not run `npm ci`, rebuild, or repeat completed verification.

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

## Candidate artifact boundary

The `Check` workflow creates package tarballs once, exercises those exact files
in the installed-package gate, and only after every selected gate succeeds
writes the immutable manifest and initial state. The resulting
`release-candidate-<commit>` artifact contains only the canonical
`.release-cache/release-manifest.json`, `.release-cache/release-state.json`, and
`.release-cache/release-packages/` interface. Missing artifacts or any commit,
manifest, state, package-set, size, SHA-512, or npm-integrity mismatch fail before
extraction and publication; there is no secondary provenance schema or fallback
rebuild path.

Each release attempt uploads its latest `release-state.json` as a run-scoped
artifact. A later attempt restores only the newest state from the same release
run and verifies it against the immutable candidate manifest and tarballs before
replacement. This preserves completed publication phases without allowing state
from another commit, manifest, or workflow run to cross the recovery boundary.

Pull-request CI remains risk-tiered. A package or lockfile dependency hotfix runs
all Node test groups and package checks, plus the browser group only when the
resolved browser dependency set changes. Release automation, metadata, and
packaging changes retain the full safety gate. The release tag workflow then
runs the focused release tests and package gates before saving a reusable
prepared artifact.
