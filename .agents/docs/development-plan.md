# CordisX development plan

The work is split so each change has one reviewable responsibility and a focused validation boundary.

## Stage 0 — feasibility spike

Status: implemented in this repository.

- Bundle configured TypeScript plugins with one browser Cordis runtime.
- Launch or attach to Codex over loopback CDP.
- Launch a project-stable second Codex with isolated Chromium/window state, shared Codex configuration, and deterministic process cleanup.
- Install and remove the renderer bootstrap.
- Mount and dispose DOM contributions through the DSH-style `ctx.slots.inject()` / `ctx.slots.register()` surface.
- Prove anchor replacement remounts a contribution and runs cleanup.

Validation: TypeScript, configuration tests, DOM lifecycle tests, and dry-run bundle construction.

## Stage 1 — adapter hardening

Recommended PR boundaries:

1. Add Codex version discovery and a checked adapter catalog.
2. Add DOM fixture snapshots for every supported version family.
3. Add live smoke probes that report present, missing, and ambiguous anchors without changing UI.
4. Add diagnostics export with secrets and user content excluded by construction.

Validation: fixture tests per adapter and one opt-in live smoke per supported Codex version.

## Stage 2 — developer experience

Recommended PR boundaries:

1. File watching and generation-based browser bundle reload.
2. A local manager UI for plugin enablement and mount failures.
3. Plugin package manifests, dependency graph display, and compatibility declarations.
4. State handoff between compatible plugin generations.

Validation: generation race tests, last-good rollback tests, and a real browser HMR test that verifies cleanup and state retention independently.

### Current experimental manager slice

Status: implemented and live-verified as an experimental renderer-local slice
on 2026-08-23. The remaining Stage 2 items below are not implied complete.

This slice is one `cordisx` implementation PR and does not change the normative
`cordisx-protocol` contract. Its dependency order is:

1. inject package-version metadata into the renderer composition;
2. add runtime plugin state and slot-registration attribution/introspection;
3. add reversible runtime block/restore operations;
4. mount a host-owned sidebar trigger through the Codex adapter;
5. render version, extension-point, and searchable plugin-detail views;
6. verify cleanup and live placement in an isolated Codex renderer.

The PR boundary ends at already-bundled trusted plugins and profile-local
activation state. Follow-up PRs separately own manifests/dependency graphs,
launcher-backed persistent configuration and HMR generations, then enforced
authority and distribution. The manager must not imply those later features
already exist.

The marketplace-discovery follow-up is implemented on its compatible
protocol/catalog/site/host branches. It adds validated multi-feed browsing and
profile-local feed configuration, reuses second-level detail navigation for
both installed and discovered plugins, keys cross-feed entries by canonical
`(source, id)`, and remains read-only until authority and distribution
contracts are implemented.

The manager navigation contract for this slice is:

1. reserve one fixed-size leading control in every page header, using a page
   icon at the primary level and an icon-only accessible back action at deeper
   levels so title geometry stays stable;
2. make installed-plugin detail a tabbed second-level page whose default tab
   safely renders the adjacent bundled `README.md`, followed by configuration,
   runtime-state, and attributed-extension-point tabs;
3. make general CordisX configuration a primary tabbed page split into
   marketplace sources, runtime/profile state, and the launcher-owned
   read-only configuration boundary;
4. keep these tabs as private manager navigation rather than public slot or
   protocol contracts.

Scoped validation for this slice includes TypeScript and the complete unit
suite, DOM integration coverage for trigger placement, tabs, search,
list-to-detail navigation, block/restore, slot attribution, generation
disposal, feed validation, ordered-source persistence, failure isolation, and
cross-feed deduplication. Because the live `app://` renderer rejects direct
remote fetches, validation also covers the launcher's private, public-HTTPS-only
feed bridge, non-public-address and redirect rejection, response limits, and an
opt-in live smoke and screenshot against the current isolated Codex host.
Manager navigation validation additionally checks identical primary/back
leading-control geometry, accessible icon-only back navigation, README
rendering without HTML interpretation, plugin-detail tab state, and the three
configuration tabs.
Installation, signature, capability, and untrusted-code execution tests remain
out of scope because discovery never executes catalog entries.

## Stage 2.5 — structured shell contributions and page outlets

Status: architecture approved; implementation follows
[`data-contribution-routing.md`](data-contribution-routing.md).

Dependency and PR order is fixed:

1. land this architecture and validation plan in `cordisx`;
2. land implementation-independent descriptors, schemas, compatibility rules,
   and conformance vectors in `cordisx-protocol`;
3. provide or stack the minimal localization-kernel contract required to
   resolve `LocalizedText` and notify projection changes;
4. land the compatible command, structured-surface, route, page, outlet,
   adapter, manager-diagnostics, and demo implementation in `cordisx`;
5. complete simulated-DOM tests and an isolated real `app://` renderer smoke;
6. update exact owning-repository gitlinks in `cordisxmono` only after the
   compatible commits are pushed and verified.

The implementation PR may use internal commits for registries, private adapter
outlets, manager diagnostics, and the demo, but they remain one compatibility
unit: no public shell contribution may land without its protocol and no route
may be exposed without a page and a declared outlet.

Scoped validation includes schema/conformance checks; registry identity,
ownership, conflict, order, `when`, disabled, command loading/error, and update
tests; route matching and parameter checks; internal history/back/close;
same-context anchor replacement with state retention; different-context abort;
overlay geometry and portal fallback; native DOM non-replacement and layout
non-disturbance; message-reference retention, missing-key diagnostics, and
locale-version reprojection through an injected localization-kernel test
double; plugin block/restore and generation disposal; plus real sidebar,
session, panel, and native-data-flow probes. Full dictionary registration, ICU
compilation, language preferences, resource loading, extraction, pseudo-locales,
capability enforcement,
signing, installation, marketplace activation, and untrusted-code isolation
remain explicitly out of scope.

## Stage 3 — authority and distribution

Recommended PR boundaries:

1. Define versioned capabilities and host-issued grants.
2. Move untrusted plugin logic out of the Codex renderer.
3. Add signed package identity, immutable artifacts, and atomic activation.
4. Add a marketplace only after enforcement and rollback are operational.

Validation: deny-by-default capability tests, origin and signature tests, compromised-plugin scenarios, atomic publication tests, and rollback after failed activation.

## Stage 4 — upstream-compatible bridge

Package portable task UI as standard MCP UI resources. A CordisX package may carry both:

- an official MCP server/UI entry for conversation-owned experiences; and
- an optional CordisX shell entry for local host augmentation.

The two entries must feature-detect capabilities and remain independently usable. The MCP path must not require CordisX.
