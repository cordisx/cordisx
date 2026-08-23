<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./packages/cli/assets/brand/cordisx-mark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="./packages/cli/assets/brand/cordisx-mark-light.svg">
    <img alt="CordisX three-ring spherical mark" src="./packages/cli/assets/brand/cordisx-mark-light.svg" width="180">
  </picture>
</p>

# CordisX

让每一个 AI 编程客户端，都成为你的工作台。

CordisX 是面向 AI 编程工具的开放扩展生态。它让原本固定的客户端成为可以持续生长的工作空间，让用户按照自己的习惯组织工具、任务和上下文，也让开发者把新的交互、能力与完整工作流带到工作真正发生的地方。

## Beta 快速开始

需要 Node.js 22.19 或更高版本，并已安装 Codex Desktop。当前功能版本只在
`beta` 通道；`latest` 仍是不可用的包名占位版本。

```bash
npx cordisx@beta setup
npx cordisx@beta codex --dry-run
npx cordisx@beta codex
```

`setup` 会创建 `~/.cordisx/config.json`，默认从 `plugins: []` 开始，不会
自动启用示例插件。默认 profile 共享现有 Codex 账号、会话、项目和模型配置；
需要独立宿主数据时，创建一个隔离 profile：

```bash
npx cordisx@beta codex default --data shared
npx cordisx@beta codex work --data isolated
```

创建并验证一个最小插件：

```bash
npm create cordisx-plugin@beta my-plugin
cd my-plugin
npm install
npm run check
npm run dev:dry-run
npm run dev
```

`dev:dry-run` 只验证构建兼容性；`dev` 才会启动单独的 CordisX 开发宿主。
完整使用说明见[用户快速上手](.agents/docs/getting-started.md)，版本、CLI、
profile 与发布边界见[分发和 CLI 文档](.agents/docs/distribution-and-cli.md)。

## 许可与商业插件

CordisX 自有的 host、runtime、CLI、manager、launcher、adapter 和脚手架
工具本体采用 `AGPL-3.0-or-later`。商业使用和集成 CordisX 自有代码是允许
的，但必须遵守 AGPL，包括适用的源码提供义务。完整条款见
[LICENSE](LICENSE)。

[CordisX Independent Plugin Exception](CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md)
是 AGPLv3 第 7 节的附加许可：仅通过公开、版本化 CordisX 插件接口交互的
独立插件，以及为实现插件所必需使用的公开接口声明、类型、schema 和脚手架
明确标识的模板/生成结果，可以商业、收费、在商店分发，并由插件作者选择
自己的许可证。

该例外不覆盖 CordisX host/runtime/CLI/manager/launcher 的复制、嵌入、
修改、重新打包、竞争性宿主实现或非公开接口使用；这些仍受 AGPL 约束。
package metadata 只使用标准 SPDX `AGPL-3.0-or-later`，不会伪造自定义
`WITH` 表达式。该 CordisX 专用例外不是标准 SPDX 例外，也没有经过 OSI
或 FSF 审核；建议在 stable 前完成法律审阅。

## 插件应该生长在成熟工具里

一个好插件不应该要求用户先换掉熟悉的工具，也不应该迫使开发者重新搭建账号、模型、项目、任务和会话系统。

CordisX 选择把插件带进已经成熟的 AI 编程工具。插件可以专注解决真正的问题，用户则继续使用自己信任的工作环境；新的能力不再是一座孤岛，而是工作台自然生长出来的一部分。

## 站在 Codex 与 DSH 的肩膀上

CordisX 向 [Codex](https://github.com/openai/codex) 与 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/DeepSeek-Harness)致敬。

Codex 展示了成熟 AI 编程工作空间所能提供的体验，DSH 展示了 Cordis 驱动的插件体系如何让能力被组合与扩展。CordisX 希望把两者连接起来：让开放的插件生态进入成熟工具，而不需要为每个创意重新制造一套 Agent Harness 或桌面应用。

## 你负责创造，CordisX 负责脏活累活

插件开发者只需要定义自己想提供的操作、数据、页面和业务逻辑，并声明需要使用的宿主能力。CordisX 负责处理不同工具之间的差异，以及界面融合、页面导航、加载与清理、国际化、权限询问、模型与任务接入、配置管理、兼容性诊断和插件发现。

开发者不需要为每个宿主重复适配，也不需要再解决成熟工具已经解决过的问题。写一次插件，就可以把精力留给真正有价值的体验。

## 一个由用户决定的开放生态

用户可以从 CordisX 社区、自定义商店或团队内部来源发现和组合插件，也可以决定每项能力是询问、拒绝还是允许。插件可以被搜索、配置、授权、停用、替换和分享，而用户始终掌握自己的工作空间。

CordisX 不希望把插件锁在某一个商店、模型或客户端中。它最终连接的是开发者的创造、社区的协作，以及每个人独一无二的工作方式。

更多开发与架构资料见 [.agents/docs](.agents/docs/README.md)。
