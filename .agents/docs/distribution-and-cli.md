# CordisX distribution and CLI architecture

## Goal

CordisX must be usable without cloning a repository or hand-authoring a project
configuration. `npx cordisx` is the zero-install launcher and automation entry;
a signed native launcher is the long-term default for users who should not need
Node.js. Both entrypoints resolve the same versioned home configuration,
application adapters, named profiles, plugin state, and permission grants.

This document owns the settled product-distribution contract. Runtime internals
remain in `architecture.md`; normative plugin schemas remain in
`cordisx-protocol`; catalog entries remain in the marketplace repository.

## Command model

The stable grammar is:

```text
cordisx [app] [profile] [--data shared|host-isolated] [options] [-- host-arguments...]
cordisx setup
cordisx config
cordisx doctor
cordisx dev [plugin-path]
```

Examples:

```bash
npx cordisx
npx cordisx codex
npx cordisx codex work
npx cordisx codex work --data host-isolated
npx cordisx claude-code personal
npx cordisx setup
```

`app` is an adapter id, not a hard-coded union owned by the CLI. `codex` is the
first implementation. `claude-code` and later hosts use the same grammar only
after their adapters are installed and report launch support; an unknown or
unavailable adapter fails with a typed diagnostic and must never silently fall
back to Codex.

`profile` is a reusable CordisX launch profile within an app. If the named
profile exists, the CLI reuses it. If it does not exist, the CLI creates and
persists a shared-Host profile before launch. Profile ids use the portable
grammar `[a-z0-9][a-z0-9._-]{0,63}`; a separate display name may be localized
or contain arbitrary user-facing text.

Arguments after `--` belong to the selected host. CordisX options and host
arguments never share an ambiguous positional parser.

## Home configuration

The canonical configuration is `${homedir}/.cordisx/config.json`. It is user
configuration, not project source. Project-local files may override developer
composition during `cordisx dev`, but ordinary launch must not create a
`cordisx.config.json` in the current directory.

The initial schema is conceptually:

```json
{
  "version": 1,
  "defaultApp": "codex",
  "plugins": [],
  "apps": {
    "codex": {
      "defaultProfile": "default",
      "profiles": {
        "default": {
          "displayName": "Default",
          "dataMode": "shared"
        },
        "work": {
          "displayName": "Work",
          "dataMode": "host-isolated"
        }
      }
    }
  }
}
```

The first generated configuration always uses `plugins: []`. CordisX itself is
host infrastructure, not a bundled demo plugin, and setup must not silently
activate `slot-showcase` or any other example. Version 1 may load explicitly
configured trusted local plugin entries, but package installation, dependency
resolution, signatures, and marketplace activation remain later authority
work.

The persisted document is versioned and strictly validated. Writes use a
same-directory temporary file, fsync where available, atomic rename, and user-
only permissions. Setup may tighten the canonical existing `~/.cordisx`
directory left by an older CordisX launcher; an explicit `CORDISX_HOME` with
broad permissions fails closed instead of being modified. A migration
preserves unknown future fields only when their owning schema allows them; a
failed migration leaves the last readable file in place and reports a recovery
path.

`cordisx setup` and implicit first launch call the same idempotent
`ensureHomeConfig()` operation:

1. return the validated configuration when it already exists;
2. migrate an older supported version atomically;
3. use deterministic `codex/default/shared` defaults in version 1 without
   waiting for interactive input; a later setup UI may offer other installed
   launch-capable adapters without changing this file contract;
4. fail with the exact missing adapter or choice rather than falling back to a
   different host;
5. create the parent directory and initial configuration without overwriting an
   unrelated or invalid file.

Resolution precedence is CLI option, named profile, app default, global
default, then adapter default. Every resolved launch plan is inspectable through
`cordisx doctor` without starting the host.

## Independent CordisX launches and explicit Host-root isolation

`dataMode` has two values with deliberately different scopes:

