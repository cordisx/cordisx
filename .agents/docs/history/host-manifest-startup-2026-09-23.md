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
