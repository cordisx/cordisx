# Independent Codex adapter candidate — 2026-11-02

Dated implementation/evidence ledger for the initial extraction, based on Host
main `c67c17b2ad0ec47f362cfb637e9d79175c568e55` (beta.38). This does not
repeat the beta.38 release. The maintained reference is
[Codex adapters](../codex-adapters.md).

| Requirement                              | Implementation                                                                                                    | Evidence / remaining gate                                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Independent package/version/release      | `@cordisx/codex-adapter`, private Host ABI and separate tag workflow                                              | Adapter build, typecheck and package-content check; first npm publication deliberately withheld                                                 |
| Coexisting modules and versions          | Ordered candidate/dependency solver; arbitrary module count; declared composition/conflict checks                 | Selection tests cover 12 independent version candidates, dependency mismatch, conflicts and atomic rejection                                    |
| Sending/first turn/task dependency       | Complete submission chain, same-package task dependency, Host relay contract 1                                    | Existing beta.38 lazy wire/menu/first-turn tests retained; intermediary/first-turn regression tests pass                                        |
| Structural admission, no client ceiling  | Unique semantic discovery and SHA-256 binding; App identity is diagnostic                                         | Unknown/future fixture builds plus local Desktop 26.1027.30824 / 22943 read-only structural check                                               |
| Native source stays local                | Only owned rules/source, synthetic fixtures and licensed parser in npm allowlist                                  | Package-content check; strict intake; installed App never modified by the implementation                                                        |
| Trusted source, integrity and provenance | Fixed npm package/origin, SHA-512 archive pin, npm ECDSA and Sigstore workflow identity/source verification       | Policy tests use synthetic signed registry metadata and an injected verifier; real first-package provenance cannot be tested before publication |
| Replay/withdrawal                        | Publishing-time channel fence, explicit exact rollback, npm deprecation rejection and persistent local revocation | Replay, provenance mismatch, withdrawal and cached revocation tests; no signed routing index in this stage                                      |
| Owned cache, retention and fallback      | Private immutable snapshots, exact receipts, leases, pins, previous selection and byte/recency pruning            | Real tarball intake/loading, offline, corrupt archive/tree, active lease, pin, rollback and GC tests                                            |
| Lifecycle truth                          | Downloaded, installed, preferred next launch, selected lease, document acknowledgement                            | Native CDP bootstrap reports document availability; no hot activation or restart queue                                                          |
| Security-core boundary                   | Host retains credentials, tokens, controls, permissions, request settlement and intermediary                      | Existing intermediary regressions retained; future incompatible relay semantics require a Host release                                          |
| Production composition                   | Compiled Host analysis imports independent packed entry; baseline bundled in Host                                 | Production integration verifies exact external identity, token forwarding, cache partition and baseline fallback                                |
| Isolated native / formal review          | Dedicated shared-login process/profile/config, no CUA or global configuration changes                             | Native interaction and exact-head PR CI are tracked in the PR delivery receipt; not established by fixture or read-only checks                  |

At initial source review this candidate is implemented and locally tested for
the named automated scopes. It is not merged, published, installed into the
user's normal CordisX home, or active in the existing beta.38 window. Native
interaction, cleanup/non-target readback and final CI must be reported
separately in the PR before calling the native production path verified.
