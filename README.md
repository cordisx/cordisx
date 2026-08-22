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
# 默认：启动项目级隔离的第二个 Codex；不会占用或重启当前实例
npm run dev -- --config cordisx.config.json

# 连接已经用 --remote-debugging-port=9229 启动的 Codex
npm run dev -- --config cordisx.config.json --attach

# 逃生入口：使用系统 Chromium profile（要求普通实例已经退出）
npm run dev -- --config cordisx.config.json --system
```

默认模式会自动选择空闲 CDP 端口，并为当前项目稳定保存 Chromium profile：

```text
~/.cordisx/projects/<project-key>/cache/codex-app-profile/
```

隔离的是 Codex/Electron 进程、Chromium 数据、CDP 端口和窗口恢复状态；当前 `HOME` 与 `CODEX_HOME` 保持共享，因此账号凭证、会话、项目和模型配置仍可使用。新 App 主进程会启动自己的 app-server/stdin 通道，退出 CordisX 时只撤销注入并终止这个被精确跟踪的实例。`--profile-dir <path>` 可覆盖 profile 位置；`--isolated` 作为显式兼容写法仍可使用。

若要在浏览器或 IAB 中使用 Chrome 官方在线 DevTools，可加 `--online-devtools`。它会额外允许 `https://chrome-devtools-frontend.appspot.com` 连接 loopback CDP。这个页面一旦连上就拥有读取和修改测试 Codex renderer 的完整调试权限，只应对隔离实例启用。

实时注入后可运行只读取 CordisX 状态的冒烟探针，并可只截取插件标识区域：

```bash
npm run smoke -- --port <printed-port> --screenshot artifacts/live-smoke.png
```

`--system` 模式下请先退出普通 Codex/ChatGPT 实例，避免应用把第二次启动转交给未开启 CDP 的旧进程。

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
- 已验证：项目可以生成 renderer bundle；bundle 在模拟 Codex DOM 中能加载示例插件并完整卸载；本机宿主为 `ChatGPT.app` 26.818.41509，bundle id 仍是 `com.openai.codex`。
- 已验证：默认启动能让同一应用创建独立 Codex/AppServer 进程、项目级 Chromium profile 和随机 CDP 端口；真实 renderer 已成功加载 CordisX 示例插件。
- 尚未实现：插件市场、签名、权限隔离、进程沙箱、源码 HMR、可视化管理器、Codex 版本适配矩阵。
- [OpenAI 官方插件 UI 文档](https://developers.openai.com/plugins/build/chatgpt-ui)定义的是 MCP 返回、在宿主 iframe 中运行的会话内 UI 资源；它不是任意替换 Codex shell 的 API。CordisX 走的是本地、非官方的宿主增强路线。

详细设计见 [docs/architecture.md](docs/architecture.md)，开发拆分见 [docs/development-plan.md](docs/development-plan.md)。
