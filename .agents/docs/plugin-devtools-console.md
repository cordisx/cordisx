# Plugin DevTools Console

The plugin detail `运行状态` tab is a development Console, not a telemetry or
compliance warehouse. It renders a bounded, live, time-ordered stream plus a
small call summary. Lifecycle and adapter diagnostics remain available as a
secondary collapsed region.

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

Luna Log `0.1.0` and Luna Text Viewer `0.2.1` are pinned, locally bundled
MIT-licensed renderers. Luna Log's published API accepts a string log and
`append(string)`; it does not expose an object-tree or entry-row API. For that
reason the Log component is the only Console body DOM: CordisX projects safe
`args[]` snapshots, format substitution, object/array trees and Error stacks
into one escaped multiline Luna stream instead of layering custom rows over it.
The optional Inspector contains Host ownership/correlation/call metadata only
and never repeats arguments or lets a plugin provide renderer nodes.

The Log scroll element has intrinsic content height and a bounded maximum
viewport. Only the empty state receives a minimum height. Follow-latest is
preserved across live rerenders only while the viewer is already at the bottom;
scrolling upward exposes an explicit return-to-latest action. Luna instances
and resize observers are destroyed on rerender, route change and Manager
dispose. Light/dark selection comes only from the shared `HostThemeProjection`
and its `data-cordisx-app-theme` / `--cx-*` tokens; the Console has no private
system-theme detector. There is no CDN dependency.

Automatic Host summaries omit prompt/message/content, credentials, secrets,
tokens, URL/path/CWD values and raw response bodies. Snapshotting does not
invoke getters, bounds depth/items/previews/stacks, degrades circular values,
BigInt, functions, DOM values and hostile proxies safely, and must never alter
plugin execution.

The v1 store is memory-only and bounded to 2,000 rows per plugin per runtime.
The Manager can pause its view, filter, copy or clear the current plugin buffer.
There is deliberately no compliance export, renderer filesystem access, or
long-term analytics retention.
