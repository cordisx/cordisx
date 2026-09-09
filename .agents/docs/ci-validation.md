# CI validation and diagnosis

Use the [organization risk-tiered gates](https://github.com/cordisx/cordisxmono/blob/main/.agents/rules/risk-tiered-gates.md)
for evidence requirements. This guide describes the Host workflow that implements them.

## Pull-request scope

`scripts/ci-scope.sh` classifies the merge-base/head diff. It includes deleted
paths and both sides of renames, using NUL-delimited paths. Empty diffs or a
failed scope job retain the full gate. `scripts/ci-scope.test.mjs` exercises real
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

## Diagnose a long run

Inspect the run attempt, head SHA, and active step before rerunning anything.
The full job exposes the same ordered commands as `npm run check` as separate
steps: clean development, typecheck, build, tests, release metadata, package
contents, and installed packages. GitHub records a duration for each step.
Installation still runs lifecycle scripts, and package/installed checks remain
serial because they share generated outputs and exercise real installations.

Compare the slow phase with recent successful runs of the same gate. Read its
logs when duration or output suggests a stall; distinguish runner queue time,
installation, test execution, and a failed/retried attempt. Repeatedly querying
an unchanged run does not produce new validation evidence. Report phase changes,
failures, completion, or a diagnosed delay instead of repeating unchanged status.
Do not restart healthy checks or rerun an unchanged full gate just to refresh a
status message. Changing the head SHA requires fresh applicable evidence.
