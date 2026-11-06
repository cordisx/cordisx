import type { ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { waitForChromeDebugPort } from './chrome-debug-port.js'
import { launchObservedChrome, observeChromeReadiness } from './chrome-launch-diagnostics.js'

/** Shared isolated browser policy keeps native fixtures equivalent on macOS and Linux CI. */
function chromeLaunchArguments(profile: string): string[] {
  return [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--remote-allow-origins=*',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ]
}

export function launchChrome(executable: string, profile: string) {
  return launchObservedChrome(executable, chromeLaunchArguments(profile))
}

export async function waitForChromeTarget(
  profile: string,
  browser: ChildProcess,
  stderr: () => string,
): Promise<string> {
  const deadline = Date.now() + 15_000
  const diagnostics = observeChromeReadiness(browser, [0, 5_000, 10_000])
  try {
    // Chrome binds its own port and publishes it in this browser's private profile.
    const port = await waitForChromeDebugPort(
      browser,
      () => diagnostics.readActivePort(() => readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')),
      stderr,
      Math.max(0, deadline - Date.now()),
    )
    diagnostics.activePort(port)
    while (Date.now() < deadline) {
      if (browser.exitCode !== null || browser.signalCode !== null) {
        throw new Error(`Chrome exited before CDP was ready: ${stderr()}`)
      }
      diagnostics.targetPoll()
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000) })
        diagnostics.pageTargets({ status: response.status })
        if (response.ok) {
          const targets = await response.json() as Array<
            { readonly type?: string; readonly url?: string; readonly webSocketDebuggerUrl?: string }
          >
          diagnostics.pageTargets({
            status: response.status,
            targets: targets.slice(0, 8).map(target => ({
              type: target.type,
              url: target.url?.slice(0, 128),
              hasWebSocket: target.webSocketDebuggerUrl !== undefined,
            })),
          })
          const target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl !== undefined)
          if (target?.webSocketDebuggerUrl !== undefined) {
            diagnostics.ready('page')
            return target.webSocketDebuggerUrl
          }
        }
      } catch (error) {
        diagnostics.pageTargets({ error: (error as Error).message.slice(0, 256) })
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`timed out waiting for Chrome CDP: ${stderr()}`)
  } catch (error) {
    throw await diagnostics.failure(error)
  } finally {
    await diagnostics.dispose()
  }
}
