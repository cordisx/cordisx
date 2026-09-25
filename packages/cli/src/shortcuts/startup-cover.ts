import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { abortable, cdpInstallationAborted, CdpSession, runtimeEvaluationException } from '../launcher/cdp-session.js'
import type { CdpTarget } from '../launcher/cdp-session.js'
import type { NativeAccountCapabilityDescriptor } from '../native-account-capability.js'
import { readNativeStartupReadiness, type StartupSurface } from '../renderer/adapter/startup-readiness.js'
import { NATIVE_STARTUP_MARK_SELECTOR, NATIVE_STARTUP_SURFACE } from '../renderer/adapter/startup-presentation.js'
import { startupBrand } from './startup-brand.js'
import { observeStartupTiming } from './startup-timing.js'
import { releaseReadyStartup } from './startup-release.js'

const require = createRequire(import.meta.url)
const navigationAgent = fileURLToPath(new URL('../../native/startup-navigation.cjs', import.meta.url))
const coverBuilder = fileURLToPath(new URL('../../native/startup-cover.cjs', import.meta.url))
interface Owner {
  readonly pid: number
  readonly generation: string
}
interface Held extends Owner {
  phase: string
  windowId: number
  webContentsId: number
  targetId: string
  initialDocumentURL: string
  loadingShownAt?: number
}
export interface StartupCoverController {
  readonly startupNavigation: StartupNavigationHandoff
  reveal(account: NativeAccountCapabilityDescriptor | undefined, signal?: AbortSignal): Promise<StartupSurface>
  close(): Promise<void>
}
export interface StartupNavigationHandoff {
  readonly target: CdpTarget
  activate(identifier: string): Promise<void>
}
async function evaluate<Value>(session: CdpSession, expression: string, timeout = 5000): Promise<Value> {
  const result = await session.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    timeout,
  )
  const error = runtimeEvaluationException(result)
  if (error) throw new Error('Startup surface operation failed: ' + error)
  return (result.result as { value?: Value } | undefined)?.value as Value
}
export async function installStartupNavigation(
  main: CdpSession,
  frameId: string,
  owner: Owner,
): Promise<void> {
  const brand = await startupBrand()
  const css = await readFile(new URL('../../native/startup-cover.css', import.meta.url), 'utf8')
  const html = (await readFile(new URL('../../native/startup-loading.html', import.meta.url), 'utf8'))
    .replace('__STARTUP_CSS__', css)
    .replace('__STARTUP_MARK__', brand.markup)
    .replace('__STARTUP_ANIMATION__', `(${brand.animate})(document.querySelector('.mark'))`)
    .replaceAll('__STARTUP_NONCE__', owner.generation)
  const options = {
    ...owner,
    deadlineMs: 30000,
    seedURL: 'data:text/html;charset=utf-8,' + encodeURIComponent(html),
    showSeed: true,
  }
  const result = await main.send('Debugger.evaluateOnCallFrame', {
    callFrameId: frameId,
    expression: `globalThis.__cordisxStartupNavigation = require(${JSON.stringify(navigationAgent)}).install(${
      JSON.stringify(options)
    },require('electron'));globalThis.__cordisxStartupNavigation.snapshot(${JSON.stringify(owner)})`,
    returnByValue: true,
  })
  if (
    runtimeEvaluationException(result)
    || (result.result as { value?: { phase?: string } })?.value?.phase !== 'waiting-window'
  ) {
    throw new Error('Owned primary navigation barrier could not be installed')
  }
}
export async function connectStartupCover(
  main: CdpSession,
  owner: Owner,
  port: number,
  onRecovery?: (waiting: boolean) => Promise<void>,
): Promise<StartupCoverController> {
  const call = async (method: string, proof?: unknown): Promise<Held> =>
    await evaluate(
      main,
      `globalThis.__cordisxStartupNavigation.${method}(${JSON.stringify(owner)}${
        proof === undefined ? '' : ',' + JSON.stringify(proof)
      })`,
    )
  let held: Held | undefined
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const state = await call('snapshot')
    if (state.phase === 'failed') throw new Error('Owned startup navigation failed')
    if (state.phase === 'navigation-held') {
      held = await call('identifyTarget')
      break
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (!held) throw new Error('Owned startup navigation deadline')
  console.error(
    '[cordisx-startup]',
    JSON.stringify({ event: 'loading-shown', at: held.loadingShownAt, hostPid: owner.pid }),
  )
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })
  const targets = await response.json() as { id: string; type: string; url: string; webSocketDebuggerUrl: string }[]
  const matches = targets.filter(target => target.id === held!.targetId)
  if (matches.length !== 1 || matches[0]!.type !== 'page' || matches[0]!.url !== held.initialDocumentURL) {
    throw new Error('Owned startup target identity changed')
  }
  const socket = new URL(matches[0]!.webSocketDebuggerUrl)
  if (
    socket.protocol !== 'ws:' || socket.hostname !== '127.0.0.1' || socket.port !== String(port) || socket.username
    || socket.password
  ) {
    throw new Error('Owned startup target endpoint changed')
  }
  const page = await CdpSession.connect(socket.href)
  const timing = observeStartupTiming(
    page,
    owner.pid,
    value => console.error('[cordisx-startup]', JSON.stringify(value)),
  )
  let identifier: string | undefined
  const lifetime = new AbortController()
  let cleanup: Promise<void> | undefined
  const dispose = (): Promise<void> =>
    cleanup ??= (async () => {
      lifetime.abort()
      timing.close()
      if (identifier) {await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, 1000).catch(() =>
          undefined
        )}
      await evaluate(
        page,
        `(() => { const api = globalThis.__cordisxStartupDocument; const receipt = api?.snapshot().receipt; if (receipt?.generation === ${
          JSON.stringify(owner.generation)
        }) api.retire(receipt); })()`,
        1000,
      ).catch(() => undefined)
      page.close()
    })()
  let activated = false
  const startupNavigation: StartupNavigationHandoff = {
    target: {
      id: held.targetId,
      type: 'page',
      title: 'CordisX startup',
      url: 'app://-/index.html',
      webSocketDebuggerUrl: socket.href,
    },
    async activate(bootstrapIdentifier) {
      if (activated) throw new Error('Owned startup navigation was already activated')
      if (typeof bootstrapIdentifier !== 'string' || bootstrapIdentifier.length === 0) {
        throw new Error('Missing startup bootstrap registration')
      }
      const current = await call('snapshot')
      for (const key of ['pid', 'generation', 'windowId', 'webContentsId', 'targetId', 'phase'] as const) {
        if (current[key] !== held[key]) throw new Error('Owned startup target changed before activation')
      }
      activated = true
      try {
        await call('releaseNavigation', {
          targetId: held.targetId,
          windowId: held.windowId,
          webContentsId: held.webContentsId,
          sessionId: socket.href,
          identifier: bootstrapIdentifier,
        })
      } catch (error) {
        activated = false
        throw error
      }
      console.error(
        '[cordisx-startup]',
        JSON.stringify({ event: 'app-navigation', at: Date.now(), hostPid: owner.pid }),
      )
    },
  }
  try {
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    const css = await readFile(new URL('../../native/startup-cover.css', import.meta.url), 'utf8')
    const brand = await startupBrand()
    const builder = require(coverBuilder) as { buildCoverSource(options: unknown, animate?: string): string }
    const added = await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: builder.buildCoverSource({
        generation: owner.generation,
        url: 'app://-/index.html',
        css,
        mark: brand.markup,
        nativeMarkSelector: NATIVE_STARTUP_MARK_SELECTOR,
        nativeSurface: NATIVE_STARTUP_SURFACE,
      }, brand.animate),
    })
    if (typeof added.identifier !== 'string') throw new Error('Missing startup document registration')
    identifier = added.identifier
  } catch (error) {
    await dispose()
    throw error
  }
  return {
    startupNavigation,
    async reveal(account, externalSignal) {
      const signal = externalSignal ? AbortSignal.any([lifetime.signal, externalSignal]) : lifetime.signal
      const check = (): void => {
        if (signal.aborted) throw cdpInstallationAborted()
      }
      const read = <T>(expression: string): Promise<T> => {
        check()
        return abortable(evaluate<T>(page, expression), signal)
      }
      const delay = async (): Promise<void> => {
        await abortable(new Promise(resolve => setTimeout(resolve, 100)), signal)
        check()
      }
      try {
        check()
        console.error(
          '[cordisx-startup]',
          JSON.stringify({ event: 'composition-installed', at: Date.now(), hostPid: owner.pid }),
        )
        for (;;) {
          const readyDeadline = Date.now() + 30000
          while (Date.now() < readyDeadline) {
            let result: Awaited<ReturnType<typeof releaseReadyStartup>> | undefined
            try {
              result = await read(
                `(${releaseReadyStartup.toString()})(${readNativeStartupReadiness.toString()},${
                  JSON.stringify(account)
                },${timing.source})`,
              )
            } catch {
              check() /* A controlled reload may retire this execution context. */
            }
            if (result?.released) {
              check()
              // The startup registration must not cover an ordinary later reload.
              await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier })
              identifier = undefined
              console.error(
                '[cordisx-startup]',
                JSON.stringify({
                  event: 'usable-released',
                  at: Date.now(),
                  rendererReleasedAt: result.releasedAt,
                  hostPid: owner.pid,
                  surface: result.surface,
                }),
              )
              return result.surface ?? 'workspace-ready'
            }
            await delay()
          }
          await read(
            'globalThis.__cordisxStartupDocument?.fail(globalThis.__cordisxStartupDocument.snapshot().receipt)',
          )
          let action: string | undefined
          let heartbeatAt = 0
          while (!action) {
            const snapshot = await read<
              {
                requestedAction?: string
                phase?: string
                mounted?: boolean
                modal?: boolean
                presentationReleasedAt?: number
              }
            >(
              'globalThis.__cordisxStartupDocument?.snapshot()',
            )
            if (
              snapshot?.phase !== 'failed' || !snapshot.mounted
              || (!snapshot.modal && !Number.isFinite(snapshot.presentationReleasedAt))
            ) {
              throw new Error('Owning startup recovery surface is unavailable')
            }
            if (Date.now() - heartbeatAt >= 1000) {
              await abortable(Promise.resolve(onRecovery?.(true)), signal)
              heartbeatAt = Date.now()
            }
            action = snapshot?.requestedAction
            if (!action) await delay()
          }
          if (action !== 'retry') throw new Error('Startup cancelled in the owning window')
          await abortable(Promise.resolve(onRecovery?.(false)), signal)
          // Keep the same target and its persistent bootstrap/cover registrations.
          await abortable(page.send('Page.reload'), signal).catch(error => {
            check()
            if (!String(error).includes('timed out: Page.reload')) throw error
          })
        }
      } finally {
        await dispose()
      }
    },
    close: dispose,
  }
}
