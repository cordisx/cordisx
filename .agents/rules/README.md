# Maintenance Rules

- Preserve the separate-process, loopback-CDP architecture and never modify the installed Codex application.
- Keep all plugin contributions reversible on the owning Cordis fiber lifecycle.
- Centralize version-sensitive Codex DOM probes in the host adapter.
- Treat plugins as trusted local code until isolation and capability enforcement are implemented.
- Keep public product documentation in `.agents/docs` and implementation-specific tests beside the code.
- Land externally observable contract changes in `cordisx-protocol` before or alongside compatible implementation changes.
- Require `npm run check` for behavior changes and focused live smoke tests for launcher or DOM-adapter changes.
- Follow [long-running-task-recovery.md](long-running-task-recovery.md) when a long-running coordination task is interrupted or its visible history disagrees with durable task evidence.
- Follow [functional-delivery.md](functional-delivery.md) for user-visible Manager,
  launcher, bridge, and preview work. It defines the requirement ledger,
  Host/plugin ownership checks, real-runtime proof, and experience-launch gate.
