<p align="center">
  <picture>
    <source
      media="(prefers-color-scheme: dark)"
      srcset="./packages/cli/assets/brand/cordisx-mark-dark.svg"
    >
    <source
      media="(prefers-color-scheme: light)"
      srcset="./packages/cli/assets/brand/cordisx-mark-light.svg"
    >
    <img
      alt="CordisX three-ring spherical mark"
      src="./packages/cli/assets/brand/cordisx-mark-light.svg"
      width="180"
    >
  </picture>
</p>

<p align="center">
  English | <a href="./README.zh-CN.md">简体中文</a>
</p>

<h1 align="center">CordisX</h1>

## Start CordisX

```bash
npx cordisx@beta
```

<details>
<summary>Install CordisX</summary>

```bash
npm install --global cordisx@beta
cordisx
```

</details>

If it does not start, use the
[startup Q&A](./.agents/docs/startup-qa.md) to identify the issue.

<p align="center">
  <a href="https://cordisx.github.io/#showcase">
    <picture>
      <source
        media="(prefers-color-scheme: dark)"
        srcset="https://raw.githubusercontent.com/cordisx/cordisx.github.io/3e188f355fd5ddb8ed74749fbaa16b138531d7f6/assets/screenshots/codex-workspace-real.png"
      >
      <source
        media="(prefers-color-scheme: light)"
        srcset="https://raw.githubusercontent.com/cordisx/cordisx.github.io/3e188f355fd5ddb8ed74749fbaa16b138531d7f6/assets/screenshots/codex-workspace-real-light.png"
      >
      <img
        alt="Codex workspace launched by CordisX"
        src="https://raw.githubusercontent.com/cordisx/cordisx.github.io/3e188f355fd5ddb8ed74749fbaa16b138531d7f6/assets/screenshots/codex-workspace-real-light.png"
      >
    </picture>
  </a>
</p>

## Build a plugin

After CordisX starts, tell Codex what you want to add. For example:

```text
Make the send button launch full-screen confetti when clicked.
```

The CLI ships with the `cordisx-plugin-development` Skill that supports this
workflow. Each non-dry-run CordisX-owned Host launch or `cordisx dev` run
installs or updates its managed copy. Digest checks protect user changes: an
edited or conflicting copy is preserved and reported instead of overwritten.

<!--
AI-first plugin demo source, recorder, and update workflow:
https://github.com/cordisx/cordisx.github.io/blob/main/.agents/docs/ai-plugin-demo-capture.md
Regenerate and verify media in cordisx/cordisx.github.io before updating the pinned URLs below.
-->
<p align="center">
  <picture>
    <source
      media="(prefers-color-scheme: dark)"
      srcset="https://raw.githubusercontent.com/cordisx/cordisx.github.io/6078127db936d8932c41f63fa48c14d41ae90b62/assets/motion/cordisx-ai-plugin-demo-en-dark.gif"
    >
    <source
      media="(prefers-color-scheme: light)"
      srcset="https://raw.githubusercontent.com/cordisx/cordisx.github.io/6078127db936d8932c41f63fa48c14d41ae90b62/assets/motion/cordisx-ai-plugin-demo-en-light.gif"
    >
    <img
      alt="Create the Send Confetti plugin in CordisX with natural language"
      src="https://raw.githubusercontent.com/cordisx/cordisx.github.io/6078127db936d8932c41f63fa48c14d41ae90b62/assets/motion/cordisx-ai-plugin-demo-en-light.gif"
      width="900"
    >
  </picture>
</p>

For code-first development, the creator supports standalone, dedicated
multi-plugin workspace, and embedded business-project layouts:

```bash
npm create cordisx-plugin@beta my-plugin
npx create-cordisx-plugin@beta --mode workspace my-suite --plugin chatroom --plugin calendar
npx create-cordisx-plugin@beta --mode embedded ./business-project --plugin chatroom
```

Embedded mode creates plugins under `.cordisx/plugins/` with their own
`.cordisx/package.json` and TypeScript configuration. It joins an existing
pnpm, npm, Yarn, or Bun workspace when supported; otherwise dependencies stay
inside the independent `.cordisx` environment.

A dedicated workspace uses `cordisx.config.json`; an embedded project uses
`.cordisx/config.json`. Either config can list multiple plugin entries, with
paths resolved relative to that config file. During `cordisx dev`, Host source
and all enabled local plugin entries share one Vite ESM/HMR graph. Changes in
component-only React modules use Fast Refresh and preserve component state;
entry, manifest, `apply`, or unsafe-boundary changes replace the owning plugin
generation.

## Documentation

- [Product overview](./.agents/docs/product-overview.md)
- [Documentation index](./.agents/docs/README.md)
- [Documentation site](https://cordisx.github.io/docs/)
- [Questions and feedback](https://github.com/cordisx/cordisx/issues)

## License

CordisX is licensed under [AGPL-3.0-or-later](./LICENSE). Qualifying independent
plugins that use only documented, versioned public interfaces may choose their
own licenses under the
[CordisX Independent Plugin Exception](./CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md).
See both files for the exact terms.
