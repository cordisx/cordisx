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
The Manager UI consumes these states after its shared form/collection
primitives have formally merged.

## Cache limits and cleanup

The raw cache accepts at most the existing 2 MiB feed limit and retains a
bounded 3 MiB most-recent set in profile storage. Persistence is best-effort:
quota or corruption drops cache data, never source configuration. Removing a
custom source prunes its cache. Disabling a source retains last-good data so a
later re-enable can render immediately before revalidation.
