# CI validation and diagnosis

Use the [organization risk-tiered gates](https://github.com/cordisx/cordisxmono/blob/main/.agents/rules/risk-tiered-gates.md)
for evidence requirements. This guide describes the Host workflow that implements them.

## Pull-request scope

`scripts/ci-scope.sh` classifies the merge-base/head diff. It includes deleted
paths and both sides of renames, using NUL-delimited paths. Empty diffs or a
failed scope job retain the full gate. `scripts/test-ci-scope.mjs` exercises real
Git diffs and guards the complete command sequence without installing dependencies.

- Host guides under `.agents/docs` use changed-file quality checks. Maintenance
  rules and root contributor instructions still trigger the full gate.
- Plugin-development Skill Markdown, `version.json`, and `agents/openai.yaml`
  use changed-file quality checks plus `skill-package`: build the CLI dependency
  closure and run the existing tarball contents/deployment check. This verifies
  required files, source/bundle/tarball equality, provenance, and deployed content.
  Added executable Skill assets retain the full gate. Mixed code/Skill changes
  retain the code gate as well as the Skill package check unless full already covers it.
- Ordinary code uses affected typecheck, build, and dependency-related tests.
  Permission, data, lifecycle, native/launcher, dependencies, packaging, CI,
  and shared compiler/test/quality configuration retain the full owner gate.
- Main pushes, releases, and Mono integration retain complete validation.
  A documentation or Skill result is not release or native-App evidence.

The shared quality audit checks the PR head itself and caches npm downloads.
The download cache is not an exact-SHA validation result or a reusable build.
Runtime-test installs retain lifecycle scripts: the Git Channel and CLIProxy
dependencies need `prepare` to supply their runtime exports. Format-only and
static build jobs may skip those lifecycle builds.

## Diagnose a long run

Complete jobs use `!cancelled()` so a superseded PR releases its concurrency
slot while a failed scope still selects full validation. Job-level `always()`
would keep the old run alive after cancellation and delay its replacement;
see [GitHub cancellation semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation).
Short evidence/upload cleanup steps may still use `always()`.

Inspect the run attempt, head SHA, and active step before rerunning anything.
The workflow prepares dependencies and build outputs once, then runs typecheck,
the four test projects, and package validation in parallel. Installation remains
downstream of package validation because it consumes those exact tarballs.
GitHub records a duration for each job and matrix project.

Compare the slow phase with recent successful runs of the same gate. Read its
logs when duration or output suggests a stall; distinguish runner queue time,
installation, test execution, and a failed/retried attempt. Repeatedly querying
an unchanged run does not produce new validation evidence. Report phase changes,
failures, completion, or a diagnosed delay instead of repeating unchanged status.
Do not restart healthy checks or rerun an unchanged full gate just to refresh a
status message. Changing the head SHA requires fresh applicable evidence.

## Host DAG and exact release candidates

The `Check` workflow prepares dependencies and build outputs once. After that
shared prerequisite, typechecking, the core/renderer/integration/browser test
matrix, and package validation run in parallel. All four test projects may run
at the same time. The installed-package job starts only after package validation
has produced the exact Host and Creator tarballs that it installs.

The package job uploads `release-packages-<commit>` for downstream installation
checks. After every selected gate succeeds, the `full` job binds those exact
tarballs into the canonical `.release-cache/release-manifest.json`,
`.release-cache/release-state.json`, and `.release-cache/release-packages/`
layout and uploads `release-candidate-<commit>` for 30 days. The manifest records
the repository, exact commit, release identity, CI and review evidence, package
dependency inputs, filename, size, SHA-512 digest, and npm integrity. A new head
creates a different artifact name and canonical verification rejects a commit,
manifest, state, or tarball mismatch.

The final `full` job remains the stable required check. It succeeds only when
every selected prerequisite is successful or intentionally skipped. Use
GitHub's **Re-run failed jobs** action for transient failures: the successful
shared preparation and exact candidate remain in the same workflow run, while
only the failed job and its required dependants run again.

Tag publication locates the `Check` push run for the exact tag commit, waits for
its aggregate result, and downloads that commit's canonical candidate only
after the run is green. It restores the latest valid `release-state.json` saved
by an earlier attempt of the same release run, verifies the manifest, state, and
tarball bytes, restores the package contents, and confirms that each workspace
reproduces the recorded npm integrity. Every attempt persists the updated state
with `always()` so Route B resumes at the next canonical phase. It does not
repeat dependency installation, the full tests, or the build. Missing, expired,
failed, changed-head, or invalid recovery candidates fail before publication.

Before this change, the test matrix admitted only three concurrent projects and
package validation plus clean installation shared one serial job. In main
`Check` run `35605863047`, the workflow took 8:57: integration remained the
6:58 critical path, browser waited 3:29 for a matrix slot, and the 4:38 package
job spent 4:13 in clean/installed verification. With four test slots, browser
starts in the first wave; on that representative run the healthy critical path
would still be integration, so the expected end-to-end CI duration remains
about nine minutes. Package and installed checks become separate rerunnable
units with their real artifact dependency instead of one opaque unit.

The beta.18 release run `35577127123` spent 1:40 installing, testing, building,
validating, archiving, and saving its first prepared cache before publication.
The exact-SHA candidate removes that repeated first-attempt preparation while
preserving the existing minimal retry behavior. Expected first-attempt release
saving is therefore about 1:40 on the measured baseline; registry publication
and clean-install verification remain unchanged.
