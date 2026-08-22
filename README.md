# CordisX

CordisX 是一个实验性的 Codex Desktop 界面插件宿主，兼容独立 `Codex.app` 和当前承载 Codex 的 `ChatGPT.app`。它组合了两类现有思路：

- 参考 CodexPlusPlus，以独立启动器给 Codex Electron 进程开启本机 CDP，并把增强代码注入 renderer；
- 参考 DeepSeek Harness，在 renderer 内运行 Cordis，让插件的加载、依赖和副作用清理共享同一条生命周期。

首版已经形成最小闭环：配置中的 TypeScript 插件会被打包成一个浏览器 bundle，注入 Codex 页面，并通过 `ctx.cordisx.contribute()` 向具名 UI slot 注册可撤销界面。

> 这是非官方实验项目。它不会修改 `/Applications/Codex.app` 的文件，但 CDP 注入依赖 Codex 的内部 DOM，Codex 升级后适配器可能需要更新。插件与 Codex renderer 同权限执行，只能安装你信任的插件。

## 快速体验

要求 Node.js 22.19 或更新版本。

```bash
npm install
cp cordisx.config.example.json cordisx.config.json
npm run check
npm run dev -- --dry-run
```

连接 Codex 有两种方式：

```bash
# 启动一个带 CDP 的实例；macOS 会自动寻找 Codex.app 或 ChatGPT.app
npm run dev -- --config cordisx.config.json

# 连接已经用 --remote-debugging-port=9229 启动的 Codex
npm run dev -- --config cordisx.config.json --attach
```

启动模式下请先退出普通 Codex/ChatGPT 实例，避免应用把第二次启动转交给未开启 CDP 的旧进程。

如果自动探测不到 Codex，可显式传可执行文件：

```bash
npm run dev -- --executable /Applications/Codex.app/Contents/MacOS/Codex

# 当前统一应用
npm run dev -- --executable /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
```

退出 CordisX 启动器时，它会尝试移除新页面注入脚本，并卸载当前页面中的 Cordis 插件。它不会修改 Codex 的登录信息、配置文件或应用包。

## 插件示例

插件是普通 Cordis object plugin。`inject` 声明它依赖 CordisX UI 服务，`contribute()` 自动把注册挂到当前插件 fiber 的生命周期上：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'cordisx/contracts'

export const inject = ['cordisx']

export function apply(ctx: Context) {
  ctx.cordisx.contribute({
    id: 'my-header-button',
    slot: 'header.actions',
    mount({ container }) {
      const button = document.createElement('button')
      button.textContent = 'Hello'
      container.append(button)
      return () => button.remove()
    },
  })
}
```

当前 slot：

- `header.actions`：Codex 顶部操作区；
- `composer.before` / `composer.after`：输入区前后；
- `sidebar.footer`：侧栏底部；
- `shell.overlay`：页面级浮层。

这些名称是 CordisX 的稳定协议；具体 DOM 选择器集中在宿主适配器中，不应散落到插件里。

## 当前边界

- 已实现：配置校验、浏览器打包、Codex 启动/连接、目标页追踪、CDP 注入与撤销、Cordis fiber 生命周期、DOM slot 重挂载、示例插件和单元测试。
- 已验证：当前项目可生成 283 KB renderer bundle；bundle 在模拟 Codex DOM 中能加载示例插件并完整卸载；本机宿主为 `ChatGPT.app` 26.818.41509，bundle id 仍是 `com.openai.codex`。
- 未做真人 UI 冒烟：本轮没有退出或重启用户正在使用的 ChatGPT，因此当前 slot 选择器尚未在 26.818.41509 的真实页面中验证。
- 尚未实现：插件市场、签名、权限隔离、进程沙箱、源码 HMR、可视化管理器、Codex 版本适配矩阵。
- 官方 Codex 插件 UI 是 MCP 返回的会话内 UI 资源，适合 inline/fullscreen 组件；它不是任意替换 Codex shell 的 API。CordisX 走的是本地、非官方的宿主增强路线。

详细设计见 [docs/architecture.md](docs/architecture.md)，开发拆分见 [docs/development-plan.md](docs/development-plan.md)。
