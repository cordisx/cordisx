# Host Manifest Startup Window

Date: 2026-09-23. Historical delivery ledger, not release or user acceptance.
Current behavior reference: [launcher runtime](../launcher-runtime.md).

## Scope And Requirements

- START-1: Retry only ordinary fetch failures for the exact launch-owned local
  manifest, every 250ms for at most 10 seconds within the existing startup budget.
  Refusal is not classified as transient and Host policy is never overridden.
- START-2: HTTP, JSON/schema validation, graph import and activation fail once.
  Accepted manifest entries stay within the owned graph; redirects are rejected.
- START-3: Deadline, launcher cancellation and disposal abort renderer fetch and
  timers. Late fetch/JSON/import results cannot initiate activation. Existing
  activation receives cancellation and cannot subsequently mount another plugin
  or publish readiness. Disposal drains it with a bounded cleanup failure.
- START-4: Preserve bounded CDP policy diagnostics for persistent rejection.
  Keep public plugin contracts, release metadata and user profiles unchanged.
- START-5: Source tests and exact-head CI/merge are distinct from the reserved
  one-attempt isolated native release acceptance. No original-user recovery claim.

## Implementation

Implemented, not yet merged. Extract the small generated bootloader, add an owned AbortController
and bounded manifest window, defer entry activation until after cancellation
checks, and connect the existing production wait/disposal and runtime lifecycle.
Change the static graph cache identity so an old eager-activation entry is not
reused. No new dependency or private Host readiness API.

## Evidence

The pre-fix synthetic probe demonstrated failure for readiness at 500ms and
identical fetch observations for persistent refusal. This establishes a timing
limitation, not the real incident's policy state or incident-time Host version.

Local checks passed: 41 focused bootloader/network/CDP/runtime-cancellation tests,
29 existing admission/bootstrap/lifecycle tests, one real runtime cancellation
regression, three production Host graph build/cache tests, and one isolated
Chromium native-fetch cancellation/late-ESM test. Other browser tests were not
selected locally; they remain CI coverage, not local passes. No native Host App
was launched. Formatting, new-file lint and diff whitespace checks passed.
Local typecheck reports existing mixed Vite/Rolldown
dependency identity failures in vite-development.ts; no clean local typecheck
claim. CI with the repository lockfile remains required.

PR, exact-head CI, formal merge, publication and isolated native acceptance:
pending. User acceptance and original-instance recovery: unverified.

## Follow-up: Production Entry Export

The preceding pending statuses describe the original implementation checkpoint.
That change subsequently merged as PR #476, squash
`87981a19b69e889c5818b1b61abed83704721612`, with its exact-head CI passing.
Candidate `6f38dcfb6798d5b112beae74b1c054447b6293c6` then failed native
acceptance. The first attempt stopped at fixture validation before Host spawn.
The authorized replacement fetched the manifest and two ESM responses with HTTP
200, but failed with `TypeError: module.boot is not a function`; runtime and
readiness remained false. Both attempts remain failures. Permission/CSP
restoration was observed and owned resources removed; two helper processes
needed SIGTERM escalation.

### Cause And Regression Coverage

The retained observer only forwards CDP arguments/results and records existing
events; the empty fixture does not replace graph modules. A separate Node-only
reproduction, with no observer or App, used the unchanged installed candidate
builder and its Vite 8.2.2 dependencies. Its generated entry
`host-YXHuQHc0.js` (SHA-256
`49da1ac239acfbe5537dae0d2de84f21f56a9e658b50fe4a91279075a36bd9d1`)
exported only `t`, not `boot`. These are regenerated candidate bytes, not
bytes retained from the cleaned native run.

The virtual entry declares `boot(signal)`, and the bootloader calls that named
export. Vite's non-library application build defaults
`preserveEntrySignatures` to false. The Host builder omitted the strict
override already used by the plugin builder, so its output did not preserve the
caller contract. The repair sets that override and changes the static cache
identity to exclude already-cached broken entries. No generated activation,
runtime cancellation, manifest retry, permission or public plugin contract
behavior is changed.

CI missed this because the existing real graph test checked HTTP responses,
entry contents, launch-module syntax and cache behavior, but not the emitted
entry exports. The browser cancellation fixture explicitly supplied a
`boot` export; it tested cancellation rather than production bundler output.
The regression now parses the actual entry already built by the graph suite
with the existing ESM lexer, and checks disk reuse, recovered exports and
invalidation of a structurally valid legacy cache record. It adds no separate
build fixture or browser requirement. Before the repair this assertion failed
on formal source with reused Vite 7.3.6 (`[]` exports); after the repair all
three graph tests and 14 bootloader tests passed with candidate Vite 8.2.2.

Follow-up PR/CI/formal merge remain pending at this checkpoint. No additional
native attempt, release or user recovery is established by this source repair.
