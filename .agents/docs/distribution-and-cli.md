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
cordisx [app] [profile] [--data shared|isolated] [options] [-- host-arguments...]
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
npx cordisx codex work --data isolated
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
persists an isolated-data profile before launch. Profile ids use the portable
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
          "dataMode": "isolated"
        }
      }
    }
  }
}
```

The persisted document is versioned and strictly validated. Writes use a
same-directory temporary file, fsync where available, atomic rename, and user-
only permissions. A migration preserves unknown future fields only when their
owning schema allows them; a failed migration leaves the last readable file in
place and reports a recovery path.

`cordisx setup` and implicit first launch call the same idempotent
`ensureHomeConfig()` operation:

1. return the validated configuration when it already exists;
2. migrate an older supported version atomically;
3. in an interactive terminal, offer detected launch-capable apps and choose a
   default app/profile;
4. in a non-interactive environment, use deterministic defaults or fail with
   the exact missing choice rather than waiting for input;
5. create the parent directory and initial configuration without overwriting an
   unrelated or invalid file.

Resolution precedence is CLI option, named profile, app default, global
default, then adapter default. Every resolved launch plan is inspectable through
`cordisx doctor` without starting the host.

## Shared and isolated data

`dataMode` is a host-neutral choice with two values:

- `shared` integrates the host's existing account, conversations, projects,
  models, and host configuration while CordisX retains its own UI/runtime state;
- `isolated` gives the named profile independent host data roots as well as
  independent CordisX state, so it can sign in and evolve separately.

The adapter translates this intent into host-specific environment variables,
directories, and launch arguments. The CLI must not know that one host uses
`CODEX_HOME` while another uses different roots. An adapter must enumerate the
roots it shares or isolates in the doctor output and tests; a mode is
unavailable until that adapter can enforce it completely.

CordisX never modifies an installed host application. Shared data does not mean
shared renderer processes, debugging endpoints, UI storage, or window state.

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

The first migration may keep runtime and Codex-adapter source inside
`packages/cli` while package boundaries are extracted in later reviewable PRs.
It must not invent empty public packages to reserve names.

Repository ownership does not change:

- `cordisx-protocol` continues to own normative schemas and conformance; its
  future npm package is `@cordisx/protocol` and is published from that repo;
- `marketplace` continues to own catalog data and feed generation;
- `cordisx` owns the launcher, product runtime, adapters, SDK implementation,
  scaffolder, and release automation.

The canonical unscoped `cordisx` package owns the friendly CLI. There is no
duplicate `@cordisx/cli` package. `create-cordisx-plugin` owns
`npm create cordisx-plugin@latest`; its generated project depends only on public
SDK/protocol surfaces and never imports monorepo-private paths.

## Package and release contract

A name is considered owned only after a functional package is published and
the registry reports the intended maintainers. A local `name` field or registry
404 is not ownership. Placeholder packages, misleading packages, and unusable
tarballs are forbidden.

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

Platform capabilities, structured UI, and localization work may land before
the mechanical monorepo move. The move must start from their merged commits so
parallel feature branches are not forced through path-only conflicts.

## Validation boundary

Automated validation covers:

- missing-config first launch and explicit idempotent setup;
- invalid JSON, unsupported versions, migration failure, atomic replacement,
  and restrictive file permissions;
- default-app and profile precedence;
- creation and reuse of a missing named isolated profile;
- explicit shared/isolated choice and adapter launch-plan projection;
- unknown, unavailable, and launch-incapable adapter diagnostics;
- separation of CordisX arguments from arguments after `--`;
- workspace install, typecheck, unit/integration tests, and clean build;
- exact `npm pack` contents with no tests, source-only bin, private docs, or
  developer configuration leakage;
- temporary installation and execution of every package bin;
- generated plugin install, typecheck, test, pack, and manifest validation;
- release tag/version agreement, provenance, and registry maintainer readback.

Live validation covers one shared-data Codex launch, one newly created isolated
Codex profile reused on a second launch, manager visibility, shutdown cleanup,
and proof that the user's ordinary host process and data were not modified.
Claude Code or any other host requires its own adapter fixtures and live smoke
before its command example is described as implemented.