- `shared` is the default independent CordisX launch. It starts a separate
  Host process with a persistent, profile-scoped Chromium `--user-data-dir`
  under `CORDISX_HOME`, while explicitly sharing `HOME` and `CODEX_HOME` for
  the existing account, conversations, projects, and model configuration.
  It never reads, copies, or changes browser cookies.
- `host-isolated` is an advanced explicit opt-in with separate Host data roots
  as well as a separate Chromium profile. It may require a separate sign-in;
  it is not what “independent CordisX configuration” means.

The adapter translates this intent into host-specific environment variables,
directories, and launch arguments. The CLI must not know that one host uses
`CODEX_HOME` while another uses different roots. An adapter must enumerate the
roots it shares or isolates in the doctor output and tests; a mode is
unavailable until that adapter can enforce it completely.

CordisX never modifies an installed host application. A shared launch has its
own persistent Chromium profile, so it can run beside the normal Host without
Electron singleton hand-off or a cold restart. `--system` is the explicit
escape hatch to the normal Host Chromium profile; `--profile-dir` changes only
the independent Chromium directory and does not alter `HOME` or `CODEX_HOME`.
Host-root isolation is a filesystem/profile contract, not a security identity
boundary:
platform keychains, device identity, and other operating-system services may
still be shared unless a future adapter can project them explicitly.

Version-1 configurations containing `"dataMode": "isolated"` remain accepted
as a non-destructive alias for `host-isolated`. CordisX does not rewrite that
file merely by reading it; later profile writes use the explicit spelling.

## Product monorepo

The `cordisx/cordisx` repository becomes an npm-workspaces monorepo. The root is
always private and owns orchestration only:

```text
packages/
  cli/                     # public package: cordisx; bin: cordisx
  create-cordisx-plugin/   # public package and bin of the same name
  runtime/                 # private host-neutral runtime composition
  adapter-codex/           # first host adapter
  sdk/                     # future public package: @cordisx/sdk
examples/
  plugins/
tests/
```

The first migration keeps runtime and Codex-adapter source inside
`packages/cli` while package boundaries are extracted in later reviewable PRs.
The already published `cordisx@0.0.0` and
`create-cordisx-plugin@0.0.0` packages are an explicit, one-time name-
reservation exception requested by the project owner. They must remain clearly
labelled non-functional reservations until replaced by the functional releases
defined below; no additional empty public packages may be invented.

Repository ownership does not change:

- `cordisx-protocol` continues to own normative schemas and conformance; its
  future npm package is `@cordisx/protocol` and is published from that repo;
- `marketplace` continues to own catalog data and feed generation;
- `cordisx` owns the launcher, product runtime, adapters, SDK implementation,
  scaffolder, and release automation.

The canonical unscoped `cordisx` package owns the friendly CLI. There is no
duplicate `@cordisx/cli` package. `create-cordisx-plugin` owns the
`create-cordisx-plugin` bin used by both `npm create cordisx-plugin` and
`npx create-cordisx-plugin`; its generated project depends only on public
CordisX/Cordis surfaces and never imports monorepo-private paths.

## Package and release contract

A registry name may be reserved by the explicit `0.0.0` exception above, but it
is considered product-ready only after a functional package is published and
the registry reports the intended maintainers. A local `name` field or registry
404 is not evidence of either state. Misleading placeholders and unusable
release tarballs remain forbidden.

Every public package requires:

- an explicit repository license and matching `license` metadata;
- repository, homepage, bugs, engines, exports, and bin metadata;
- an allowlisted `files` set containing built output and required assets only;
- a reproducible `prepack` build and clean-tree package-content test;
- a temporary-directory install test that executes every public bin;
- provenance and a GitHub Actions trusted-publisher workflow after the initial
  ownership bootstrap;
- protected release environments and no long-lived publish token when trusted
  publishing is available.

