# Shared dialogs candidate — 2026-09-10

Status: implementation candidate on `codex/shared-dialogs`, not merged or
released. No replacement of the user's running preview has been performed.
This is a historical delivery ledger, not permanent instructions.

Product impact: product-impacting. Baseline: the user's game-room screenshot in
this task and the accepted design discussion. Preserve complex plugin JSX,
React context and business interactions. Host owns the modal frame, header
actions, rightmost close button and structured footer; body is a plugin seat.
Preview status: ready. Independent native harness; no switch of another task's
preview. User acceptance of the rendered replacement remains pending.

| Requirement                                    | Implementation                             | Evidence                                                             |
| ---------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| Fixed Host header/footer and close control     | Structured descriptors, shadow chrome      | Native app verifies rightmost close and CSS isolation                |
| Complex JSX and preserved context              | Declarative portal, registered React mount | Native app verifies state, context and registered body               |
| Owner service, queue, deduplication            | DialogCenter and runtime injection         | Model tests pass                                                     |
| Async actions, close guard, child confirmation | Shared lifecycle manager                   | Model/UI tests; native child confirmation preserves parent state     |
| Form convenience                               | Existing Host draft field renderer         | UI tests pass                                                        |
| Theme, focus, responsive behavior              | Host tokens and native modal               | Dark desktop and light 420×740 preview; Escape and focus return pass |
| Public exports, packaging, documentation       | Protocol/Host feature branches             | Public plugin consumer typecheck; package gates pass                 |
| Existing editor adoption                       | Array editor and marketplace source        | Regression tests pass                                                |

Protocol input is the exact pushed feature commit
`88a08f1b20ab89f33b5ebd0a4791b80dd8271658`,
[Protocol draft PR #138](https://github.com/cordisx/cordisx-protocol/pull/138).
Host manifests and the normally generated npm lock pin that experimental input.
A clean `npm ci` from the remote commit passed; no local provider symlink is
required by Host. This does not claim a merged provider baseline or a formal
Mono gitlink update.

Validation:

- Protocol full `npm run check` passed.
- Host full suite: 328 files and 1,765 tests passed; one file/test skipped.
- Host typecheck, build, release metadata and package allowlists passed.
- Installed-package verification passed after synchronizing its expected
  Protocol SHA. The initial full command stopped on that stale expectation;
  the corrected final stage was rerun separately and passed (tarballs,
  consumer types, CLI, generated plugin layouts and Vite dry-run).
- Focused regression suite: 24 tests passed across six files.
- External plugin consumer typecheck using only public SDK imports passed.
- Changed-file formatting, dialog CSS lint, focused source lint and diff checks
  passed. Existing large runtime modules are not claimed as globally lint-clean.
- Isolated native smoke passed on port 9457, including production injection,
  JSX/context, nested confirmation, notification rendering inside the modal,
  close positioning, narrow layout, external CSS resistance, Escape/focus,
  registered views and renderer disposal. Runner cleanup verified the port
  closed and no profile processes remained.

Native report: `/tmp/cordisx-dialogs-native-final-report.json`.
Full gate log: `/tmp/cordisx-dialogs-final-check.log`.
Installed-stage rerun: `/tmp/cordisx-dialogs-final-installed.log`.
Persistent preview images and a copy of the report are in this task's
visualization directory, named `dialogs-dark.png`, `dialogs-light-mobile.png`
and `dialogs-native-report.json`.

The active game-room task checkout was inspected read-only. Its in-progress
room UI was not changed. Adoption here covers the shared public capability,
a complex plugin example, the array editor and marketplace-source editor;
specialized collection and privileged permission dialogs remain separate.

## Integration update

The user authorized merging and notifying the consuming tasks. Protocol PR #138
merged as `ffb4827fdfee550865b55593fc5b8a1cc51ed53c`; Host now pins that canonical
main commit through its manifests and generated lock. The earlier feature-input
record above remains historical. Host main through `98b6fa6` was merged into the
candidate, preserving the notification-enabled bundled plugins and current CI.
Host PR #395 is the implementation delivery. Integration validation is repeated
against this updated candidate; merge authorization does not claim visual
acceptance or switch the user's running app.
