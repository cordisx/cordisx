# Independently released Codex adapters

Audience: CordisX users and maintainers. This is the first implementation of an
independent adapter loader. Source and test availability do not mean that a
package has been published, installed, activated, or accepted by a user.

## Boundaries and compatibility

`packages/codex-adapter` owns native submission/model-menu structural analysis,
account-reader discovery, task-creation transforms, and the older fingerprinted
layout. The Host bundles a built baseline for offline startup. The npm package
has its own version and `codex-adapter-v<version>` tags; Host and Creator retain
their existing versions and release workflow.

This is a private Host implementation ABI, not a new public plugin Protocol.
The loader admits adapter API 1 and relay contract 1. A different API or relay
contract is rejected explicitly even when the native structure matches.
Version/build strings are diagnostic evidence, never a client maximum or a
whitelist. Each module must identify unique supported structures on local
resources. Generated transforms bind SHA-256 of the original resource, assert
one match, and provide execution acknowledgement and synchronous fencing.
CDP verifies those bytes again before replacing a response in the independent
process. The installed App and its signed resources remain untouched.

The package exports a list of capability modules with dependency and resource
composition declarations. Multiple package versions may be installed and
selected together; there is no fixed version/module count. The selector tries
preferred versions in order, then the retained rollback policy and the bundled
baseline. It resolves dependencies before analysis, rejects cycles and
undeclared resource collisions, and validates the complete transformed result
before activation. An optional failing module leaves the prior working result
intact. Account discovery may come from another compatible package generation.
Task creation declares a same-package dependency on submission and explicitly
recomposes its transforms; a task half cannot be mixed with another release's
first-turn carrier. Submission discovery itself requires the entire Send,
first-turn and final-dispatch chain before returning any transform.

The intermediary (`native-app-server-protocol.mjs`), operation-token authority,
credential delivery, account fencing, policy checks, control socket and request
settlement remain Host security code. They are not downloaded replacement
modules. Relay contract 1 denotes the existing admitted-Send token carrier,
first-turn metadata/config transport and Host-owned stripping/association.
A future incompatible intermediary semantic needs a Host update and a new
contract number. Remote adapters cannot declare that incompatibility away.

## Install, select and inspect

```sh
cordisx adapter install beta
cordisx adapter status
cordisx adapter use <archive-sha256> [<another-archive-sha256> ...]
cordisx adapter pin <archive-sha256>
cordisx adapter unpin <archive-sha256>
cordisx adapter revoke <archive-sha256>
cordisx adapter prune
```

`install` accepts `stable` (npm `latest`), `beta`, or an exact package version.
It reports downloaded only after archive verification, then installed after
strict extraction and atomic store promotion. Installation alone does not
change selection. `use` stores an ordered exact selection for future normal
launches; `use` without identities selects the built-in baseline, retaining the
previous selection for rollback. Status separates installed packages, preferred
selection, rollback, pins, revocations and live launcher leases.

No download occurs on App startup. The first stage only loads on a normal
launcher start. Existing native modules, documents and intermediary processes
retain their loaded code. There is no hot-update promise or invented restart
queue. A lease first records selected modules with no active documents. A
document becomes active after required resource acknowledgements and renderer
bootstrap; this does not assert that every lazy task module has executed or
that the account reader has already been called. Unavailable/disposed
interceptions clear document availability. Leases end with launcher cleanup;
status ignores leases whose owning process has exited.

## Trusted intake and execution

Only `@cordisx/codex-adapter` at `https://registry.npmjs.org/` is accepted.
Registry configuration, arbitrary URLs, redirects and npm installation scripts
are not consulted. Channels discover an exact version; its canonical tarball
URL, SHA-512 archive integrity, source commit, publishing time and verified
workflow identity are retained. Existing installed versions cannot change
content under the same version.