The first `cordisx` release must make `npx cordisx --help`, `npx cordisx setup`,
and a no-launch doctor/config probe work. The first
`create-cordisx-plugin` release must generate a package that installs,
typechecks, tests, and exposes a valid CordisX plugin entry. Name reservation is
a result of those usable releases, not a separate empty publication.

## First npm beta delivery

The first installable release train is `0.1.0-beta.0` for both `cordisx` and
`create-cordisx-plugin`. The two packages advance together while the generated
template directly depends on the CordisX CLI/contracts package. Every retry or
follow-up release uses a new immutable prerelease version; a published version
is never overwritten or reused.

Both packages publish with the explicit `beta` dist-tag. The existing
name-reservation packages remain `latest: 0.0.0` until a separate stable-
promotion decision. Publishing without `--tag beta`, moving `latest`, or
promoting a beta as an incidental recovery action is forbidden. Because npm
resolves unqualified commands through `latest`, beta users must include the
channel explicitly:

```bash
npm install --global cordisx@beta
npx cordisx@beta --help
npm create cordisx-plugin@beta my-plugin
npx create-cordisx-plugin@beta my-plugin
```

The generated bin and project remain compatible with the unqualified
`npm create cordisx-plugin <directory>` and
`npx create-cordisx-plugin <directory>` forms once the functional package is
locally selected or deliberately promoted to `latest`; the beta documentation
must not imply that the placeholder `latest` package is functional.

The beta package boundaries are:

| Package | Owns | Must not imply |
| --- | --- | --- |
| `cordisx` | Launcher CLI, home configuration, trusted-local plugin bundling, public contracts, and developer dry-run | Marketplace installation, signing, an execution sandbox, enforced capability isolation, or HMR |
| `create-cordisx-plugin` | Directory creation, the versioned minimal template, manifest-bearing entry, project scripts, README, and generated-project verification | Registry/catalog submission, signing, permission grants, marketplace activation, or a watch/reload service |

The scaffolder package exclusively owns
`packages/create-cordisx-plugin/template`. It is copied from the published
tarball rather than downloaded from a branch or from `roadmap`. The template
exports its version-1 manifest from the runtime entry, requests no platform
capabilities by default, uses structured host-owned surfaces, and is testable
with `cordisx dev <entry> --dry-run`. Template changes and their generated-
project tests land in the same PR; no second copy is maintained in CordisXMono
or the docs repository.

Publishing is allowed only from merged `main` through
`.github/workflows/release-beta.yml`, on a GitHub-hosted runner with OIDC and the
`npm-beta` GitHub environment. Each npm package configures that exact repository,
workflow filename, environment, and the `npm publish` action as its trusted
publisher. The workflow carries no npm token. It validates the requested
version against both package manifests, the clean pack allowlists, install
smokes, repository metadata, registry owner, version absence, and both
`latest` values before the first publish.

The registry cannot atomically publish two packages. The workflow therefore
publishes and reads back `cordisx` first, then publishes and reads back the
scaffolder that depends on it. A retry may skip an already published first
package only after its registry tarball integrity and metadata match the local
merged commit exactly. Any mismatched existing version, owner, tag, integrity,
or repository metadata stops the workflow; recovery advances to a new
prerelease unless the already published artifact is proven identical.

Completion requires remote readback, not only `npm pack`: both `beta` tags must
resolve to the requested versions, both `latest` tags must still resolve to
`0.0.0`, and a clean temporary directory must install/run `cordisx@beta`, invoke
both scaffolder command forms, install each generated project, run its
check/build/test scripts, and bundle its entry with the published
`cordisx dev --dry-run`. Package tests also assert that the tarball includes its
README, license, bin, built output, and complete template while excluding repo-
private docs, tests, source-only bins, tokens, and developer configuration.

### Beta licensing boundary

The repository and both public beta packages use the valid SPDX identifier
`AGPL-3.0-or-later` and include the verbatim GNU AGPLv3 text. Package metadata
does not invent a `WITH CordisX` expression. Each tarball also includes the
separate CordisX Independent Plugin Exception as an AGPLv3 section 7 additional
permission.

