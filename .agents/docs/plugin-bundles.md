# Plugin bundle delivery ledger

This ledger translates the plugin-bundle product request and its UI corrections
into independently verifiable behavior. The protocol contract is owned by
`cordisx-protocol`; the coordinator, bridge, runtime projection, Manager UI,
Playground fixture, and app smoke are owned by this repository.

| Requirement                                                                                                                                             | State    | Evidence                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Installing one bundle stages and installs its selected member plugins in dependency order                                                               | verified | `tests/plugin-bundle.test.ts` install and update cases                                                                                                                                                                               |
| The Host records whether a plugin is bundle-managed, directly retained, shared by another bundle, or required by a runtime dependent                    | verified | coordinator claim projection and cross-bundle tests                                                                                                                                                                                  |
| Bundle disable removes only enable intent; bundle uninstall removes only its claim; shared/direct/runtime-required members are retained                 | verified | cross-bundle and active-intent tests                                                                                                                                                                                                 |
| Direct plugin disable/uninstall cannot bypass a remaining bundle claim                                                                                  | verified | direct-removal guard test                                                                                                                                                                                                            |
| Bundle updates can replace an exclusively owned member and remove dropped orphan members                                                                | verified | bundle update test                                                                                                                                                                                                                   |
| Bundle permissions provide one unified bundle policy plus exact per-plugin overrides                                                                    | verified | permission merge/override/clear test and Manager permission editor test                                                                                                                                                              |
| Multiple active bundle policies merge `deny > ask > allow`; an explicit plugin override wins globally                                                   | verified | shared policy test                                                                                                                                                                                                                   |
| Removing a restrictive bundle cannot silently widen access; a safety floor remains until confirmed review                                               | verified | safety-floor transition test                                                                                                                                                                                                         |
| Manager provides a browse/install page and a bundle detail page                                                                                         | verified | React Manager test and loopback UI Playground                                                                                                                                                                                        |
| Detail header above tabs contains icon, name, status, authors, source, version, digest, update time, and update/enable/disable/repair/uninstall actions | verified | Manager test plus real Playground DOM/layout inspection                                                                                                                                                                              |
| Detail tabs are exactly `README / Members / Permissions / Relations / Records`                                                                          | verified | Manager test plus real Playground DOM inspection                                                                                                                                                                                     |
| The README tab renders only README content; metadata, status, exceptions, and update policy are not repeated there                                      | verified | Manager isolation assertion plus real Playground inspection                                                                                                                                                                          |
| Narrow layout keeps the dialog and detail content inside the viewport without page/detail horizontal overflow                                           | verified | real Playground inspection at 720 × 800                                                                                                                                                                                              |
| Production launcher publishes the bundle snapshot and token-bound private RPC to the renderer                                                           | verified | launcher wiring, bridge tests, and real Playground production composition                                                                                                                                                            |
| A cold isolated `app://` run installs the fixture bundle, confirms permission, opens all tabs, disables it, and reads the audit record                  | verified | `tests/fixtures/plugin-bundle-production-smoke.mjs`; local `app://-/index.html` run passed every assertion and proved CDP port closure, zero remaining profile processes, unchanged Crashpad state, and removal of the isolated Home |

## Manager information architecture

The header owns identity, current state, provenance metadata, and lifecycle
actions. The tab bar follows the header. The five tab bodies are intentionally
narrow:

1. `README`: README document only.
2. `Members`: required/optional intent, exact requested and installed identity,
   bundle/direct/runtime claims, conflicts, adoption, and optional enablement.
3. `Permissions`: unified bundle policy, exact declaration scope, global
   per-plugin override, effective source, and affected bundles.
4. `Relations`: ownership claims and runtime dependency edges.
5. `Records`: bounded lifecycle and policy audit history.

There are no configuration, runtime, logs, route, or extension-point tabs for a
bundle because the bundle itself does not execute. An executable coordinator is
an ordinary member plugin and uses that plugin's existing detail page.
