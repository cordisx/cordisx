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
  const accountRead = vi.fn(async () => ({ status: 'ready', data: {} }))
  vi.stubGlobal('location', { href: 'app://-/index.html' })
  vi.stubGlobal('__cordisxStartupDocument', {
    snapshot: () => ({ phase: 'covered', receipt: { nonce, timeOrigin: performance.timeOrigin } }),
  })
  vi.stubGlobal('__cordisxRuntime', {})
  vi.stubGlobal('__cordisxBoot', Promise.resolve())
  vi.stubGlobal('__startupAccountRead', accountRead)
  const showNativeControls = () => {
    document.body.innerHTML = '<textarea></textarea><button data-cordisx-model-ready="true">Model</button>'
    for (const element of document.querySelectorAll('textarea, button')) {
      element.getBoundingClientRect = () => ({ width: 10, height: 10 }) as DOMRect
    }
  }
  showNativeControls()
  return {
    accountRead,
    navigate: () => {
      nonce = 'new-document'
    },
    showNativeControls,
  }
}
describe('startup release requires the same usable authenticated document', () => {
  it('does not accept an existing shell without real CordisX boot', async () => {
    readyDocument()
    vi.stubGlobal('__cordisxBoot', undefined)
    expect(await read()).toMatchObject({ ready: false, reason: 'cordisx-pending' })
  })
  it('does not call the typed account service while native controls are pending', async () => {
    const { accountRead, showNativeControls } = readyDocument()
    document.querySelector('button')!.remove()
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await read()).toMatchObject({ ready: false, reason: 'native-controls-pending' })
    }
    expect(accountRead).toHaveBeenCalledTimes(0)
    document.body.innerHTML = '<button>Login</button>'
    expect(await read()).toMatchObject({ ready: false, reason: 'native-controls-pending' })
    expect(accountRead).toHaveBeenCalledTimes(0)
    showNativeControls()
    expect(await read()).toMatchObject({ ready: true, observations: { authenticated: true } })
    expect(accountRead).toHaveBeenCalledTimes(1)
  })
  it('retries unavailable and not-ready account results without weakening authentication', async () => {
    const { accountRead } = readyDocument()
    accountRead
      .mockRejectedValueOnce(new Error('temporary native failure'))
      .mockResolvedValueOnce({ status: 'unavailable', data: undefined })
      .mockResolvedValueOnce({ status: 'ready', data: {} })
    expect(await read()).toMatchObject({ ready: false, reason: 'account-unavailable' })
    expect(await read()).toMatchObject({ ready: false, reason: 'account-not-ready' })
    expect(await read()).toMatchObject({ ready: true, observations: { authenticated: true } })
    expect(accountRead).toHaveBeenCalledTimes(3)
  })
  it('rechecks usable controls after the asynchronous account read', async () => {
    const { accountRead, showNativeControls } = readyDocument()
    accountRead.mockImplementationOnce(async () => {
      document.querySelector('button')!.remove()
      return { status: 'ready', data: {} }
    })
    expect(await read()).toMatchObject({ ready: false, reason: 'native-controls-pending' })
    expect(accountRead).toHaveBeenCalledTimes(1)

    showNativeControls()
    expect(await read()).toMatchObject({ ready: true, observations: { authenticated: true } })
    expect(accountRead).toHaveBeenCalledTimes(2)
  })
  it('rejects an account result from an old document epoch and performs a fresh read', async () => {
    const { accountRead, navigate } = readyDocument()
    let resolveAccount!: (value: { status: string; data: object }) => void
    accountRead.mockImplementationOnce(() =>
      new Promise(resolve => {
        resolveAccount = resolve
      })
    )
    const oldDocumentRead = read()
    await vi.waitFor(() => expect(accountRead).toHaveBeenCalledTimes(1))
    navigate()
    resolveAccount({ status: 'ready', data: {} })
    expect(await oldDocumentRead).toMatchObject({ ready: false, reason: 'document-changed' })
    expect(accountRead).toHaveBeenCalledTimes(1)

    expect(await read()).toMatchObject({ ready: true, observations: { authenticated: true } })
    expect(accountRead).toHaveBeenCalledTimes(2)
  })
})
