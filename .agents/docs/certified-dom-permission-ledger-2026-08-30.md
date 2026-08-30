# Certified Host DOM permission delivery ledger

Status: Host candidate implementation. The normative Protocol manifest-v5,
permission-v4, capability-catalog-v3, root-catalog-v1, and bounded Host DOM
bridge contracts are formally merged at
`cordisx-protocol@44912c6689d1b722e1380e2f34b3e05ccc55c822`. The Host consumes the formal
Marketplace projection merged at `97dcef1571952ae527bef59d02bba49394d57ed8`.

| Requirement | Candidate state | Evidence or remaining gate |
| --- | --- | --- |
| `ui.extension-points.render` stays structured and cannot impersonate direct DOM access | implemented | It retains its Host-owned contribution path; manifest-v5 defines separate `ui.host-dom.read` and `ui.host-dom.modify` declarations. |
| Ordinary, Certified-only, Official-only, and Official plus Certified remain independent | implemented in the isolated candidate | Official is absent from every PermissionBroker input; only a strict exact Certified projection can select implicit approval. Production does not currently admit the renderer-owned projection as authority. |
| Only catalog-designated DOM/render capabilities can skip visible review | implemented | The 22 original capabilities remain `non-dom`; both Host DOM capabilities are `host-dom`, and `ui.extension-points.render` remains `dom-rendering`. |
| Certified approval still creates one Host-owned grant/lease/audit | implemented | Permission-v4 uses the existing Broker, policy engine, profile ledger, exact once-grant ledger, lifecycle authority, and Manager audit projection. |
| Official-only never changes authorization | implemented | Official does not enter lifecycle, policy, plan, decision, grant, lease, or audit inputs. |
| Every non-DOM capability prompts normally in all four trust states | verified locally | Focused four-state tests keep the original 22 declarations on the v2 ledger/prompt path. |
| Exact artifact and active trust are mandatory | implemented | Source, plugin id, version, digest, review evidence, fingerprint, revision, generated time, and expiry are revalidated; absence or change clears Certified leases. |
| Scope and operations are bounded | implemented | Scope accepts only catalog `rootIds[]` plus closed `operations[]`; requests cannot carry selectors, paths, HTML, class/style, script, event handlers, nodes, callbacks, document/window, or a private bridge. |
| Runtime access uses opaque fenced handles | implemented | The Host authority binds owner, root, module/Host generation, operation set, and Broker lease; reads are bounded/redacted and writes are closed/reversible or owner-local. |
| Disable, uninstall, block, generation replacement, expiry, digest update, and source/cert revocation clean up | implemented | Broker invalidation clears leases and the authority subscription rolls back reversible effects and removes owned children. |
| Persistent deny wins; modify cannot persistent-allow | implemented | Exact v4 policy is stored in the same Home ledger; the catalog and normalizer reject persistent modify allow. |
| Marketplace refresh reaches the Broker without a trust cache | blocked on an unforgeable Launcher-to-Broker channel | The formal Launcher authority now owns exact trust and monotonic invalidation, but current production has no isolated receiver that can deliver its revision/snapshot to the shared-renderer Broker without plugin forgery. Runtime therefore stays fail-closed. |
| Install/update/enable reuse PackageLifecycleAuthority | implemented with formal Launcher trust | Package-v4/manifest-v5 use the Host-private v4 review/apply envelope and the existing candidate receipt/rollback transaction. Production opens the formal Launcher authority once per selected profile and rereads its exact artifact lookup at both plan and apply; failure falls back to explicit review. |
| Manager explains Certified automatic approval | implemented | Permission detail retains the explicit `certified-implicit` origin, reason, evidence, fingerprint, and revision. |
| Availability stays independent from authorization | implemented | The Broker may produce a valid lease while current shared-renderer production reports Host DOM `unavailable`. |
| Current shared renderer is safe for Host DOM | unavailable by design | Plugins still have ambient renderer DOM access. The production catalog and Manager therefore report `unsupported`; no BoundHostDomClient is injected until a genuine isolated plugin realm exists. |
| Full repository gates and installed consumer | verified locally | Candidate gate passed 150 files / 842 tests plus release metadata, package allowlists, installed tarball consumers, and zero high-severity audit findings. |
| Real `app://-/index.html` Certified smoke | blocked | The App must continue to show Host DOM unavailable and must not claim Certified implicit approval until the trust and execution-isolation prerequisites are real. |
| Host PR, CI, and formal merge readback | pending | No release or Mono update belongs to this delivery. |

The unavailable production result is a security invariant, not an incomplete
authorization fallback. Unit and conformance tests exercise the real bounded
authority behind an explicit isolated-boundary signal; the current App must not
claim that signal merely because the Broker granted a lease.

The display-side `MarketplaceModel.snapshot()/subscribe()` API remains excluded
from authorization because its Browser source store, bridge, and JavaScript
objects share the plugin realm. Package lifecycle now consumes only the formal
`LauncherMarketplaceCertifiedAuthority`: a single profile instance reads
Host-owned roots, enforces monotonic revision/revocation, and performs fresh
exact-artifact lookup at plan and apply. Runtime Broker invalidation remains
fail-closed until an unforgeable Launcher-to-Broker channel exists. No
renderer-supplied projection or attestation token is accepted by lifecycle RPC.
