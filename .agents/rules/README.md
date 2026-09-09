# Maintenance Rules

- Preserve the separate-process, loopback-CDP architecture and never modify the installed Codex application.
- Keep all plugin contributions reversible on the owning Cordis fiber lifecycle.
- Centralize version-sensitive Codex DOM probes in the host adapter.
- Preserve the [documented trust boundary](../docs/architecture.md#trust-and-security): legacy structured and local-development plugins are trusted renderer code; the bounded Host DOM worker does not make the general runtime a sandbox.
- Follow [documentation maintenance](documentation-maintenance.md) for this repository's entry points, public reference material, guides, and historical records. Keep implementation-specific tests beside the code.
- Follow the organization [file-size rule](https://github.com/cordisx/cordisxmono/blob/main/.agents/rules/file-size.md)
  for dprint formatting and responsibility-based splitting guidance.
- Land externally observable contract changes in `cordisx-protocol` before or alongside compatible implementation changes.
- Use [Host testing](../docs/testing.md) to select the smallest relevant test
  group. Browser/native checks apply to their execution boundary, not all plugin
  development. Reuse matching CI evidence for complete delivery requirements;
  do not duplicate a running full CI job locally. Dependency revision differences
  require compatibility assessment, not automatic alignment or full local runs.
- Retain complete evidence for release/Mono integration and high-risk runtime
  changes. Each new or expanded heavy test must cover a concrete regression that
  a cheaper layer cannot detect; review duplicate setup and coverage.
- Follow [long-running-task-recovery.md](long-running-task-recovery.md) when a long-running coordination task is interrupted or its visible history disagrees with durable task evidence.
- Follow [functional-delivery.md](functional-delivery.md) for user-visible Manager,
  launcher, bridge, and preview work. It defines the requirement ledger,
  Host/plugin ownership checks, intermediate previews, production-path proof, and formal delivery gates.
- Follow [showcase-capture-integration.md](../docs/showcase-capture-integration.md)
  before changing Manager localization, Slot Showcase capture behavior, CDP
  injection timing, or the real Codex Desktop homepage capture workflow.
- Before changing either root README's AI-first plugin demo, its media URLs, or
  its regeneration workflow, read the website-owned
  [AI-first plugin demo capture workflow](https://github.com/cordisx/cordisx.github.io/blob/main/.agents/docs/ai-plugin-demo-capture.md).
  Keep the recorder and generated media in `cordisx/cordisx.github.io`; do not
  copy or recreate them in this repository.

## Shared quality configuration

The local dprint and ESLint entry points consume an exact formal
[Mono quality configuration](https://github.com/cordisx/cordisxmono/blob/c63c2e8c2ba7e11502934a52ad2ce3734e804cdc/.agents/docs/quality-tooling.md).
The Shared quality configuration CI job checks the installed configuration and
tracked-file coverage; inspect its report for excluded paths.
PR CI uses standard lint-staged with `--diff-filter=A` to enforce the source
limit on newly added files. Edits or renames of existing files are outside this
initial gate; follow the organization splitting guidance when expanding them.
`npm run lint:source` runs the full source policy and reports existing violations;
its initial CI report is nonblocking while that debt is handled separately.
A passing configuration job is not a passing full-source lint result.
Update the dependency, lock, formatter reference and CI provider SHA together.

- For plugin operation feedback, follow [notifications](../docs/notifications.md). Use the owner-bound public notification API; do not add custom Toasts or page-level operation alerts.
