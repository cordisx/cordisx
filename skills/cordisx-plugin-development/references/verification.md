# Verification

## Focused verification

- Manifest and public-contract validation.
- Config presenter behavior, including actual typed values, validation, defaults, and save/reload semantics.
- Activation, deactivation, generation replacement, abort, and disposer cleanup.
- Search, scroll ownership, card action propagation, keyboard operation, and portal cleanup when relevant.

## Real Playground

- Use the production runtime and renderer seams through the maintained local Playground command.
- Use an isolated temporary `CORDISX_HOME` or explicit CordisX config file. This isolates CordisX state; it is not a new browser or ChatGPT profile.
- Load the actual plugin bundle. Do not substitute a static mock for a runtime integration claim.
- Mark Host-only capabilities unavailable unless the Playground provides an explicit fixture.
- Preserve built-in `cordisx:*` identifiers during temporary materialization.

## Delivery evidence

- Run the focused tests and owner-repository full gates.
- Run typecheck, build, package/install checks, audit, and diff check when required by the repository.
- Exercise the real Playground in the relevant theme and layout states; these should confirm rules already encoded in components and tests, not serve as the first design review.
- Keep any user-reviewed Playground open while starting a replacement on a new port.
