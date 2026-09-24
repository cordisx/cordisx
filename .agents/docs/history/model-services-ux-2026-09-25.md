# Model services UX handoff - 2026-09-25

This is the owner-local implementation record for UX-1 through UX-5 from the
model-services experience request. It is not a product contract or release
record.

## Source and ownership

- routeTaskRef: `client-new-thread:bb28bc30-07a4-4fa7-b3e1-fef972750bcc`
- coordinator: `01a095b6-4e9b-7341-8a17-f6d206e7f6ad`
- formal Host main: `bc54b83790ba07e28d76a7aafee929b2d5b7954a`
- experimental input: `2a9fccd2209966780f68807867476566d2fc706b`
- branch: `codex/model-services-ux-20260925`
- worktree: `/private/tmp/cordisx-model-services-ux-20260925`

The change owns only the Manager model-services components, their feature
styles, adjacent UI helpers/copy, and focused fixtures/tests. It does not own
catalog eligibility, preference persistence, provider configuration storage,
startup/navigation, plugin code, release packaging, or Mono gitlinks.

## Behavior ledger

- UX-1: provider groups start collapsed; manual expansion survives ordinary
  catalog refreshes; open provider headings remain sticky in the results scroll
  owner.
- UX-2: use the Host disclosure language also consumed by the Aiden and TraeX
  plugin pages, while keeping the richer model-service header and Host-owned
  keyboard semantics.
- UX-3: reserve action geometry and reveal commands on hover, keyboard focus,
  open state, or non-hover/touch input.
- UX-4: search the complete compatible projection and replace manual show-more
  clicks with bounded continuous rendering in the existing results scroller.
- UX-5: present search, visibility filter, add, and refresh as one compact tool
  group. Search temporarily reveals matches and clearing it restores the manual
  expansion state.

PREF integration consumes only the existing exact binding/model scoped
`setOverlay` capability until its owner supplies a revised contract. CAPS
integration displays the supplied `selectable`, `blocked`, and `present`
distinctions without treating unknown capability as supported.

## Evidence limits

Focused renderer tests and the catalog HMR/browser fixture are appropriate for
this branch. Fixture screenshots are not native App verification, user
acceptance, formal merge, installation, packaging, or publication.

`coordinatorContinuationRequired=true`

`coordinatorMayComplete=false`
