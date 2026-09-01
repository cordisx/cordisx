# CordisX 启动问题自助排查

## 怎么知道 CordisX 为什么没有启动？

运行只读诊断：

```bash
npx cordisx@beta doctor
```

`ready` 表示 CordisX 已找到可用宿主并生成启动方案。`unavailable` 会说明缺少
什么，或哪一步无法解析。

## 需要先运行 setup 吗？

不需要。首次正常启动时，CordisX 会在需要时自动创建配置。

## 为什么命令里有 `@beta`？

当前可用的预发布版本位于 `beta` 通道。首个稳定版发布前，不带通道的 npm
包仍是包名占位版。

## Node.js 版本不支持怎么办？

CordisX 当前需要 Node.js 22.19 或更高版本。更新 Node.js 后重新运行启动命令。

## CordisX 找不到 Codex Desktop 怎么办？

请先安装 Codex Desktop。CordisX 会自动检查受支持的 macOS 应用位置。如果安装在
非标准位置，可使用[完整公测指南](getting-started.md#npm-beta-installation)中的高级启动选项。

## 启动后需要重新登录吗？

默认启动会打开独立的 Codex 窗口，同时沿用已有账号、会话、项目和模型配置。
完全隔离宿主数据属于高级 profile 选项。

## CordisX 会覆盖我原来的 Skills 吗？

不会。默认启动使用 `shared` 数据模式，继续读取用户原有的个人 Skills 和当前
仓库中的 Skills。CordisX 只管理自己内置的插件开发 Skill，不会替换或删除用户
已有的内容。

## `shared` 和 `host-isolated` 有什么区别？

默认的 `shared` 模式使用独立的 CordisX 窗口和 Chromium profile，但沿用当前
用户的 Codex 数据与个人 Skills。

`host-isolated` 会为这个 CordisX profile 使用独立的 Host home，因此不会读取
真实用户 home 中的个人 Skills；当前仓库中的 Skills 和 CordisX 内置的插件开发
Skill 仍然可用。只有需要隔离账号、会话或其他宿主数据时才使用它：

```bash
npx cordisx@beta codex work --data host-isolated
```

## 启动后可以直接让 Codex 开发插件吗？

可以。直接用自然语言描述你想加入的功能即可，例如“我要发送按钮在点击时
全屏放礼花”。CordisX 内置的插件开发 Skill 会负责后续的项目准备、实现、
Playground 运行与验证。

## 在哪里查看完整启动选项？

profile、诊断、全局安装、外部 Provider 和高级启动模式见
[完整公测指南](getting-started.md#npm-beta-installation)。
