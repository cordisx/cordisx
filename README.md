<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./packages/cli/assets/brand/cordisx-mark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="./packages/cli/assets/brand/cordisx-mark-light.svg">
    <img alt="CordisX three-ring spherical mark" src="./packages/cli/assets/brand/cordisx-mark-light.svg" width="180">
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
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/cordisx/cordisx.github.io/3e188f355fd5ddb8ed74749fbaa16b138531d7f6/assets/screenshots/codex-workspace-real.png">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/cordisx/cordisx.github.io/3e188f355fd5ddb8ed74749fbaa16b138531d7f6/assets/screenshots/codex-workspace-real-light.png">
      <img alt="Codex workspace launched by CordisX" src="https://raw.githubusercontent.com/cordisx/cordisx.github.io/3e188f355fd5ddb8ed74749fbaa16b138531d7f6/assets/screenshots/codex-workspace-real-light.png">
    </picture>
  </a>
</p>

## Build a plugin

After CordisX starts, tell Codex what you want to add. For example:

```text
Make the send button launch full-screen confetti when clicked.
```

The result is an independently installable plugin. Plugins use the capabilities
CordisX exposes; when one is missing, you can contribute it to CordisX or the
underlying Cordis runtime. See
[plugin capabilities and contribution paths](./.agents/docs/plugin-capabilities.md).

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/cordisx/cordisx.github.io/6078127db936d8932c41f63fa48c14d41ae90b62/assets/motion/cordisx-ai-plugin-demo-en-dark.gif">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/cordisx/cordisx.github.io/6078127db936d8932c41f63fa48c14d41ae90b62/assets/motion/cordisx-ai-plugin-demo-en-light.gif">
    <img alt="Create the Send Confetti plugin in CordisX with natural language" src="https://raw.githubusercontent.com/cordisx/cordisx.github.io/6078127db936d8932c41f63fa48c14d41ae90b62/assets/motion/cordisx-ai-plugin-demo-en-light.gif" width="900">
  </picture>
</p>

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
