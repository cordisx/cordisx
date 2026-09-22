// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readNativeStartupReadiness } from '../packages/cli/src/renderer/adapter/startup-readiness.js'

const descriptor = { module: 'app://-/assets/app-initial-fixture.js', exportName: 'accountService' }
const read = (trace?: Parameters<typeof readNativeStartupReadiness>[2]) =>
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
    trace,
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
function showLogin() {
  document.body.innerHTML = '<main><div><h1>登录 ChatGPT</h1></div><button>继续登录</button></main>'
  for (const element of document.querySelectorAll('h1, button')) {
    element.getBoundingClientRect = () => ({ width: 10, height: 10 }) as DOMRect
  }
}

describe('startup surface readiness is independent of workspace account enrichment', () => {
  it.each(['pending', 'error', 'unavailable'])(
    'does not block a usable workspace on %s account enrichment',
    async status => {
      const { accountRead } = readyDocument()
      accountRead.mockImplementation(() =>
        status === 'pending'
          ? new Promise(() => {})
          : Promise.resolve({ status, data: undefined } as never)
      )
      const trace = vi.fn()
      let result: Awaited<ReturnType<typeof read>> | undefined
      void read(trace).then(value => {
        result = value
      })
      for (let turn = 0; turn < 12; turn++) await Promise.resolve()
      expect(result).toMatchObject({
        ready: true,
        surface: 'workspace-ready',
        observations: { hostUsable: true, cordisxReady: true, workspaceUsable: true },
      })
      expect(result?.observations).not.toHaveProperty('authenticated')
      expect(accountRead).not.toHaveBeenCalled()
      expect(trace).toHaveBeenCalledWith('boot-resolved')
      expect(trace).toHaveBeenCalledWith('editor-observed')
      expect(trace).toHaveBeenCalledWith('model-observed')
      expect(trace).not.toHaveBeenCalledWith('account-read-start')
    },
  )

  it('keeps a workspace covered until its real boot completes and rechecks controls', async () => {
    readyDocument()
    let finish!: () => void
    vi.stubGlobal(
      '__cordisxBoot',
      new Promise<void>(resolve => {
        finish = resolve
      }),
    )
    let resolved = false
    const pending = read().then(value => {
      resolved = true
      return value
    })
    for (let turn = 0; turn < 5; turn++) await Promise.resolve()
    expect(resolved).toBe(false)
    document.querySelector('button')!.remove()
    finish()
    expect(await pending).toMatchObject({ ready: false, reason: 'native-controls-pending' })
  })

  it.each(['missing', 'rejected', 'bootstrap-pending'])('rejects %s CordisX boot', async kind => {
    readyDocument()
    if (kind === 'missing') vi.stubGlobal('__cordisxBoot', undefined)
    if (kind === 'rejected') vi.stubGlobal('__cordisxBoot', Promise.reject(new Error('boot failed')))
    if (kind === 'bootstrap-pending') {
      vi.stubGlobal('__cordisxProductionInstallId', 'current')
      vi.stubGlobal('__cordisxProductionBootstrapState', { installId: 'old', status: 'evaluated' })
    }
    expect(await read()).toMatchObject({ ready: false })
  })

  it.each(['receipt', 'install', 'boot', 'bootstrap', 'runtime', 'url'])(
    'rejects changed %s after asynchronous boot proof',
    async kind => {
      const { navigate } = readyDocument()
      let finish!: () => void
      vi.stubGlobal(
        '__cordisxBoot',
        new Promise<void>(resolve => {
          finish = resolve
        }),
      )
      vi.stubGlobal('__cordisxProductionInstallId', 'current')
      vi.stubGlobal('__cordisxProductionBootstrapState', { installId: 'current', status: 'evaluated' })
      const pending = read()
      if (kind === 'receipt') navigate()
      if (kind === 'install') vi.stubGlobal('__cordisxProductionInstallId', 'new')
      if (kind === 'boot') vi.stubGlobal('__cordisxBoot', Promise.resolve())
      if (kind === 'bootstrap') {
        vi.stubGlobal('__cordisxProductionBootstrapState', {
          installId: 'current',
          status: 'loading',
        })
      }
      if (kind === 'runtime') vi.stubGlobal('__cordisxRuntime', undefined)
      if (kind === 'url') vi.stubGlobal('location', { href: 'app://-/other.html' })
      finish()
      expect(await pending).toMatchObject({ ready: false })
    },
  )

  it.each(['model', 'editor', 'inert'])('keeps real %s usability in the release proof', async kind => {
    const { accountRead } = readyDocument()
    if (kind === 'model') document.querySelector('button')!.disabled = true
    if (kind === 'editor') document.querySelector('textarea')!.disabled = true
    if (kind === 'inert') document.body.setAttribute('inert', '')
    try {
      expect(await read()).toMatchObject({ ready: false, reason: 'native-controls-pending' })
      expect(accountRead).not.toHaveBeenCalled()
    } finally {
      document.body.removeAttribute('inert')
    }
  })

  it('releases native login only on explicit signed-out status without requiring model or boot', async () => {
    readyDocument()
    showLogin()
    vi.stubGlobal('__cordisxBoot', undefined)
    vi.stubGlobal('__cordisxRuntime', undefined)
    vi.stubGlobal('__startupAccountRead', async () => ({ status: 'ready', data: null }))
    expect(await read()).toMatchObject({
      ready: true,
      surface: 'auth-required',
      observations: { authenticated: false, loginUsable: true },
    })
    document.querySelector('button')!.disabled = true
    expect(await read()).toMatchObject({ ready: false, reason: 'native-controls-pending' })
  })

  it.each(['unavailable', 'error'])('never classifies %s account state as signed-out', async status => {
    readyDocument()
    showLogin()
    vi.stubGlobal('__startupAccountRead', async () => ({ status, data: null }))
    expect(await read()).toMatchObject({ ready: false, reason: 'account-not-ready' })
  })

  it('does not release a stale login for an authenticated account or accept a stale signed-out result', async () => {
    const { navigate } = readyDocument()
    showLogin()
    const trace = vi.fn()
    vi.stubGlobal('__startupAccountRead', async () => ({ status: 'ready', data: { email: 'private-fixture' } }))
    expect(await read(trace)).toMatchObject({ ready: false, reason: 'native-controls-pending' })
    expect(JSON.stringify(trace.mock.calls)).not.toContain('private-fixture')
    vi.stubGlobal('__startupAccountRead', async () => {
      navigate()
      return { status: 'ready', data: null }
    })
    expect(await read()).toMatchObject({ ready: false, reason: 'document-changed' })
  })

  it('retries failed login account reads and releases only its disposable invocation', async () => {
    const { accountRead } = readyDocument()
    showLogin()
    accountRead.mockRejectedValueOnce(new Error('temporary native failure'))
      .mockResolvedValueOnce({ status: 'unavailable', data: undefined } as never)
    expect(await read()).toMatchObject({ ready: false, reason: 'account-unavailable' })
    expect(await read()).toMatchObject({ ready: false, reason: 'account-not-ready' })
    const dispose = vi.fn()
    const invocation = Object.assign(Promise.resolve({ status: 'ready', data: null }), { [Symbol.dispose]: dispose })
    accountRead.mockReturnValueOnce(invocation as never)
    expect(await read()).toMatchObject({ ready: true, surface: 'auth-required' })
    expect(dispose).toHaveBeenCalledOnce()
  })
})
