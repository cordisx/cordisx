# Model services UX handoff - 2026-09-25

This is the owner-local implementation record for UX-1 through UX-5 and the
UX-7 compatibility integration from the model-services experience request. It
is not a product contract or release record.

## Source and ownership

- route: UX-1 through UX-5 and UX-7 compatibility integration
- integration owner: release candidate coordinator
- formal Host main: `bc54b83790ba07e28d76a7aafee929b2d5b7954a`
- experimental input: `2a9fccd2209966780f68807867476566d2fc706b`
- branch: `codex/model-services-ux-20260925`

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
- UX-7: ordinary, selectable, blocked, and removed model surfaces operate only
  on rows with explicit `compatibility: 'supported'`. Supported blocked and
  temporarily unavailable rows remain in the ordinary management list, while
  `selectable` independently controls the selectable filter. Header and status
  counts use the PREF-composed `sourceCount`; compatibility is never inferred
  from `selectable` or `blocked`.

PREF integration consumes only the existing exact binding/model scoped
`setOverlay` capability until its owner supplies a revised contract. CAPS
integration displays the supplied `selectable`, `blocked`, and `present`
distinctions without treating unknown capability as supported.

The compatibility field and count contract was reviewed at PREF checkpoint
`b53a05e4ca939ef1771a34fe2876d005a080e41d` and CAPS checkpoint
`c4f0401cf98d476014c4c785505a1bdc84ba9908`. This branch does not cherry-pick
either checkpoint; the integration owner must combine this UX checkpoint with the
PREF owner's final follow-up SHA and the immutable CAPS input.

## Evidence limits

Focused renderer tests and the catalog HMR/browser fixture are appropriate for
this branch. Fixture screenshots are not native App verification, user
acceptance, formal merge, installation, packaging, or publication.

Changed-file dprint, ESLint, and `git diff --check` pass. A disposable combined
graph of UX `3d41bea`, PREF `b53a05e`, and this UX-7 delta passed 11/11 focused
renderer tests and the 1/1 catalog browser fixture. The standalone UX branch
does not contain PREF's parser update and therefore is not the authoritative
runtime test graph for compatibility-bearing fixture rows.

The retained preview used screenshots under `artifacts/model-services-ux/` in
the owner-local checkout. Existing screenshots remain
representative because UX-7 changes row eligibility and counts without changing
layout or styles.

`coordinatorContinuationRequired=true`

`coordinatorMayComplete=false`
