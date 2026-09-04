# Verification

## Focused verification

- Manifest and public-contract validation.
- Config presenter behavior, including actual typed values, validation, defaults, and save/reload semantics.
- Activation, deactivation, generation replacement, abort, and disposer cleanup.
- React component updates through a valid Fast Refresh boundary, plus state retention when that behavior is claimed.
- Multi-plugin isolation: editing or manually reloading one entry must not recreate unrelated plugin fibers.
- Search, scroll ownership, card action propagation, keyboard operation, and portal cleanup when relevant.

## Development transport

- Run `cordisx dev --dry-run` from the same directory and config-discovery path that users will use. For multiple plugins, prove that every enabled config entry resolves.
- Run one launcher-owned Vite server and one Electron App for the project. Do not start a development server per plugin.
- Verify both update triggers when applicable: save a local source file and invoke **Reload plugin** in Manager for one active local-development plugin.
- Classify the observed result correctly. A refresh-compatible React component edit may retain component state; plugin entry, manifest, or activation changes replace that plugin through the Cordis generation transaction; Host modules outside a refresh boundary restart the CordisX renderer in the current document; config and Node-side launcher changes require restarting the command.
- A source write proves only that an update was triggered. Inspect the runtime result and verify disposer cleanup, a single active registration/root, and last-good behavior after a failed candidate.

## Real native App and Playground

- Use `cordisx dev` for claims about the installed native App. The expected path is an isolated Electron launch whose `app://` renderer imports the launcher-owned loopback Vite entry; do not substitute Computer Use or a generic browser launch.
- CDP is the initial bootstrap and native policy-control seam. Before reload it grants loopback access to the exact target origin and enables CSP bypass. Subsequent modules and update notifications use Vite HTTP and Vite's own WebSocket. Source maps are separate resources fetched on demand; readiness follows the current installation's Vite bootstrap acknowledgement rather than a generic page-load event. Stopping restores the permission to `prompt`, disables the bypass, disconnects HMR, and removes Vite-injected styles even when plugin disposal fails.
- Confirm the native renderer reaches ready and exercise the intended UI or contribution. On stop, verify the Vite/CDP ports, in-memory session state, and launcher-owned process/profile resources are released. The stable dependency cache under `CORDISX_HOME/cache/native-vite` should remain; reject symlinked or foreign-owned cache leaves, and verify that a second launch from the same CLI and workspace roots reuses the cache without an optimizer-triggered reload.
- Use the maintained local Playground when it directly covers the feature under test.

- Use an isolated temporary `CORDISX_HOME` or explicit CordisX config file. This isolates CordisX state; it is not a new browser or ChatGPT profile.
- Load the actual plugin bundle. Do not substitute a static mock for a runtime integration claim.
- Mark Host-only capabilities unavailable unless the Playground provides an explicit fixture.
- Preserve built-in `cordisx:*` identifiers during temporary materialization.

## Delivery evidence

- Run the focused tests and owner-repository full gates.
- Run typecheck, build, package/install checks, audit, and diff check when required by the repository.
- Exercise the relevant real runtime in the needed theme and layout states; these should confirm rules already encoded in components and tests, not serve as the first design review.
- Keep any user-reviewed Playground open while starting a replacement on a new port.
