# Native debugging and recovery

Maintainer guidance for an isolated CordisX development instance. Choose the
checks that resolve the observed failure; this is not an additional delivery
gate. The September 2026 incidents included experimental Shell and CLI
candidates, so their fixes are not assertions about a published release.

## Identify the launch and the first failing stage

The same installed App executable can serve multiple launches with distinct
Chromium profiles and debug ports. Account isolation is separate: `shared`
retains the real `HOME` and `CODEX_HOME`, whereas `host-isolated` selects a
separate Host home. An independent Chromium profile alone does not isolate
accounts. Follow [startup Q&A](startup-qa.md#what-is-the-difference-between-shared-and-host-isolated)
and the [launcher reference](launcher-runtime.md); do not patch the App.

Compare the effective executable, data mode, profile, CordisX home, project
config and loaded entry with the known working launch. A different working
tree can change a local plugin source identity. Source edits do not update a
launcher using old `dist`; identify which artifact is executing before retrying.

Separate process launch, initial native document/preload readiness, bootstrap,
Vite graph, plugin activation, visible contribution and user interaction.
`ERR_FAILED (-2)` during reload can be an aborted initial document load; it is
not evidence by itself of an account or Room failure. The
[Vite lifecycle reference](vite-native-development.md#native-policy-and-cleanup)
explains initial-document ordering and bootstrap acknowledgement. Inspect the
first failed stage instead of changing data mode, reload strategy and plugin
code together. Fresh-home template hydration can expose generation ordering
that an existing home hides; repair the ordering, not the stale-principal check.

A `renderer ready` log proves that startup stage only. Check that the expected
route/contribution exists and its relevant interaction works before calling the
result usable. If tools explicitly deny native UI access, respect that denial;
do not switch to raw CDP to perform the prohibited inspection or action. A
permitted headless integration harness has its own evidence scope.

## Keep a debug fix experienceable

Use the user's existing authorization for restart/HMR/candidate switches of the
target debug instance. Do not repeatedly pause for disposable drafts when that
tradeoff is already authorized. Preserve persistent data, explicit freezes and
non-target instances. Build replacement Host/CLI artifacts outside directories
watched by the current launch: writing watched output can hot-update it before
the candidate is ready and invalidate the run being observed.

After the switch, keep the reusable launch entry and effective config on the
working combination. Verify the loaded build and the repaired interaction; an
old script, dead launcher or unrelated visible window is not a delivered entry.
Use [the live-development skill](../../skills/cordisx-plugin-development/references/live-plugin-development.md)
for selecting the correct update boundary.

## Recover identity from authority, not live caches

Room persistence, durable Entity definitions, associated Session references and
live Session state answer different questions. Cold-start inspection should
read existing authorized Entity/owner data before deciding that an avatar or
associated conversation is unavailable. Keep history navigable without
creating a new Session or labeling an unknown runtime as active.

A Host-private Session-to-native-thread mapping needs a real access boundary:
caller authority, owner/source/profile scope and verified identity. Reserving a
document name alone is not protection if plugin CRUD can still access it.
Do not reconstruct SessionEvents from a mapping or let a second ledger compete
with the authoritative store. Before an authorized recovery write, re-read its
current revision; an old backup must not overwrite newer user data.

Present available conversations separately from reliable running state. Keep
internal IDs and `unloaded`/`unknown` mechanics in diagnostics, not competing
product lists. Absence from memory does not mean absence from storage.

A Session opened from a plugin page must not capture a hidden Manager as its
return destination. Manager return capture is available only while its modal
is open; otherwise Back returns to the existing plugin route without reopening
an old Manager detail. This is generic Host navigation behavior.

## Trace the affected UI path

A new Shell source version can register successfully while a composer version
gate still rejects it. The experimental v10 composer incident was fixed in
[24498833](https://github.com/cordisx/cordisx/commit/24498833a67952f408daf4bce108aed0a46ccf45).
Trace registration through mounted context, admission and submit for the
version being consumed; test that path and the relevant older branch rather
than inferring usability from registration tests. This is a module regression
lesson, not a requirement to test every historic version for every edit.

For native sidebar regressions, inspect the actual layout parent: moving a
group can lose ancestor padding/gap, and `display: contents` changes which
container owns layout. Compare selected and unselected hover actions, disclosure
size/motion and navigation selection. A stale native route can leave two items
selected; fix the adapter's route/state integration instead of clearing native
classes from plugin code. Use the real affected states for visual evidence.

Code location does not establish product ownership. Trace actual production
consumers and business semantics; several internal callers are not several
products. The Shell was introduced/extended in Host PRs
[#205](https://github.com/cordisx/cordisx/pull/205) and
[#222](https://github.com/cordisx/cordisx/pull/222), removed in
[#270](https://github.com/cordisx/cordisx/pull/270), then restored in
[#335](https://github.com/cordisx/cordisx/pull/335). That history does not settle
future ownership. [Chatroom #74](https://github.com/cordisx/plugin-chatroom/issues/74)
owns the proposed migration; this runbook does not implement it or authorize
removing the current experience.

## Native Vite notification ordering

`vite-development-watcher.ts` owns backend selection and listener startup
ordering; the main Vite module retains plugin graphs and replacement handling.

A successful module fetch is not evidence that its pending file-change event
was delivered. The native Vite integration records only an initial hash during
ordinary loading; only HMR processing advances the acknowledged file version.
Otherwise a request that loads new bytes before the queued change callback can
suppress its own generation replacement. Canonical plugin inputs are registered
before the initial watcher-ready epoch can complete, so an immediate edit after
startup is observed. On macOS the adapter selects Chokidar's `fs.watch` backend:
its FSEvents implementation can emit `ready` before asynchronously registering
the native watch, losing an edit after startup returns. A watcher-ready event
alone must not be treated as proof that this backend can receive the first edit.
The load-before-change regression test controls event
ordering on an isolated real Vite server; it does not add a timing sleep or a
second watcher/transport to the product.
