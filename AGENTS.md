# CordisX contributor notes

- CordisX is an unofficial, opt-in local UI plugin host for Codex Desktop.
- Keep the official Codex installation unmodified. Renderer integration goes through a separately launched CDP endpoint.
- Every UI contribution must be reversible when its Cordis fiber unloads.
- Treat plugins as trusted local code until process or iframe isolation is implemented. Do not describe the current runtime as a sandbox.
- Prefer named semantic slots and adapter probes over plugin-owned Codex DOM selectors.
- Update `docs/architecture.md` when changing lifecycle, loading, slot, or security behavior.
- Run `npm run check` after behavior changes.
