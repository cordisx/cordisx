<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./packages/cli/assets/brand/cordisx-mark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="./packages/cli/assets/brand/cordisx-mark-light.svg">
    <img alt="CordisX three-ring spherical mark" src="./packages/cli/assets/brand/cordisx-mark-light.svg" width="180">
  </picture>
</p>

<p align="center">
  <a href="./README.md">English</a> | 简体中文
</p>

<h1 align="center">CordisX</h1>

## 启动 CordisX

```bash
npx cordisx@beta
```

<details>
<summary>安装 CordisX</summary>

```bash
npm install --global cordisx@beta
cordisx
```

</details>

没有正常启动？查看[启动问题自助排查](./.agents/docs/startup-qa.zh-CN.md)。

<p align="center">
  <a href="https://cordisx.github.io/#showcase">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/cordisx/cordisx.github.io/3e188f355fd5ddb8ed74749fbaa16b138531d7f6/assets/screenshots/codex-workspace-real-zh.png">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/cordisx/cordisx.github.io/3e188f355fd5ddb8ed74749fbaa16b138531d7f6/assets/screenshots/codex-workspace-real-zh-light.png">
      <img alt="CordisX 启动后的 Codex 工作区" src="https://raw.githubusercontent.com/cordisx/cordisx.github.io/3e188f355fd5ddb8ed74749fbaa16b138531d7f6/assets/screenshots/codex-workspace-real-zh-light.png">
    </picture>
  </a>
</p>

## 开发插件

启动 CordisX 后，直接告诉 Codex 你想加入什么功能。例如：

```text
我要发送按钮在点击的时候全屏放礼花。
```

CLI 内置了支撑这一开发方式的 `cordisx-plugin-development` Skill。每次非
dry-run 的 CordisX 自有 Host 启动或 `cordisx dev` 运行都会安装或更新其托管
副本。摘要校验会保护用户改动：用户编辑过或与现有目录冲突的副本会被保留并报告，
不会被覆盖。

<!--
AI-first plugin demo source, recorder, and update workflow:
https://github.com/cordisx/cordisx.github.io/blob/main/.agents/docs/ai-plugin-demo-capture.md
Regenerate and verify media in cordisx/cordisx.github.io before updating the pinned URLs below.
-->
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/cordisx/cordisx.github.io/6078127db936d8932c41f63fa48c14d41ae90b62/assets/motion/cordisx-ai-plugin-demo-zh-dark.gif">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/cordisx/cordisx.github.io/6078127db936d8932c41f63fa48c14d41ae90b62/assets/motion/cordisx-ai-plugin-demo-zh-light.gif">
    <img alt="在 CordisX 中用自然语言创建 Send Confetti 插件" src="https://raw.githubusercontent.com/cordisx/cordisx.github.io/6078127db936d8932c41f63fa48c14d41ae90b62/assets/motion/cordisx-ai-plugin-demo-zh-light.gif" width="900">
  </picture>
</p>

如果要直接写代码，创建器支持独立单插件、专用多插件工作区、嵌入已有业务项目
三种形态：

```bash
npm create cordisx-plugin@beta my-plugin
npx create-cordisx-plugin@beta --mode workspace my-suite --plugin chatroom --plugin calendar
npx create-cordisx-plugin@beta --mode embedded ./business-project --plugin chatroom
```

嵌入模式会在 `.cordisx/plugins/` 下创建插件，并使用独立的
`.cordisx/package.json` 与 TypeScript 配置。已有项目采用受支持的 pnpm、npm、
Yarn 或 Bun workspace 时会直接接入；否则依赖保留在独立的 `.cordisx` 环境中。

专用工作区使用 `cordisx.config.json`，嵌入项目使用 `.cordisx/config.json`；
两种配置都可以列出多个插件入口，路径相对配置文件解析。运行 `cordisx dev` 时，
Host 源码与所有启用的本地插件入口共享一个 Vite ESM/HMR graph。只包含组件的
React 模块变更使用 Fast Refresh 并保留组件状态；入口、manifest、`apply` 或不
安全边界的变更会替换所属插件的整个 generation。

## 文档

- [产品概览](./.agents/docs/product-overview.zh-CN.md)
- [文档索引](./.agents/docs/README.md)
- [公开文档站](https://cordisx.github.io/docs/)
- [问题与反馈](https://github.com/cordisx/cordisx/issues)

## 许可证

CordisX 采用 [AGPL-3.0-or-later](./LICENSE)。仅使用已公开、版本化
接口且符合条款的独立插件，可依据
[CordisX Independent Plugin Exception](./CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md)
自行选择许可证。准确范围以这两个文件为准。
