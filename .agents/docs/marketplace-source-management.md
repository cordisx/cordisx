# Marketplace Source Management

## Ownership and boundaries

Marketplace source configuration is Host-owned profile state. A source record
contains one canonical feed URL, an enabled preference, and optional local
plain-text overrides for its name, description, and operator note. These local
fields never enter a Marketplace feed, plugin identity, text-relevance ranking,
Official/Certified evaluation, permission policy, package resolution, or
lifecycle activation.

The public clipboard shape is
`cordisx-protocol/schemas/marketplace-source.v1.schema.json`. The Host also
accepts a bare canonical HTTPS URL as a quick-import shorthand. Imported data
cannot claim `official`, `trusted`, `certified`, or any installation authority.

The built-in CordisX source is derived from the Host's configured trust root,
not from persisted or imported metadata. Its record is always present. Users
may disable or annotate it, but removal is rejected. A disabled source does not
contribute plugins, duplicates, trust projections, or network requests.

## Source store

`BrowserMarketplaceSourceStore` persists ordered records under
`cordisx.manager.marketplaceSources.v2`. On first read it migrates the legacy
v1 URL array:

- URL order and first-wins deduplication are preserved;
- existing URLs become enabled records;
- an absent official source becomes an explicit disabled record, preserving an
  earlier user's choice to omit it; and
- invalid data falls back to the enabled official source without importing
  unvalidated local prose.

The canonical URL is the only source identity. Renaming or annotating a source
does not create a second source or change duplicate precedence. Store mutation
methods normalize before persistence and return immutable snapshots.

## Stale-while-revalidate model

`BrowserMarketplaceModel` owns a bounded last-good cache independently of the
source configuration store. Opening Manager follows this sequence:

1. parse each enabled source's cached raw feed through the current closed feed
   parser and trust evaluator;
2. project every valid cached feed immediately as `fresh` or `stale`;
3. start one background revalidation for the current source generation;
4. deduplicate concurrent reload calls onto that in-flight operation;
5. publish the complete ordered aggregate after the generation returns; and
6. cache only a successfully fetched, size-bounded, schema-valid feed.

Configuration mutation aborts the old controller and increments the generation
fence. A late result cannot publish into the new source list. Disabled sources
remain visible as configuration but never fetch or aggregate.

Transient network failures and HTTP 408, 429, or 5xx responses use bounded
Host-owned backoff. HTTP 4xx, invalid JSON, oversized feeds, unsupported schema,
trust/schema validation failures, and unavailable fetch capability do not
retry. When revalidation exhausts retries:

- a last-good feed remains visible with `phase=stale` and a diagnostic error;
- a source without last-good data becomes `phase=error`; and
- successful sibling sources remain available.

There is no manual-refresh correctness dependency and no React/SWR dependency.
The vanilla TypeScript model exposes `phase`, `stale`, `revalidating`, attempt
count, last-success time, and error as orthogonal data for any Host renderer.
The Manager UI consumes these states through the shared Host form and compact
collection primitives.

## Manager information architecture

The Marketplace primary page is a discovery surface. Its header, search, and
filter chips remain fixed inside the Manager content viewport; only the plugin
results list scrolls. Plugin cards use the full available width and open their
detail route. Documentation and source administration are not primary calls to
action on this page.

An icon action beside search opens one Host-owned, themed menu with three
structured tasks: add a source, import a source file from the clipboard, or
manage existing sources. Source creation is a third-level Manager route.
Existing source cards open a corresponding detail route where the display
name, description, and note can be edited. The URL remains a read-only,
secondary machine field.

Sources use the shared compact collection renderer. Enable/disable is the
direct action; ordering and removal are overflow actions. Removal is disabled
for the official trust-root source with an accessible reason. A normal loaded
source has no status badge. Disabled, refreshing, stale, and failed states use
the collection's icon-seat indicator and accessible description without
squeezing the source name, description, or URL.

Source administration is not a top-level Settings tab and has no manual reload
control. Empty untouched URL fields render no validation error. Submit or user
editing produces concise product validation; native URL constructor messages
never enter the UI. All menus are Host-owned portals with theme, Escape,
arrow-key, focus restoration, outside-click, resize, route-change, and Manager
dispose cleanup.

## Cache limits and cleanup

The raw cache accepts at most the existing 2 MiB feed limit and retains a
bounded 3 MiB most-recent set in profile storage. Persistence is best-effort:
quota or corruption drops cache data, never source configuration. Removing a
custom source prunes its cache. Disabling a source retains last-good data so a
later re-enable can render immediately before revalidation.

## Release validation

The isolated `app://-/index.html` smoke owns a deterministic clipboard path.
`--manager-marketplace-clipboard-exercise` requires a canonical source URL, a
closed-schema feed fixture, and `--generation`. One machine-readable report
must therefore prove that the public `marketplace-source.v1` payload was read
through the actual clipboard action, its profile-local name, description, and
note were persisted and projected in the compact row, the official delete
action remained disabled, and runtime disposal removed every Host surface,
outlet, page, tooltip, style, and Manager trigger. Wide/dark and narrow/light
captures additionally cover discovery scrolling, portal bounds and keyboard
focus, the third-level create route, untouched validation, and responsive
layout.
