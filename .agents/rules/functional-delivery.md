# Functional product delivery

Use this rule for user-visible Manager pages, launcher flows, renderer bridges,
and interactive previews. It complements the architecture and visual rules.
An intermediate preview, a verified production path, and formal delivery have
different evidence requirements; name the stage before reporting readiness.

## Start from a requirement ledger

Translate the request and every later correction into one ledger before
editing. Keep user-visible behavior separate from implementation dependencies.
Record implementation state and the evidence for validation, merge, and user
acceptance separately. `implemented` means code exists on the named candidate;
`verified` requires named evidence for the claimed path and scope. Record a
formal owning-repository merge by its exact SHA. Only explicit user acceptance
establishes `accepted`. A merged item may still lack real-App verification or
user acceptance; keep those gaps visible instead of promoting a single state.

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

Choose validation for the behavior and claim:

| Change or claim | Required evidence |
| --- | --- |
| Documentation only | Diff and applicable document/link checks |
| Presentation-only intermediate preview | Correct source/configuration and visible intended change; follow the active pure-style window below |
| Parser, state, operation, protocol, or other behavior change | Meaningful focused checks plus the normal owning-repository `npm run check`; add or update tests where the behavior or regression risk requires them |
| Launcher, DOM-adapter, native-surface, or lifecycle change claimed production-usable | Production composition integration plus a real isolated `app://` flow through the affected controls, with scoped cleanup evidence |
| Formal delivery | Applicable validation above, required PR CI, exact-head merge and remote-main readback, and the authorized compatible-set handoff |

The production smoke asserts positive usability, not mere presence. For
example, an action must be enabled and produce the intended safe refreshed
projection. Empty-state smoke also verifies persistent task controls. JSDOM,
Playground fixtures, or a manually injected token cannot establish native
integration. Record unavailable evidence as a remaining gate; do not fabricate
a fallback or claim formal readiness to bypass it.

## Keep preview launches honest

### Intermediate preview

A feature-branch or dirty worktree may provide a useful intermediate preview.
Playground, a development site, and a real App are valid preview surfaces with
different evidence limits. A preview does not require formal main, CI, or a
real-App gate before the user can inspect the work.

Before reporting `可预览` or `PREVIEW_READY`, identify the owning repository,
source SHA and dirty state, exact configuration, URL or App renderer, relevant
process/lifetime, data source, unavailable capabilities, and checks deferred.
Verify that the surface reflects the intended source. Label feature-head
upstream inputs experimental; they are not formal consumer dependencies.
A successful page load proves availability only, not functional verification
or acceptance. Use the same preview during feedback when practical.

### User-led pure-style iteration

When the user is actively reviewing an existing preview and the change is
limited to presentation (spacing, typography, color, geometry, or non-semantic
motion), make the narrow edit, restore compile/HMR visibility if needed, and
report `FEEDBACK_READY`. Automated tests and independent review are deferred
during that feedback window; they do not block the user's next inspection.
The user remains the only acceptance authority.

The window ends when the user ends active styling review or feedback changes
behavior, accessibility semantics, security, permissions, public contracts,
persistent data, lifecycle, release, or another high-risk surface. On exit,
perform the applicable checks once for the final change. Add or update tests
only when behavior or regression risk requires them. Preserve explicit
acceptance separately from validation; silence or a visible preview is neither.
This matches the pure-style workflow owned by CordisXMono and does not activate
responsible-manager mode for a single-owner task.

### Native launch and production proof

`CORDISX_HOME` scopes CordisX configuration and state, not Host login identity.
The normal `shared` mode starts an independent Host process and CordisX-scoped
Chromium profile while sharing the existing Host account/configuration roots.
`--system` explicitly selects the normal system Chromium profile; advanced
`host-isolated` mode uses separate Host roots. See the
[launch-mode reference](../docs/distribution-and-cli.md#independent-cordisx-launches-and-explicit-host-root-isolation).

For a native preview, verify its selected config/profile, source provenance,
and first renderer-injection acknowledgement. Identify an Electron process
tree as one Host instance rather than claiming it is one operating-system
process. Leave the owning launcher alive while the preview is in use; it owns
RPC, service, and cleanup lifetime. Clean up only temporary resources owned by
the completed validation run. Existing shared previews and unrelated Host
processes are not cleanup targets.

Electron cannot add CDP to an already-running process that lacks it. If an
explicit system-profile launch encounters singleton hand-off without injection,
report the launch as unavailable and require a normal cold restart. Never copy,
symlink, or concurrently open the system Chromium profile to avoid a login
prompt. A helper may wait for the user to exit normally before a cold launch;
do not kill the Host from the task that depends on its app-server.

### Formal experience or delivery

Before reporting a production path as verified, name the candidate and the
production/native evidence above. Before reporting a formal experience build,
verify the intended formal Host main and compatible formal dependencies,
selected config/profile, runtime provenance, and applicable delivery gates.
Use `可预览`, `生产路径已验证`, or `正式交付` rather than an unqualified `可体验`
that leaves the evidence level unclear. None of these labels supplies missing
authorization to publish, merge, deploy, or start additional user-owned tasks.

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
- Final consumers update their branch from their own repository's formal main
  and consume provider changes through exact formal dependency commits. An
  explicitly experimental preview is not a final dependency or mono baseline.
- Shared Manager DOM, launcher assembly, and live-smoke scripts each have one
  active owner at a time.
- A CI success is fenced to its exact source head and base; re-run after a
  rebase.
- Read back PR state, fetched `origin/main`, and `git ls-remote` after merge.
- Update the mono gitlinks only after the complete compatible set is formally
  merged.

Final reporting keeps `implemented`, `verified`, `unavailable`, and `planned`
distinct and cites the evidence for every user-visible claim.