The exception covers independent plugins that use only expressly documented,
versioned public plugin interfaces, the interface declarations/types/schemas
reasonably necessary to implement such plugins, and the scaffolder's marked
template and generated result. Those plugins may be commercial and use author-
chosen licenses. It does not cover copying, embedding, modifying, repackaging,
or replacing the host/runtime/CLI/manager/launcher/adapter/scaffolder
implementation, a substitute host based on CordisX code, or private interfaces.

The public protocol schemas are licensed compatibly in `cordisx-protocol` and
expressly identified as interface material. The CordisX-specific exception is
not a standard SPDX exception and is not represented as OSI- or FSF-reviewed;
legal review is recommended before stable.

## Delivery order and PR boundaries

1. **Architecture PR** — this document only; no package or CLI behavior.
2. **Monorepo foundation PR** — private root workspace, move the existing
   package without behavior changes, preserve all imports/tests/builds, and add
   package-content allowlists.
3. **Home-config PR** — versioned schema, atomic setup/migration, default app,
   adapter registry, named profiles, shared/isolated launch plans, command
   parser, and focused tests. Codex remains the only launch-capable adapter.
4. **Scaffolder PR** — functional `create-cordisx-plugin`, fixtures, generated-
   project install/typecheck/test, and public SDK/protocol dependency boundary.
5. **Release PR** — license metadata, provenance, trusted publishing, release
   channels, tarball smoke, and exact version/tag automation.
6. **First publication** — publish `cordisx` and
   `create-cordisx-plugin`, verify registry ownership and clean-machine npx
   execution, then enable trusted publishing and restrict token access.
7. **Native distribution PRs** — signed launcher, update channel, and package-
   manager distribution reuse the same home config and profiles.
8. **CordisXMono coordination** — update the exact owning commit only after the
   compatible product and protocol commits are pushed, merged, and verified.

### Functional CLI home-config slice

Status: implemented and verified. The home-config PR is limited to the third
boundary above. It implements the
shared command parser, idempotent setup, strict version-1 home configuration,
atomic and user-only persistence, the adapter registry, named profile
resolution, and a serializable launch plan. `codex` is the only
launch-capable adapter in this slice. `claude-code` and every unknown adapter
fail explicitly without falling back to Codex.

Ordinary launch composes the explicitly configured trusted local plugins from
the home configuration and defaults to none. Existing repository-local
composition remains available only through `cordisx dev --config <path>`.
This PR does not publish to npm, implement `create-cordisx-plugin`, extract a
public launcher-core package, or ship a native app. Those remain the later PR
boundaries above.

Platform capabilities, structured UI, and localization work may land before
the mechanical monorepo move. The move must start from their merged commits so
parallel feature branches are not forced through path-only conflicts.

## Validation boundary

Automated validation covers:

- missing-config first launch and explicit idempotent setup;
- invalid JSON, unsupported versions, migration failure, atomic replacement,
  and restrictive file permissions;
- default-app and profile precedence;
- creation and reuse of a missing shared-Host profile;
- explicit shared/host-isolated choice and adapter launch-plan projection;
- unknown, unavailable, and launch-incapable adapter diagnostics;
- separation of CordisX arguments from arguments after `--`;
- workspace install, typecheck, unit/integration tests, and clean build;
- exact `npm pack` contents with no tests, source-only bin, private docs, or
  developer configuration leakage;
- temporary installation and execution of every package bin;
- generated plugin install, typecheck, test, pack, and manifest validation;
- release tag/version agreement, provenance, and registry maintainer readback.

Live validation covers an independent shared-Host Codex launch alongside the
ordinary Host, a `host-isolated` opt-in profile, manager visibility, shutdown
cleanup, and proof that the user's account data and ordinary host process were
not modified.
Claude Code or any other host requires its own adapter fixtures and live smoke
before its command example is described as implemented.
