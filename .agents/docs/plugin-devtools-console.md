# Plugin DevTools Console

The plugin detail `运行状态` tab is a compact, structured availability summary,
not a telemetry or compliance warehouse. The `日志与诊断` tab is the development
Console: it renders a bounded, live, time-ordered stream. It may append a
collapsed actionable diagnostic disclosure, but never duplicates the runtime
status, counters, performance summary, service list, or localization details.

The implementation conforms to `@cordisx/protocol` main
`843818755142fcdeb13867a9cea068672855c49e` and its
`cordisx.plugin-console-entry/v1` / `plugin-console-page/v1` schemas. Console
entries retain `method + args[]`; the Host creates recursive safe snapshots for
objects, arrays and Errors. The one-line text projection is not the data model.

## Attribution and instrumentation

At plugin composition time, the Host creates an opaque principal object and
stores its immutable owner, plugin generation and runtime generation in a
private `WeakMap`. The plugin child `Context` and every capability closure carry
that object. Renderer arguments cannot replace owner or generation fields.
Borrowing another plugin's facade therefore remains charged to the facade's
issuer. There is no implicit cross-plugin delegation API in v1.

`PluginConsoleAspect` is the single middleware used by Host capability facades.
It validates the issued principal, creates a correlation id, appends requested
and permission decisions, marks dispatch at the actual Host boundary, and only
then records the real returned success, failure or cancellation. Permission
and Agent ledgers remain authoritative; the Console projects related rows and
does not create a second ledger.

The launcher separately bundles each plugin inside a lazy lexical function
whose `console` parameter is an owner-scoped facade. This captures normal
`debug/log/info/warn/error(...args)` without patching the renderer global
console. Host-registered command, page, route, settings subscription and config
renderer callbacks are restored through generation-fenced execution wrappers.

Promise chains returned directly from a wrapped callback keep their explicit
frame until settlement. When concurrent work makes a correlation ambiguous,
the Console omits the correlation rather than guessing. Browser Async Context
is not assumed and Node `AsyncLocalStorage` is not available in the renderer.

## Coverage truth

These boundaries are architecture documentation, not persistent product copy.
The normal Console page does not display a generic capture-coverage notice.
Only a concrete attribution conflict or renderer failure may produce a
dismissible, actionable status tied to the observed problem.

- `host-mediated`: strong attribution from an issued capability token.
- `scoped-console`: strong attribution while plugin module code or a wrapped
  Host callback uses its lexical Console facade.
- `best-effort`: reserved for uniquely attributable error-boundary projection.
- `unknown`: shared/unattributed errors; these are not inserted into a plugin
  success-rate denominator.

Saved references to the original global console, direct DOM/network behavior,
third-party asynchronous work detached from a Host registration, and callbacks
that escape the scoped facade cannot be reliably attributed in the trusted
shared renderer. CordisX does not monkey-patch Codex's console and never labels
those blind spots as complete observation. Accurate capture of all behavior
would require a future per-plugin realm with realm-owned console, error and
network/tool proxies.

## Rendering, privacy and lifetime

The original `luna-log@0.1.0` integration was rejected because that terminal
viewer accepts only `log: string` / `append(string)` and reduced the entire
Console to one text blob. The production body now uses Luna Console `1.3.6`
with its pinned Luna Object Viewer `0.3.2`, Data Grid `1.6.5`, and DOM Viewer
`1.8.4` peers. Each Host record is inserted as one Luna log with its own method,
argument array, timestamp and source header. The list shows second-level time
only; selected-entry details, copy, and export retain the complete timestamp.
Luna owns level presentation,
repeat folding, selection, virtual viewport, format substitution and expandable
safe objects. CordisX does not create ASCII trees, giant text streams, `<pre>`
fallbacks or parallel record rows. The optional Inspector contains only Host
ownership/correlation/call metadata and never repeats arguments or lets a
plugin provide renderer nodes.

The Luna Console scroll element has intrinsic content height and a bounded
maximum viewport. Only the empty state receives a minimum height. Follow-latest
is preserved across live rerenders only while the viewer is already at the
bottom; scrolling upward exposes an explicit return-to-latest action. Luna
instances refresh their virtual viewport after insertion, tab visibility, and
container resize; resize observers are destroyed on rerender, route change and
Manager dispose. Light/dark selection comes only from the shared
`HostThemeProjection` and its `data-cordisx-app-theme` / `--cx-*` tokens; the
Console has no private system-theme detector. There is no CDN dependency.

Pause/resume, follow-latest, clear and copy are Host-owned 30-pixel Material
icon controls using the common Manager icon-button state and tooltip system.
Pause and follow are independent toggles, copy is disabled without a selected
Luna entry, and clear is explicitly exposed as irreversible.

Automatic Host summaries omit prompt/message/content, credentials, secrets,
tokens, URL/path/CWD values and raw response bodies. Snapshotting does not
invoke getters, bounds depth/items/previews/stacks, degrades circular values,
BigInt, functions, DOM values and hostile proxies safely, and must never alter
plugin execution.

The v1 store is memory-only and bounded to 2,000 rows per plugin per runtime.
The Manager can pause its view, filter, copy or clear the current plugin buffer.
There is deliberately no compliance export, renderer filesystem access, or
long-term analytics retention.
