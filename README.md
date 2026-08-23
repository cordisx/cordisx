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

<p align="center"><strong>Let plugins meet users where AI work already happens.</strong></p>

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

The beta package metadata and release automation are prepared, but the
functional public beta has not yet been published to npm. Registry readback
currently shows only the non-functional `0.0.0` name reservations, so this
README intentionally does not show an npm install or `npx` launch command yet.

To evaluate the current implementation from source, follow the
[local setup guide](./.agents/docs/getting-started.md#local-setup). Copy-and-paste
registry commands will appear here only after the beta packages are published
and verified from the registry.

## Build a plugin

CordisX plugins use the Cordis lifecycle and contribute structured host data or
mount a page in a CordisX-owned outlet. The host keeps control of rendering,
interaction, localization, and cleanup, so plugins stay focused on their own
workflow.

Start with the [minimal plugin guide](./.agents/docs/getting-started.md#minimal-plugin)
and the [slot showcase](./examples/plugins/slot-showcase/README.md). The
in-repository scaffolder is implemented and release-ready, but its functional
npm beta has not been published yet.

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
- a plugin project scaffolder with generated-project validation; and
- coordinated beta packaging, licensing, and release automation.

Not shipped as public product capabilities yet:

- a functional npm beta or signed native distribution;
- marketplace install, update, signing, activation, and rollback;
- an untrusted-plugin sandbox—current plugins are trusted local renderer code,
  and cooperative permission policies are not process isolation; and
- launch-capable adapters for hosts other than Codex.

For the complete implementation boundary and roadmap, continue with the
[CordisX documentation index](./.agents/docs/README.md).
