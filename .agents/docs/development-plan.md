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

Status: protocol and i18n kernel are landed; the structured runtime, private
adapter, manager diagnostics, demo, and live-smoke expansion are implemented in
the current delivery slice following
[`data-contribution-routing.md`](data-contribution-routing.md).

Dependency and PR order is fixed:

1. land this architecture and validation plan in `cordisx`;
2. land `LocalizedText`/`MessageRef` plus the implementation-independent UI
   descriptors, schemas, compatibility rules, and conformance vectors in
   `cordisx-protocol`;
3. land the usable i18n v1 `LocalizationKernel`, read-only document locale
   adapter, fiber-owned dictionaries, typed translator seats, and reactive page
   bindings in `cordisx`;
4. land command, structured-surface, route, page, and outlet registries against
   that real kernel together with the private adapter, manager diagnostics,
   demo, simulated DOM coverage, and isolated real `app://` smoke as one
   reviewable runtime/adapter delivery PR; focused unit tests may inject a
   deterministic fake kernel;
5. update exact owning-repository gitlinks in `cordisxmono` only after the
   compatible commits are pushed and verified.

The architecture, protocol, kernel, and runtime/adapter PRs are explicit stacked
review boundaries but remain one compatibility unit: no public shell
contribution may land without its protocol and kernel, and no route may be
exposed without a page and a declared outlet.

Scoped validation includes schema/conformance checks; registry identity,
ownership, conflict, order, `when`, disabled, command loading/error, and update
tests; route matching and parameter checks; internal history/back/close;
same-context anchor replacement with state retention; different-context abort;
overlay geometry and portal fallback; native DOM non-replacement and layout
non-disturbance; canonical locale resolution, exact/language/default fallback,
fiber-owned dictionary replacement/unload, ICU parameters, missing-key/params
diagnostics, typed seats and page bindings, and locale-version reprojection
through the real kernel integration while focused unit tests may inject a fake;
plugin block/restore and generation disposal; plus real sidebar, session,
panel, locale, and native-data-flow probes. CordisX language-preference UI,
remote dictionaries, extraction tooling, pseudo-locales, capability enforcement,
signing, installation, marketplace activation, and untrusted-code isolation
remain explicitly out of scope.

## Stage 3 — authority and distribution

### Functional CLI home-config slice

Status: implementation follows
[`distribution-and-cli.md`](distribution-and-cli.md). This is the functional
CLI boundary between the monorepo foundation and later public release/native
distribution work.

The slice owns `cordisx setup`, implicit first-run setup, `cordisx config`,
`cordisx doctor`, host/profile launch parsing, strict and atomic
`~/.cordisx/config.json` persistence, a host-neutral resolved launch plan, and
the first Codex adapter projection. A missing named profile is persisted as an
isolated profile; the default profile is shared; the generated plugin list is
empty. Other host ids fail explicitly until a launch-capable adapter exists.

Validation covers setup idempotence, invalid/unsupported configuration
preservation, user-only permissions, option/profile/default precedence,
shared and isolated data-root projection, unknown adapter diagnostics, host
argument separation, no-launch doctor/config behavior, package contents, a
temporary tarball installation, and focused shared/isolated Codex live smoke.
Publication, the plugin scaffolder, native UI, signing, notarization, updates,
marketplace activation, and capability isolation remain separate slices.

### Platform capability v1 slice

Status: architecture approved; implementation follows
[`platform-capabilities.md`](platform-capabilities.md).

This slice defines the manifest capability vocabulary, Permission Broker,
adapter-neutral model/task/turn API, manager permission projection, controlled
read-only projection adapter, and honest unavailable default. It does not
claim a sandbox or a live Codex request binding. The protocol PR lands first,
the compatible host PR lands second, and the mono pointers update last.

The future current-connection adapter is separately blocked on a stable
host-private request-client seat. Direct `electronBridge`, `mcp-request`,
`connect-app-host`, a second AppServer, or bypass of native scheduling and
stream coordination are not acceptable substitutes.

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
