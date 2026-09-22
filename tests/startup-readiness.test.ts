// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readNativeStartupReadiness } from '../packages/cli/src/renderer/adapter/startup-readiness.js'

const descriptor = { module: 'app://-/assets/app-initial-fixture.js', exportName: 'accountService' }
const read = () =>
  readNativeStartupReadiness(
    descriptor,
    async () => ({
      accountService: {
        accessInputs: {
          readAccountInfo: () =>
            (globalThis as typeof globalThis & { __startupAccountRead(): Promise<unknown> }).__startupAccountRead(),
        },
      },
    }),
  )
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})
function readyDocument() {
  let nonce = 'current'
  vi.stubGlobal('location', { href: 'app://-/index.html' })
  vi.stubGlobal('__cordisxStartupDocument', {
    snapshot: () => ({ phase: 'covered', receipt: { nonce, timeOrigin: performance.timeOrigin } }),
  })
  vi.stubGlobal('__cordisxRuntime', {})
  vi.stubGlobal('__cordisxBoot', Promise.resolve())
  vi.stubGlobal('__startupAccountRead', async () => ({ status: 'ready', data: {} }))
  document.body.innerHTML = '<textarea></textarea><button data-cordisx-model-ready="true">Model</button>'
  for (const element of document.querySelectorAll('textarea, button')) {
    element.getBoundingClientRect = () => ({ width: 10, height: 10 }) as DOMRect
  }
  return () => {
    nonce = 'new-document'
  }
}
describe('startup release requires the same usable authenticated document', () => {
  it('does not accept an existing shell without real CordisX boot', async () => {
    readyDocument()
    vi.stubGlobal('__cordisxBoot', undefined)
    expect(await read()).toMatchObject({ ready: false, reason: 'cordisx-pending' })
  })
  it('requires account readiness and a usable native control', async () => {
    readyDocument()
    vi.stubGlobal('__startupAccountRead', async () => ({ status: 'unavailable', reason: 'retired' }))
    expect(await read()).toMatchObject({ ready: false, reason: 'account-not-ready' })
    vi.stubGlobal('__startupAccountRead', async () => ({ status: 'ready', data: {} }))
    expect(await read()).toMatchObject({ ready: true, observations: { authenticated: true } })
    document.querySelector('button')!.remove()
    expect(await read()).toMatchObject({ ready: false, reason: 'native-controls-pending' })
    document.body.innerHTML = '<button>Login</button>'
    expect(await read()).toMatchObject({ ready: false, reason: 'native-controls-pending' })
  })
  it('rejects account results completed after a document change', async () => {
    const navigate = readyDocument()
    vi.stubGlobal('__startupAccountRead', async () => {
      navigate()
      return { status: 'ready', data: {} }
    })
    expect(await read()).toMatchObject({ ready: false, reason: 'document-changed' })
  })
})
