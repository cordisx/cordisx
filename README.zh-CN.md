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
  <a href="./README.md">English</a> | 简体中文
</p>

<h1 align="center">CordisX</h1>

<p align="center"><strong>用 Cordis 扩展可扩展的一切。</strong></p>

<p align="center">
  <a href="https://cordisx.github.io/"><strong>探索 CordisX</strong></a>
  · <a href="./.agents/docs/getting-started.md#local-setup">开发者指南</a>
  · <a href="https://github.com/cordisx/cordisx/issues">反馈与交流</a>
</p>

CordisX 是面向成熟 AI 开发工具的插件平台。它让用户已经熟悉的工作空间
继续生长，让新的工具、上下文和完整工作流自然地成为产品的一部分。

## 插件应该生长在工作真正发生的地方

一个有价值的插件不应该要求用户放弃熟悉的工具，也不应该为了实现一个好
创意，就重新搭建账号、模型、项目、任务、会话乃至整个桌面应用。

CordisX 把插件带进成熟的 AI 开发工具。用户继续使用自己信任的工作环境，
插件开发者则专注解决真正的问题；新的能力不再是一座孤岛，而是工作台自然
生长出来的一部分。

## 你负责创造，CordisX 负责脏活累活

插件开发者只需要描述操作、数据、页面和业务逻辑。围绕它们那些重复、易错的
平台工作，由 CordisX 统一处理：

- **宿主适配**——用统一的插件模型吸收不同工具的集成差异。
- **生命周期**——让加载、更新、清理和故障处理可预测、可恢复。
- **结构化 UI**——由宿主统一渲染操作、导航、菜单、信息和页面，而不是让
  每个插件自行修改外壳。
- **一致交互**——统一布局、键盘操作、无障碍和响应式呈现，让体验融入宿主。
- **产品基础设施**——统一处理本地化、配置、权限协调、兼容性、发现与分发。

开发者因此可以少写集成胶水，把精力留给真正有价值的体验；用户也能得到更
一致、更可控的工作空间。

## 受 Codex 与 DeepSeek Harness 启发

CordisX 受 [Codex](https://github.com/openai/codex) 的产品体验，以及
[DeepSeek Harness（DSH）](https://github.com/deepseek-ai/DeepSeek-Harness)
所展示的 Cordis 可组合插件模型启发。

DSH 证明了一个可扩展 Harness 可以让能力被自由组合。CordisX 希望沿着这一
思路继续前进：插件不必只活在 Harness 自己的界面里，也可以走进用户已经依赖
的成熟工具。我们由衷感谢这两个项目，并会以尊重、审慎的方式延展它们的理念。

CordisX 是独立的非官方项目，与 OpenAI 或 DeepSeek 不存在隶属或背书关系。

## 快速开始

请先安装 Node.js 22.19 或更高版本与 Codex Desktop。可用的预发布版本位于
`beta` 通道；不带通道的 npm 命令仍会解析到 `latest` 上不可运行的 `0.0.0`
包名占位版本。

```bash
npx cordisx@beta setup
npx cordisx@beta codex --dry-run
npx cordisx@beta codex
```

`setup` 会创建 `~/.cordisx/config.json`，默认内容包含 `providers: []` 和 `plugins: []`。默认
profile 会启动独立 Codex 窗口和持久 Chromium profile，同时通过 `HOME` 与
`CODEX_HOME` 沿用已有账号、会话、项目和模型；只有宿主数据本身也要隔离时，才使用
`host-isolated`：

```bash
npx cordisx@beta codex default --data shared
npx cordisx@beta codex work --data host-isolated
```

如需全局命令，请安装同一个明确通道：
`npm install --global cordisx@beta`。完整说明见
[公测上手指南](./.agents/docs/getting-started.md#npm-beta-installation)和
[CLI 与分发文档](./.agents/docs/distribution-and-cli.md)。
多外部模型与会话 Provider 的配置方式见
[CLIProxyAPI Provider 配置](./.agents/docs/getting-started.md#configure-cliproxyapi-providers)。

## 开发插件

CordisX 插件使用 Cordis 生命周期，通过结构化数据向宿主贡献界面，或在
CordisX 管理的页面容器中挂载复杂内容。渲染、交互、本地化和清理由宿主统一
负责，插件只需要专注自己的工作流。

直接使用 registry 上的公测脚手架创建并验证一个最小插件：

```bash
npm create cordisx-plugin@beta my-plugin
cd my-plugin
npm install
npm run check
npm run dev:dry-run
npm run dev
```

`dev:dry-run` 只检查构建，不启动 Codex；`dev` 会启动独立开发宿主。更多说明见
[最小插件指南](./.agents/docs/getting-started.md#create-a-plugin)和
[扩展点示例](./examples/plugins/slot-showcase/README.md)。

## 生态、文档与社区

- [官方网站](https://cordisx.github.io/)——产品介绍与项目入口。
- [公开文档](https://cordisx.github.io/docs/)——使用指南与架构资料。
- [插件商店](https://cordisx.github.io/marketplace/)——当前只读的插件发现体验。
- [GitHub 组织](https://github.com/cordisx)——CordisX 仓库与生态项目。
- [Issues](https://github.com/cordisx/cordisx/issues)——问题、反馈与缺陷报告。

## 许可证

CordisX 自有的 host、runtime、CLI、manager、launcher、adapter 和脚手架采用
[AGPL-3.0-or-later](./LICENSE)。
[CordisX Independent Plugin Exception](./CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md)
是 AGPLv3 第 7 节的附加许可，适用于只使用已公开、版本化插件接口且满足条款
要求的独立插件。

准确范围以这两个文件为准。CordisX 专用例外不是标准 SPDX 例外，也没有经过
OSI 或 FSF 审核；建议在 stable 发布前完成法律审阅。

## 诚实状态

当前源码已经具备：

- 可用于本地评估的功能性 CordisX CLI 与 Codex 宿主适配器；
- 可逆的 Cordis 生命周期、结构化界面贡献、页面与本地化；
- 管理插件、扩展点、路由、发现和本地配置的内置管理器；
- 基于核验过的 TDesign 官方 Web Components 子集、由宿主完整持有且样式隔离的
  表单体系，采用 macOS 设置式分组信息架构，覆盖校验、响应式布局、无障碍与
  App 主题动态切换；
- 已通过 registry 安装验证的 CLI 与插件脚手架 `beta` 包；
- 带有生成项目验证的插件脚手架；以及
- 协同版本的公测打包、许可和发布自动化。

尚未作为公开产品能力交付：

- npm stable 通道或已签名的原生发行版；
- 从插件商店安装、更新、签名、激活与回滚；
- 不受信任插件的安全沙箱——当前插件仍是受信任的本地 renderer 代码，协作式
  权限策略不等于进程隔离；以及
- Codex 之外可启动的宿主适配器。

完整实现边界与后续阶段见
[CordisX 文档索引](./.agents/docs/README.md)。
