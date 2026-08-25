# Functional product delivery

Use this rule for user-visible Manager pages, launcher flows, renderer bridges,
and interactive previews. It complements the architecture and visual rules;
it prevents a technically present feature from being reported as usable before
its production composition and real interaction path work.

## Start from a requirement ledger

Translate the request and every later correction into one ledger before
editing. Keep user-visible behavior separate from implementation dependencies.
Each item has exactly one state:

- `unimplemented`: no conforming product path exists;
- `implemented`: code exists on the current candidate;
- `verified`: the intended production path passed named evidence; or
- `formally merged`: the verified candidate is present on owning-repo main.

Do not close the ledger because a partial PR merged, CI passed, a simulator
worked, or a screenshot looked better. Re-read the complete ledger after every
dependency merge and before announcing an experience build.

## Preserve Host and plugin ownership

The Host owns Manager routing, history, breadcrumb, page header, local tabs,
DOM, typography, spacing, theme, focus, and cleanup. A plugin contributes
structured body data, state, and narrow commands. It must not add a second back
button, title, description, tab strip, content shell, or route controller.

Before adding markup, compare the proposed body with the Host header and active
tab. Remove information already established there. A field, select, toolbar,
or card gets one visual shell and one hit target; do not wrap a styled Host
primitive in another bordered control. Icon actions use the shared rounded-
square Host control and an accessible name. Use text only when the label carries
meaning that an established icon cannot communicate.

Browse pages keep search, filters, and create actions outside the list scroll
owner. Results alone scroll. Detail pages use the available content width and
do not introduce decorative max-width gutters or nested cards. Empty data does
not remove the task toolbar: keep search/filter/export structure stable and
disable only actions that cannot run. Follow
[`manager-content-design.md`](../docs/manager-content-design.md) for the full
semantic and visual contract.

Theme and width behavior are implementation inputs, not a final screenshot
ceremony. Use Host semantic tokens from the start; do not patch literal light
or dark colors after a single-theme implementation. Build fluid layout and
overflow ownership into the component before its first functional checkpoint.

## Prove the production composition

Test the layer that assembles the real product, not only its parts. If a
launcher creates a token, handler, service, or capability, a test must show
that the production bundle metadata publishes it, the CDP installer binds it,
the renderer receives it, and the user control becomes operable. A unit test
that manually injects a token cannot prove that the launcher passes that token.

Use this evidence ladder for an interactive path:

1. focused unit tests for parser, state, or operation semantics;
2. an integration test through the production composition entry point;
3. one real isolated `app://` flow that clicks or reads the intended controls;
4. cleanup evidence for the temporary port, profile processes, and runner Home;
5. normal PR CI and exact-head merge readback.

The real smoke asserts positive usability, not mere presence. For example, an
action button must be enabled and produce a safe refreshed projection; three
disabled buttons do not prove three implemented actions. Empty-state smoke
also verifies that persistent task controls remain present.

## Keep preview launches honest

`CORDISX_HOME` isolates CordisX configuration and state. It must not be
described as a new Host login profile. A shared Host launch reuses the stored
system Host profile, but Electron cannot add a CDP port to a process that was
already started without one. In that case, fail clearly and require a normal
cold restart; do not report `ready` when a singleton hand-off exits before the
first renderer injection.

Before announcing `可体验`:

1. verify the checkout is at the intended formal Host main;
2. verify the selected CordisX config and profile;
3. verify no stale CordisX Host instance or private profile process remains;
4. require the first renderer-injection acknowledgement;
5. state whether one Host instance means an Electron process tree rather than
   literally one operating-system process; and
6. leave the launcher alive because it owns RPC, service, and cleanup lifetime.

Never copy, symlink, or concurrently open the system Chromium profile to avoid
a login prompt. If the current Host was not launched with CDP, an external
terminal or helper may wait for the user to exit it normally and then perform
the cold shared launch. Do not kill the Host from the task that depends on its
app-server.

## Prefer function before hardening without fabricating safety

When product direction explicitly prioritizes usability, first complete the
smallest honest functional path: writable configuration, real action dispatch,
readback, stable empty states, and a usable preview. Defer additional attack
audits, CAS refinements, and uncommon failure hardening as named follow-ups.

This ordering does not permit secret exposure, false availability, or an
unsafe fallback. Credentials remain Host-private; unavailable bridges remain
unavailable; a feature-head dependency is never presented as a formal
consumer baseline.

## Merge and handoff discipline

- Observable protocol changes land before Host consumers.
- Consumers rebase only on formal merge commits, never feature heads.
- Shared Manager DOM, launcher assembly, and live-smoke scripts each have one
  active owner at a time.
- A CI success is fenced to its exact source head and base; re-run after a
  rebase.
- Read back PR state, fetched `origin/main`, and `git ls-remote` after merge.
- Update the mono gitlinks only after the complete compatible set is formally
  merged.

Final reporting keeps `implemented`, `verified`, `unavailable`, and `planned`
distinct and cites the evidence for every user-visible claim.
