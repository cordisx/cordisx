# CordisX development plan

The work is split so each change has one reviewable responsibility and a focused validation boundary.

## Stage 0 — feasibility spike

Status: implemented in this repository.

- Bundle configured TypeScript plugins with one browser Cordis runtime.
- Launch or attach to Codex over loopback CDP.
- Install and remove the renderer bootstrap.
- Mount and dispose DOM contributions through semantic slots.
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
