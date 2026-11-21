import { accessSync, constants } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { buildManagerStyles } from '../packages/cli/scripts/build-manager-styles.mjs'
import { CdpClient, stopChrome } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'

const chrome = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ...(process.env.PATH ?? '').split(path.delimiter).flatMap(directory =>
    ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'].map(name => path.join(directory, name))
  ),
].find(candidate => {
  if (!candidate || !path.isAbsolute(candidate)) return false
  try {
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
})

it.skipIf(chrome === undefined)('styles the existing page header under the standalone CSP', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-header-browser-'))
  const server = createServer()
  let browser: ChildProcess | undefined
  let cdp: CdpClient | undefined
  try {
    const stylesheet = path.join(directory, 'manager-host.css')
    await buildManagerStyles(stylesheet)
    const css = await readFile(stylesheet)
    const entry = path.resolve('packages/cli/src/renderer/page-header-actions.ts')
    const navigation = path.resolve('packages/cli/src/renderer/navigation-pages.ts')
    const bundle = await build({
      stdin: {
        contents: `import { mountPageHeaderActions } from ${JSON.stringify(entry)};
          import { pageChromeButton } from ${JSON.stringify(navigation)};
          globalThis.__violations = [];
          document.addEventListener('securitypolicyviolation', event => globalThis.__violations.push(event.violatedDirective));
          mountPageHeaderActions({ chrome: document.querySelector('header'),
            actions: [{ id: 'fixture', label: { key: 'fixture' }, command: { id: 'fixture' } }],
            button: (label, icon) => pageChromeButton(document, label, icon), resolve: text => text.key,
            localize: callback => callback(), visible: () => true, available: () => true,
            subscribe: () => () => {}, execute: async () => {} });
          globalThis.__mounted = true;`,
        resolveDir: process.cwd(),
        sourcefile: 'page-header-fixture.ts',
        loader: 'ts',
      },
      bundle: true,
      format: 'esm',
      platform: 'browser',
      loader: { '.css': 'text', '.svg': 'text', '.png': 'dataurl' },
      write: false,
    })
    server.on('request', (request, response) => {
      if (request.url === '/') {
        response.writeHead(200, {
          'content-type': 'text/html',
          'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'",
        })
        response.end(
          '<!doctype html><link id="cordisx-react-manager-style" rel="stylesheet" href="/manager-host.css"><header></header><script type="module" src="/fixture.js"></script>',
        )
      } else if (request.url === '/manager-host.css') {
        response.writeHead(200, { 'content-type': 'text/css' })
        response.end(css)
      } else if (request.url === '/fixture.js') {
        response.writeHead(200, { 'content-type': 'text/javascript' })
        response.end(bundle.outputFiles[0]!.contents)
      } else {
        response.writeHead(404)
        response.end()
      }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const launched = launchChrome(chrome!, directory)
    browser = launched.browser
    cdp = await CdpClient.connect(await waitForChromeTarget(directory, browser, launched.stderr))
    await cdp.send('Page.enable')
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` })
    await expect.poll(() => cdp!.evaluate('globalThis.__mounted === true')).toBe(true)
    await expect.poll(() =>
      cdp!.evaluate(`(() => {
      const button = document.querySelector('.cordisx-page-chrome-action');
      const style = getComputedStyle(button);
      return { display: style.display, width: style.width, cursor: style.cursor };
    })()`)
    ).toEqual({ display: 'inline-flex', width: '28px', cursor: 'pointer' })
    expect(await cdp.evaluate('document.querySelectorAll("header style").length')).toBe(0)
    expect(await cdp.evaluate('globalThis.__violations')).toEqual([])
  } finally {
    await cdp?.close()
    if (browser !== undefined) await stopChrome(browser)
    server.closeAllConnections()
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 60_000)
