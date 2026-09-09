# Unified notifications — 2026-09-10 candidate evidence

This dated record covers the feature branch `codex/unified-notifications`,
including implementation revision `3158c0401a3f604727f623f1a8ac584017dd8540`.
It is not a release, merge, or user acceptance record. Current usage and authoring
requirements belong to [Plugin notifications](notifications.md).

## Delivered behavior

- Owner-bound public `ctx.notifications.show` and a Host-owned card surface.
- Clickable plugin icon/name opens the authorized plugin entry and retains the card.
- Severity, message, optional description/action, busy state, close and expandable
  plain-text details with copy support.
- More menu offers category mute, plugin pauses (one hour/today), plugin mute and
  rule management. Rules affect matching visible and queued cards, persist per
  profile and support undo and removal. Notification bodies are not persisted.
- Bounded queue, owner/category coalescing, paused timers during interaction,
  responsive card layout, keyboard menus and generation cleanup.
- Public guide, Protocol reference, installed authoring Skill and new-project
  template explain the API and prohibit custom operation Toasts/page-wide error
  inserts. Field validation and enduring business state remain contextual.

## Verification

Protocol conformance passed. Merge CI additionally exposed a missing distribution
allowlist entry; the correction and packed Notifications consumer check passed
in Protocol PR #137 before its merge. Host typecheck, build and source lint passed (the
lint run retains 20 existing warnings). Release metadata and package allowlists
passed. A full Host suite passed 1,747 tests and exposed three demo metadata
failures and React test teardown errors. After fixing those failures, the five
affected files passed all 28 tests with no unhandled errors. This evidence does
not represent a fresh complete-suite pass after the fixes.

Installed-package verification passed from a fresh temporary install of the
packed CLI and creator. It checked public consumer types (including Notifications
and `ctx.notifications.show`), executable contracts, both creator commands,
standalone/workspace/embedded generated projects and Vite development dry-run.

The maintained `packages/cli/scripts/notification-smoke.mjs` passed seven groups
in an isolated native App profile: source image/navigation; details/retry failure;
mute/suppress/undo; narrow viewport; persisted rule removal; short-card menu
bounds/Escape and queue bounds; renderer disposal. The runner confirmed its CDP
port closed and no profile processes remained. Native checks use synthetic
notifications through the public plugin API; they do not claim live backend
failure coverage for each consumer. Copy behavior is covered by the UI test,
without replacing the user's native clipboard.

Channel, Chatroom, CLIProxy, Pet, Game Room client and Economy wallet passed their
owner checks after migration. Chatroom also passed full-source lint/format checks.
Game Room retains one existing optional skipped test. Each consumer records the
exact build SDK source and artifact hashes in `notification-sdk-evidence.json`;
its notification guide explains archive reconstruction before clean installation.
The compiled SDK is Host `efbff656d84b482d51598bc5ba303d24134e0c62`, with Protocol
`f3e18c925c34d90fdf203c158811cef10f7ebf57`. Subsequent Host fixes preserve that
public consumer interface. No running user Host was replaced.