The loader verifies the npm registry's documented ECDSA signature envelope,
then uses the maintained `sigstore` verifier for certificate identity/issuer,
trusted roots, signature and transparency-log verification. It requires SLSA
provenance for this repository's `adapter-release.yml` workflow at the exact
adapter tag, and verifies the attested package name, version, digest, source
repository, workflow and commit. A matching archive hash is integrity evidence;
it is not publisher authentication. See [npm provenance](https://docs.npmjs.com/generating-provenance-statements/)
and [npm signatures](https://docs.npmjs.com/about-registry-signatures/).

Extraction reuses the Host's strict package snapshotter: traversal, symlinks,
hardlinks and special files are rejected. Runtime dependencies, executable bins
and install/prepare scripts are refused. No package manager installation runs.
The standalone entry bundles its parser; published content contains our own
source/rules, licensed parser code and synthetic fixtures. Do not add native
App sources, complete transformed native sources, credentials, account data or
private logs to the package or CI artifacts.

Verified entries execute as trusted launcher JavaScript with that user's Node
permissions. This mechanism is not a sandbox or a general plugin installer.
There is no injected credential/control authority in the adapter input: inputs
are local resource text, diagnostic App identity and already selected resource
transforms. Trust is restricted to the release workflow because JavaScript
could access Node facilities regardless of the input shape.

## Replay, withdrawal and fallback

Channel installs reject publishing timestamps older than the greatest already
verified timestamp. An explicit exact-version install is an intentional
rollback and still requires all trust checks. The timestamp fence uses the
trusted registry response; it is not a new signed freshness protocol or proof
that the registry is showing the newest release. Local `revoke` prevents future
selection/install of that archive identity. npm deprecation rejects newly
resolved withdrawn releases. Revocation does not forcibly unload an active
window. While offline, cached receipts cannot learn about new withdrawals;
operators can revoke locally or select the baseline. The first stage has no
remote signed routing/revocation index. Add one only when rollout/fingerprint
routing or timely offline-aware withdrawal requirements justify it.

Offline or failed downloads preserve the installed selection. Every startup
checks the entire cached tree and entry hash before importing. Corrupt, revoked
or API-incompatible candidates are diagnosed and skipped. Structural failure
tries another compatible combination; when none works, existing Host startup
reports enhanced native switching unavailable and preserves native submission.
A stale fingerprint is never forced onto changed resources. The local
transformed-source cache includes resource digests and ordered adapter content
identities, so a rule change cannot reuse a previous adapter's result.

## Storage and cleanup

Packages live under `${CORDISX_HOME || ~/.cordisx}/codex-adapters`, separate
from the private local native transformed-source cache. Intake uses private
staging followed by atomic rename. Store mutations share an exclusive lock;
only a dead lock owner may be recovered. Cache roots/state require current-user
ownership, private modes and no symbolic link at the owned root.

`prune` uses bytes, available disk and last use/installation time, rather than a
version count. It retains selected, rollback, pinned and leased packages even
when these exceed the disk target. Defaults are 256 MiB for unprotected cache
pressure and a 512 MiB free-space target. Each prior selection may contain any
number of package versions. Download/extraction budgets bound each artifact;
they do not cap the number of retained versions. Live leases conservatively
retain packages while their PID is alive, including a reused PID.

## Independent release

The adapter workflow validates the adapter, related submission/account/task and
Host-intermediary regressions, actual packed-artifact loading and package
contents. It does not publish Host or Creator or repeat unrelated module
release suites. A release tag must point at a commit on canonical main and
match the package and runtime versions. Publishing uses npm provenance and the
repository's `npm-release` environment. The maintainer must configure
npm's trusted publisher for this package and this workflow before the first
OIDC publication, and retain the required environment review rules; an absent package is not evidence of publishing permission.

For each release retain isolated native evidence for the changed native seams,
including Host/client builds, adapter identities and source commit. Synthetic
or read-only resource checks cannot substitute for native interaction. The
workflow requires a maintainer-reviewed native validation receipt for that
exact commit. The receipt contains only public-safe build/identity/check
summaries; private native resources, account data and raw logs stay local.

A future adapter-only repair normally changes this workspace and its relevant
tests. A Host ABI, security-core, loader or intermediary change remains a Host
change and requires the affected Host boundary gates. Full Host PR CI for the
initial extraction is separate from subsequent independent adapter releases.
