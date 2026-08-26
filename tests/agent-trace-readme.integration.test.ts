import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import type { CordisXConfig } from '../packages/cli/src/launcher/config.js'

const execFileAsync = promisify(execFile)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = path.join(projectRoot, 'packages/agent-trace-showcase')

interface RuntimeHandle {
  snapshot(): {
    readonly plugins: readonly {
      readonly id: string
      readonly status: string
      readonly readme?: string
    }[]
  }
  dispose(): Promise<void>
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left, y: top, left, top, right: left + width, bottom: top + height,
    width, height, toJSON: () => ({}),
  } as DOMRect
}

describe('Agent Trace built README projection', () => {
  let canonicalReadme = ''
  let builtReadme = ''
  let dom: JSDOM
  let runtime: RuntimeHandle

  beforeAll(async () => {
    await execFileAsync('npm', ['run', 'build', '--workspace=@cordisx/agent-trace-showcase'], {
      cwd: projectRoot,
    })
    await readFile(path.join(packageRoot, 'dist/entry.js'), 'utf8')
    await readFile(path.join(packageRoot, 'dist/index.js'), 'utf8')
    ;[canonicalReadme, builtReadme] = await Promise.all([
      readFile(path.join(packageRoot, 'README.md'), 'utf8'),
      readFile(path.join(packageRoot, 'dist/README.md'), 'utf8'),
    ])

    const config: CordisXConfig = {
      version: 1,
      rootDir: projectRoot,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [{
        id: 'agent-trace-showcase',
        entry: path.join(packageRoot, 'dist/index.js'),
        enabled: true,
        config: { mode: 'live' },
      }],
    }
    const bundle = await buildRendererBundle(config)
    const sessionId = 'readme-session'
    dom = new JSDOM(`
      <html lang="zh-CN" class="electron-dark"><head></head><body>
        <div class="sidebar-header"><button id="workspace-switcher" aria-haspopup="menu">Codex</button></div>
        <header data-app-shell-application-menu-bar>
          <div data-test-id="header-shell-slot"><button>Native action</button></div>
        </header>
        <aside>
          <div data-app-action-sidebar-scroll>
            <button
              data-app-action-sidebar-thread-selected="true"
              data-app-action-sidebar-thread-host-id="local"
              data-app-action-sidebar-thread-id="local:${sessionId}"
            ></button>
          </div>
        </aside>
        <main data-app-shell-main-content-layout="thread-edge-scroll">
          <header data-testid="app-shell-header-context-menu-surface" style="display:flex">
            <div>Current session</div>
            <div id="native-session-actions" style="display:flex">
              <button id="native-session-menu" class="codex-toolbar-button">Session menu</button>
            </div>
          </header>
          <section id="native-thread" data-codex-thread-reference-drop-target>
            <div data-response-annotation-conversation="${sessionId}">Native conversation</div>
            <div data-above-composer-conversation-id="${sessionId}"></div>
          </section>
        </main>
      </body></html>
    `, { runScripts: 'dangerously', url: 'https://codex.local/native' })
    Object.defineProperty(dom.window, 'structuredClone', { configurable: true, value: structuredClone })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', {
      configurable: true,
      value: () => ({ length: 1 }),
    })
    Object.defineProperty(dom.window.document.body, 'getBoundingClientRect', {
      value: () => rect(0, 0, 1280, 900),
    })
    Object.defineProperty(dom.window.document.querySelector('main'), 'getBoundingClientRect', {
      value: () => rect(248, 46, 1032, 854),
    })
    Object.defineProperty(dom.window.document.getElementById('native-thread'), 'getBoundingClientRect', {
      value: () => rect(248, 92, 1032, 808),
    })
    Object.defineProperty(
      dom.window.document.querySelector('[data-testid="app-shell-header-context-menu-surface"]'),
      'getBoundingClientRect',
      { value: () => rect(248, 46, 1032, 46) },
    )

    dom.window.eval(bundle)
    for (let attempt = 0; attempt < 50 && dom.window.document.documentElement.dataset.cordisxReady !== 'true'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const handle = (dom.window as unknown as { __cordisxRuntime?: RuntimeHandle }).__cordisxRuntime
    if (handle === undefined) throw new Error('CordisX runtime did not boot')
    runtime = handle
  }, 60_000)

  afterAll(async () => {
    await runtime?.dispose()
    dom?.window.close()
  })

  it('copies the canonical product README beside the built runtime entry', async () => {
    const packageManifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as {
      readonly scripts?: { readonly build?: string }
    }
    expect(packageManifest.scripts?.build).toContain('node scripts/copy-readme.mjs')
    expect(builtReadme).toBe(canonicalReadme)
    expect(builtReadme).toContain('## Fixture, live, and historical modes')
    expect(builtReadme).toContain('agent.history.read')
    expect(builtReadme).toContain('current-connection-client-unavailable')
  })

  it('embeds that adjacent README in the real launcher bundle item', () => {
    expect(runtime.snapshot().plugins).toEqual([
      expect.objectContaining({
        id: 'agent-trace-showcase',
        status: 'active',
        readme: canonicalReadme,
      }),
    ])
  })

  it('renders the Agent Trace product README in the manager README tab', () => {
    const trigger = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')
    expect(trigger).not.toBeNull()
    trigger?.click()
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-id="agent-trace-showcase"]')?.click()

    const panel = dom.window.document.querySelector<HTMLElement>('[role="tabpanel"][aria-label="README"]')
    expect(panel?.querySelector('.cxm-readme h1')?.textContent).toBe('CordisX Agent Trace Showcase')
    expect(panel?.textContent).toContain('Fixture, live, and historical modes')
    expect(panel?.textContent).toContain('agent.history.read')
    expect(panel?.textContent).toContain('Explicit Agent demonstrations')
    expect(panel?.textContent).toContain('current-connection-client-unavailable')
    expect(panel?.textContent).not.toContain('该插件没有随当前 bundle 提供 README.md')
  })
})
