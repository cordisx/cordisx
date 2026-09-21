# Local candidate acceptance

Use this flow to validate the exact npm artifacts produced by the current
checkout before publishing them. It never substitutes source execution for the
candidate: both `cordisx` and `create-cordisx-plugin` are built by their normal
`prepack` lifecycle, packed with `npm pack`, installed into a runner-owned npm
prefix, and checked through the installed package bins.

## First run

The shortest command uses a completely temporary acceptance profile and starts
an independently profiled Host when a Codex or ChatGPT executable can be found:

```bash
npm run acceptance:local-candidate
```

Use `--executable <absolute-path>` when automatic Host discovery is not
appropriate. Use `--package-only` on a machine without a usable desktop Host;
that mode still performs the real pack, isolated install, bin provenance, and
package-content checks, but its report marks native evidence as skipped.

The default Host check launches the installed candidate bin through the
existing local-development checkpoint. It verifies startup, the `app://`
renderer, an active candidate plugin, Provider bridge visibility, the Session
creation boundary, lifecycle recovery, and owned-process cleanup. The Session
contains no user message and its Agent handle is immediately released; the
runner never submits a model turn.

## Reusable acceptance profile

Choose a new empty directory outside the normal CordisX home for the first
persistent run:

```bash
npm run acceptance:local-candidate -- \
  --profile-root "$HOME/.cordisx-local-acceptance/candidate"
```

The runner writes an ownership marker before use. Later runs with the same
`--profile-root` reuse its dedicated `CORDISX_HOME`, checkpoint fixture, and
Chromium profile, which makes upgrade and reinstall checks observe the same
acceptance state. The runner preserves that directory on success and failure.
It never points `CORDISX_HOME` at the user's normal CordisX state and never uses
the system Chromium profile.

The Host launch retains the user's existing `HOME` and `CODEX_HOME` (or the
original `$HOME/.codex` when it was implicit), so the separate Host process can
use the existing Codex login and configuration. The runner disables bundled
Skill deployment for this launch and never copies, packages, or seeds tokens,
credentials, grants, cookies, or sibling state. Reports replace those roots,
private loopback URLs, and credential-shaped text with stable redaction
markers.

Remove a persistent acceptance profile explicitly:

```bash
npm run acceptance:local-candidate:clean -- \
  "$HOME/.cordisx-local-acceptance/candidate"
```

Cleanup refuses unmarked directories and symbolic-link roots. Normal and
failure exits remove only the runner-created pack/install workspace and, in
temporary mode, the marked temporary profile. They do not stop an existing
user App or target processes outside the candidate profile.

## Real messages

Real model messages are never part of the default acceptance. The explicit
opt-in below runs the existing pinned Desktop Agent/Session harness with the
installed candidate bin after the safe Host checkpoint:

```bash
npm run acceptance:local-candidate -- --real-message
```

That harness creates a real Session and submits its bounded smoke messages. It
can fail closed when the installed Host build is outside its audited pins.

## Evidence and conclusion boundary

Each run writes `acceptance-report.json`, pack/install logs, and, for a Host
run, the reused checkpoint report, launcher log, and screenshots below the
selected artifacts directory. The report records the source commit, candidate
tarball SHA-256 digests, installed versions and bin digests, dedicated profile
paths as redacted placeholders, Host build, stage outcomes, artifact paths, and
cleanup results.

A passing package-only run proves the unpublished tarballs install and expose
the expected contents. A passing default Host run additionally proves the
installed candidate can cross the named native startup and renderer boundaries
on that Host build. Neither result is npm publication, repository merge, nor
user acceptance. Only `--real-message` supplies live model-message evidence.
