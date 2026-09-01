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
    <img alt="CordisX 启动后的 Codex 工作区" src="https://raw.githubusercontent.com/cordisx/cordisx.github.io/86dbcbcaf9baccc5e9a5f4e0f25b33789a3917a9/assets/screenshots/codex-workspace-real-light.png">
  </a>
</p>

## 开发插件

启动 CordisX 后，直接告诉 Codex 你想加入什么功能。例如：

```text
我要发送按钮在点击时全屏放礼花。
```

CordisX 内置插件开发 Skill。Codex 会把你的需求实现为插件，并在 CordisX
Playground 中运行和验证。你不需要预先安装 Skill、创建脚手架或了解插件的
底层命令。

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
