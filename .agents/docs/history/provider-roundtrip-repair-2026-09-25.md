# Provider Roundtrip Repair, 2026-09-25

Status: local candidate. This record preserves implementation and fixture evidence; it does not establish native App acceptance, merge, publication, or installation.

## Scope

The candidate repairs stale native `thread/resume` responses that can overwrite a newer provider selection for the same thread. Overlapping model IDs can leave the selected model looking plausible while the selector reads the wrong provider membership.

The production change is limited to `native-model-provider-transport.ts`. It retires older same-thread resume readbacks when a newer resume is observed, the navigation generation changes, or an explicit provider selection is accepted. The last condition also covers canceling a pending cross-provider switch back to the provider already displayed by the transport.

No provider catalog, registry, preference DTO, default selection, routing, selector markup, icons, search, or menu layout behavior changes.

## Checkpoints

- Experimental base: `2a9fccd2209966780f68807867476566d2fc706b`.
- Recovered checkpoint: `9d15e1a3cf7ffe05be0b62ca54a26e78b42220db`.
- Current branch: `fix/provider-roundtrip-repair`.
- Current checkpoint: recorded in the task handoff after commit.

The recovered checkpoint contributed the transport fence and two focused fixture files. Review found one missing client boundary: DeepSeek can remain pending while A is still effective, and selecting A cancels the pending choice without changing the displayed provider. The recovered subscriber guard therefore did not retire an older DeepSeek resume. A focused fixture failed before the correction and passed after accepted explicit selections retired same-thread resumes directly.

## Verification

- Reused recovered evidence: 115 focused tests across six files passed for `9d15e1a`, including roundtrip membership/order/checkmark, reopen, rapid and out-of-order responses, background-thread isolation, native fallback, and first-turn synchronization.
- Added boundary: `tests/native-provider-roundtrip.test.ts` passes all six cases.
- The new cancel-to-displayed-provider case failed before the correction with `deepseek` replacing expected `provider-a`, then passed after the correction.
- File-scoped ESLint passed for the changed transport and fixture.
- File-scoped dprint and `git diff --check` passed.

The focused tests use synthetic native transport and selector fixtures. They do not prove that this race caused the supplied screenshot. The screenshot does not expose the active provider or response ordering, and mixed model brands alone are not provider leakage evidence.

## Remaining Evidence

The installer bundle case remains unavailable because the reused workspace has no built `cordisx/react/jsx-runtime` output; five other installer cases passed in the recovered run. No full build, reinstall, package, publish, native App operation, real model request, or browser/native acceptance was performed. A release owner should collect authorized native provider identity and sanitized request-order evidence before attributing the user report to this race.
