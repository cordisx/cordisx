<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./packages/cli/assets/brand/cordisx-mark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="./packages/cli/assets/brand/cordisx-mark-light.svg">
    <img alt="CordisX three-ring spherical mark" src="./packages/cli/assets/brand/cordisx-mark-light.svg" width="180">
  </picture>
</p>

<p align="center">
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/github/license/cordisx/cordisx?style=flat-square"></a>
  <a href="https://github.com/cordisx/cordisx/actions/workflows/check.yml"><img alt="Check status" src="https://github.com/cordisx/cordisx/actions/workflows/check.yml/badge.svg?branch=main"></a>
  <a href="https://cordisx.github.io/docs/"><img alt="Documentation site status" src="https://img.shields.io/website?url=https%3A%2F%2Fcordisx.github.io%2Fdocs%2F&amp;label=docs&amp;style=flat-square"></a>
</p>

<p align="center">
  English | <a href="./README.zh-CN.md">简体中文</a>
</p>

<h1 align="center">CordisX</h1>

<p align="center"><strong>Extend everything extensible with Cordis.</strong></p>

<p align="center">
  <a href="https://cordisx.github.io/"><strong>Explore CordisX</strong></a>
  · <a href="./.agents/docs/getting-started.md#local-setup">Developer guide</a>
  · <a href="https://github.com/cordisx/cordisx/issues">Feedback</a>
</p>

CordisX is a plugin platform for established AI development tools. It turns the
workspace people already know into a place where new tools, context, and
workflows can feel like a natural part of the product.

## Plugins belong where the work already happens

A useful plugin should not ask people to abandon a familiar tool. It should not
need to rebuild accounts, models, projects, tasks, conversations, or an entire
desktop shell just to deliver one great idea.

CordisX brings plugins into mature AI development tools. Users keep the
environment they trust, while plugin authors focus on the problem they want to
solve. New capabilities become part of the workspace instead of another island
beside it.

## You create the experience. CordisX handles the hard parts.

Plugin authors describe their actions, data, pages, and business logic. CordisX
takes responsibility for the repetitive, error-prone platform work around them:

- **Host adaptation** — one plugin model across host-specific integration
  details.
- **Lifecycle** — predictable loading, updates, cleanup, and failure handling.
- **Structured UI** — host-rendered actions, navigation, menus, information,
  and pages instead of every plugin patching the shell.
- **Consistent interaction** — native-feeling layout, keyboard behavior,
  accessibility, and responsive presentation.
- **Product infrastructure** — localization, configuration, permission
  mediation, compatibility, discovery, and distribution.

The result is less integration glue for developers and a more coherent,
controllable workspace for users.

## Inspired by Codex and DeepSeek Harness

CordisX is inspired by the product experience of
[Codex](https://github.com/openai/codex) and the composable Cordis plugin model
demonstrated by [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/DeepSeek-Harness).

DSH shows how an extensible harness can make capabilities composable. CordisX
builds on that idea so a plugin does not have to live only inside the harness's
own interface—it can meet users inside mature tools they already rely on. We
are grateful for both projects and aim to extend their ideas with care.

CordisX is an independent, unofficial project. It is not affiliated with or
endorsed by OpenAI or DeepSeek.

## Quick start

Use Node.js 22.19 or newer and install Codex Desktop first. The functional
prerelease is on the `beta` channel; unqualified npm commands still resolve the
non-functional `0.0.0` name reservation on `latest`.

```bash
npx cordisx@beta setup
npx cordisx@beta codex --dry-run
npx cordisx@beta codex
```

`setup` creates `~/.cordisx/config.json` with `providers: []` and `plugins: []`. The default profile
shares the existing Codex account, conversations, projects, and models; use an
isolated named profile when its host data should also be separate:

```bash
npx cordisx@beta codex default --data shared
npx cordisx@beta codex work --data isolated
```

For a global command, install the same explicit channel with
`npm install --global cordisx@beta`. See the
[complete beta guide](./.agents/docs/getting-started.md#npm-beta-installation)
and [CLI and distribution details](./.agents/docs/distribution-and-cli.md).
For multiple external model/session providers, see
[CLIProxyAPI provider configuration](./.agents/docs/getting-started.md#configure-cliproxyapi-providers).

## Build a plugin

CordisX plugins use the Cordis lifecycle and contribute structured host data or
mount a page in a CordisX-owned outlet. The host keeps control of rendering,
interaction, localization, and cleanup, so plugins stay focused on their own
workflow.

Create and verify a minimal plugin directly from the beta registry package:

```bash
npm create cordisx-plugin@beta my-plugin
cd my-plugin
npm install
npm run check
npm run dev:dry-run
npm run dev
```

`dev:dry-run` checks the build without launching Codex; `dev` starts the
separate development host. Continue with the
[minimal plugin guide](./.agents/docs/getting-started.md#create-a-plugin) and the
[slot showcase](./examples/plugins/slot-showcase/README.md).

## Ecosystem and community

- [Website](https://cordisx.github.io/) — product overview and project entry.
- [Documentation](https://cordisx.github.io/docs/) — public guides and
  architecture.
- [Marketplace](https://cordisx.github.io/marketplace/) — the current
  read-only discovery experience.
- [GitHub organization](https://github.com/cordisx) — CordisX repositories and
  ecosystem projects.
- [Issues](https://github.com/cordisx/cordisx/issues) — questions, feedback,
  and bug reports.

## License

The CordisX-owned host, runtime, CLI, manager, launcher, adapter, and scaffolder
are licensed under [AGPL-3.0-or-later](./LICENSE). The
[CordisX Independent Plugin Exception](./CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md)
is an AGPLv3 section 7 additional permission for qualifying independent plugins
that use only documented, versioned public plugin interfaces.

Read both files for the exact terms. The CordisX-specific exception is not a
standard SPDX exception and has not been reviewed by OSI or FSF; legal review is
recommended before the stable release.

## Honest status

Available in the current source tree:

- a functional CordisX CLI and Codex host adapter for local evaluation;
- reversible Cordis lifecycles, structured shell contributions, pages, and
  localization;
- a built-in manager for plugins, extension points, routes, discovery, and
  local configuration;
- a scoped, Host-owned form system backed by a verified official TDesign Web
  Components subset, with macOS-style grouped settings information architecture,
  validation, responsive layout, accessibility, and live App-theme projection;
- registry-verified `beta` packages for the CLI and plugin scaffolder;
- a plugin project scaffolder with generated-project validation; and
- coordinated beta packaging, licensing, and release automation.

Not shipped as public product capabilities yet:

- a stable npm channel or signed native distribution;
- marketplace install, update, signing, activation, and rollback;
- an untrusted-plugin sandbox—current plugins are trusted local renderer code,
  and cooperative permission policies are not process isolation; and
- launch-capable adapters for hosts other than Codex.

For the complete implementation boundary and roadmap, continue with the
[CordisX documentation index](./.agents/docs/README.md).
