# Host testing

Choose checks for the changed behavior and reuse matching CI evidence. A required
`check` means its evidence must pass; it does not require a second local run when
CI already covers the same revision and inputs.

## Local development

| Command                                             | Scope                                                 | Use when                                                                        |
| --------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| `npm test`                                          | Core and renderer module tests; no real browser group | Module feedback after the necessary workspace output is available               |
| `npm run test:affected -- --changed=origin/main`    | Related core and renderer tests                       | Ordinary branch development; use an explicit base for committed changes         |
| `npm run test:integration -- --changed=origin/main` | Related integration tests                             | Service composition, Vite, process, or cross-module behavior changed            |
| `npm run test:browser`                              | Isolated Chrome tests                                 | Browser loading, CSP, caching, CSS lifecycle, or browser-dependent code changed |
| `npm run test:all`                                  | Every Vitest project                                  | Full suite evidence is missing and a local run is specifically useful           |
| `npm run test:ci-policy`                            | Scope selection and test partition regression checks  | CI or test selection changes                                                    |
| `npm run check`                                     | Complete delivery validation                          | Explicit full local reproduction; prefer CI for delivery evidence               |

Tests no longer build packages automatically. Prepare the smallest workspace
closure only if outputs required by the selected tests are missing or stale.
`npm run build --workspace=cordisx` builds the Host closure; `npm run build`
builds all workspaces. Do not build merely because a different test group is next.

`vitest.config.mjs` partitions discovery into core, renderer, integration, and
browser projects. Core catches otherwise unclassified tests so additions are
not silently omitted. These are execution groups, not a claim that every
existing core test is a pure or inexpensive unit test. Move an expensive fixture
to integration when its actual setup requires processes, bundling, or installs.
For local browser evidence, set `CHROME_PATH` and
`RESTRICTED_CHROME_EXECUTABLE` to the same Chrome/Chromium executable. The
restricted-content fixture skips without its variable; a skipped fixture is
not browser evidence. CI sets both and fails if Chrome is unavailable.
Native App smoke remains a separate explicit command, not an ordinary test
prerequisite. Missing local Chrome does not block unrelated Node/service work.

## CI execution

The scope job classifies the diff, including deleted and renamed paths. Ordinary
PRs use Vitest's dependency-based `--changed` selection within each Node group.
Dependency changes run all Node groups because dynamically resolved packages
cannot be inferred reliably from source imports alone; they request package
checks without automatically requesting the complete release gate. Browser
source/test paths and known browser dependency changes select the browser group.
Main pushes run all groups and complete delivery checks.

A single prepare job installs Git dependencies with their required lifecycle
scripts and builds the selected closure. The same-run Linux artifact contains
node_modules and workspace outputs, preserving symlinks. Typecheck, test groups,
and package checks restore it instead of independently installing and building.
The lightweight quality job uses installation without lifecycle scripts, and
can run for documentation-only changes without preparing the Host.

Tests run in separate runners with at most three groups active at once; each
group retains one worker to preserve existing port/process assumptions. Browser
CI explicitly locates Chrome and supplies both browser fixtures' environment
variables. Per-group JSON reports include test durations for later balancing.
The `full` status aggregates selected jobs; failures and cancellations cannot
be reported as successful coverage. An excluded group is not a passing result
for that group. Release/Mono evidence must include the complete selected set.

## Assess test necessity

For a new or materially expanded test, identify the observable regression it
catches and choose the least expensive layer that can detect it. This can be a
short test description or PR explanation, not a separate approval form.

- Use module tests for parsing, state transitions, routing decisions, and mocks
  of external responses. Do not launch Chrome for service/model registration.
- Use integration tests for actual cross-module wiring or process behavior that
  module assertions cannot detect. Reuse setup within a compatible suite.
- Use real browsers for browser semantics; DOM fixtures cannot prove CSP or
  native module loading. Do not duplicate the entire business suite there.
- Use native App smoke for the actual native boundary and relevant user flow.
  Browser success cannot stand in for that evidence.
- Merge duplicate coverage or move expensive assertions down a layer when they
  detect the same regression. Do not delete a test merely because it is slow.
- Before repeating a local heavy check, name the unresolved failure or evidence
  gap. Stop when it is resolved; waiting for CI is not a reason for more runs.

For parallelism, first isolate ports, temporary directories, persistent state,
and subprocess cleanup. Different worktrees do not isolate machine resources.
Local heavy installs/builds remain serial; CI runner parallelism is independent.
