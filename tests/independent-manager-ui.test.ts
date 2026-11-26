import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { readModelServices, saveModelServices } from '../packages/cli/src/launcher/model-service-store.js'
import { MODEL_SERVICE_SAFE_WRITE_CONTRACT } from '../packages/cli/src/model-service-contracts.js'
import { safeServiceConfigEdit } from '../packages/cli/assets/manager/manager-schema.js'
import { createChannelCredentialsUI } from '../packages/cli/assets/manager/manager-channel-ui.js'

async function mountManager(respond: (path: string, input: any) => unknown) {
  const html = await readFile('packages/cli/assets/manager/index.html', 'utf8')
  const source = (await readFile('packages/cli/assets/manager/manager.js', 'utf8'))
    .replace(/^import .*manager-schema\.js'\s*/u, '')
    .replace(/^import .*manager-channel-ui\.js'\s*/u, '')
  const dom = new JSDOM(html, { url: `http://127.0.0.1:9312/#${'a'.repeat(64)}`, runScripts: 'outside-only' })
  const window = dom.window as unknown as Window & typeof globalThis & Record<string, any>
  window.__schemaCheck = safeServiceConfigEdit
  window.__channelUI = createChannelCredentialsUI
  window.confirm = vi.fn(() => true)
  window.HTMLDialogElement.prototype.showModal = function() {
    this.setAttribute('open', '')
  }
  window.HTMLDialogElement.prototype.close = function() {
    this.removeAttribute('open')
    this.dispatchEvent(new window.Event('close'))
  }
  window.fetch = vi.fn(async (url: string | URL, options?: RequestInit) => {
    const input = typeof options?.body === 'string' ? JSON.parse(options.body) : undefined
    const value = await respond(String(url), input)
    return { ok: true, json: async () => value } as Response
  }) as typeof fetch
  await window.eval(
    `(async()=>{const safeServiceConfigEdit=window.__schemaCheck;const createChannelCredentialsUI=window.__channelUI;${source}\n})()`,
  )
  await vi.waitFor(() => expect(window.document.getElementById('owner')!.textContent).toContain('fixture'))
  return { window, dom }
}

const base = () => ({
  owner: { appId: 'codex', profileId: 'fixture' },
  management: {
    runtime: { kind: 'active' },
    revision: 2,
    activationRevision: 3,
    sources: [],
    plugins: [{ id: 'sample', name: 'Sample', status: 'disabled', enabled: false }],
  },
  services: { status: 'ok', revision: 'r1', services: [], managerSafeWrite: MODEL_SERVICE_SAFE_WRITE_CONTRACT },
  rendererPlugins: { status: 'ok', plugins: [{ id: 'sample', name: 'Sample', status: 'disabled', writable: true }] },
})

it('shows an old owner model service as read-only when safe-write support is absent', async () => {
  const legacy = {
    ...base(),
    services: {
      status: 'ok',
      revision: 'old',
      services: [{
        id: 'sample',
        displayName: 'Sample',
        baseUrl: 'https://example.test',
        protocols: ['openai-responses'],
        codexModels: ['model'],
        claudeModels: [],
        enabled: true,
        keyConfigured: true,
      }],
    },
  }
  const { window, dom } = await mountManager((route) => route === '/api/session' ? { token: 'session' } : legacy)
  try {
    expect(window.document.getElementById('models')!.textContent).toContain('仅供查看')
    expect((window.document.getElementById('add-model') as HTMLButtonElement).disabled).toBe(true)
    expect((window.document.getElementById('save-models') as HTMLButtonElement).disabled).toBe(true)
    expect([...window.document.querySelectorAll<HTMLInputElement>('#models input')].every(input => input.disabled))
      .toBe(true)
    await new Promise(resolve => setTimeout(resolve, 10))
  } finally {
    dom.window.close()
  }
})

it('retains an unsaved model credential draft across a status refresh', async () => {
  const { window, dom } = await mountManager((path) => path === '/api/session' ? { token: 'session' } : base())
  try {
    window.document.getElementById('add-model')!.click()
    const key = window.document.querySelector<HTMLInputElement>('#models input[type=password]')!
    key.value = 'fixture-not-a-real-secret'
    key.dispatchEvent(new window.Event('input', { bubbles: true }))
    window.document.getElementById('refresh')!.click()
    await vi.waitFor(() =>
      expect((window.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(call => call[0] === '/api/state').length)
        .toBeGreaterThan(1)
    )
    expect(window.document.querySelector<HTMLInputElement>('#models input[type=password]')?.value).toBe(
      'fixture-not-a-real-secret',
    )
    await new Promise(resolve => setTimeout(resolve, 10))
  } finally {
    dom.window.close()
  }
})

it('disables model saving after a failed refresh while retaining the unsaved draft', async () => {
  let reads = 0, saves = 0
  const { window, dom } = await mountManager((route) => {
    if (route === '/api/session') return { token: 'session' }
    if (route === '/api/state') {
      reads++
      if (reads === 2) throw new Error('temporary outage')
      return base()
    }
    if (route === '/api/model-services') {
      saves++
      return { status: 'applied' }
    }
    return { status: 'unavailable' }
  })
  try {
    window.document.getElementById('add-model')!.click()
    const secret = window.document.querySelector<HTMLInputElement>('#models input[type=password]')!
    secret.value = 'unsaved-fixture-secret'
    secret.dispatchEvent(new window.Event('input', { bubbles: true }))
    window.document.getElementById('refresh')!.click()
    await vi.waitFor(() => expect(window.document.getElementById('message')!.textContent).toContain('连接失败'))
    const save = window.document.getElementById('save-models') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    save.click()
    expect(saves).toBe(0)
    expect(secret.value).toBe('unsaved-fixture-secret')
    window.document.getElementById('refresh')!.click()
    await vi.waitFor(() => expect(save.disabled).toBe(false))
    expect(secret.value).toBe('unsaved-fixture-secret')
    await new Promise(resolve => setTimeout(resolve, 10))
  } finally {
    dom.window.close()
  }
})

it('does not let an older refresh re-enable a stale model draft', async () => {
  let reads = 0
  let release: (() => void) | undefined
  const { window, dom } = await mountManager(async (route) => {
    if (route === '/api/session') return { token: 'session' }
    if (route === '/api/state') {
      reads++
      if (reads === 2) {
        await new Promise<void>(resolve => {
          release = resolve
        })
        return base()
      }
      const value = base()
      if (reads === 3) value.services.revision = 'r2'
      return value
    }
    return { status: 'unavailable' }
  })
  try {
    window.document.getElementById('add-model')!.click()
    const secret = window.document.querySelector<HTMLInputElement>('#models input[type=password]')!
    secret.value = 'draft-secret'
    secret.dispatchEvent(new window.Event('input', { bubbles: true }))
    window.document.getElementById('refresh')!.click()
    await vi.waitFor(() => expect(release).toBeDefined())
    window.document.getElementById('refresh')!.click()
    await vi.waitFor(() => expect(reads).toBe(3))
    const save = window.document.getElementById('save-models') as HTMLButtonElement
    await vi.waitFor(() => expect(save.disabled).toBe(true))
    release!()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(save.disabled).toBe(true)
    expect(secret.value).toBe('draft-secret')
  } finally {
    dom.window.close()
  }
})

it.each(['unknown', 'persist-failed', 'transport'])(
  'does not blindly retry a model save with %s result',
  async status => {
    let saves = 0
    const { window, dom } = await mountManager((route) => {
      if (route === '/api/session') return { token: 'session' }
      if (route === '/api/state') return base()
      if (route === '/api/model-services') {
        saves++
        if (status === 'transport') throw new Error('connection lost')
        return status === 'unknown' ? { status: 'unknown' } : { status: 'rejected', code: 'persist-failed' }
      }
      return { status: 'unavailable' }
    })
    try {
      window.document.getElementById('add-model')!.click()
      const fields = window.document.querySelectorAll<HTMLInputElement>('#models input')
      fields[0]!.value = 'sample'
      fields[1]!.value = 'Sample'
      fields[2]!.value = 'https://example.test'
      fields[0]!.dispatchEvent(new window.Event('input', { bubbles: true }))
      const save = window.document.getElementById('save-models') as HTMLButtonElement
      save.click()
      await vi.waitFor(() => expect(window.document.getElementById('message')!.textContent).toContain('结果不确定'))
      await vi.waitFor(() => expect(save.disabled).toBe(true))
      save.click()
      expect(saves).toBe(1)
      await new Promise(resolve => setTimeout(resolve, 10))
    } finally {
      dom.window.close()
    }
  },
)

it('requires an explicit choice and confirmation for every permission and preserves its scope', async () => {
  const calls: any[] = []
  const plan = {
    schemaVersion: 4,
    planId: 'plan',
    operation: 'enable',
    profileId: 'fixture',
    identity: { source: 'https://example.test/plugin', pluginId: 'sample' },
    binding: { operationId: 'operation', runtimeGeneration: 'generation' },
    declarations: [{
      capability: 'network.http',
      required: true,
      decisionRequired: true,
      scope: { origins: ['https://example.test'] },
      securityFingerprint: `sha256:${'a'.repeat(64)}`,
      allowedDecisions: ['allow-once'],
      presentation: { name: { fallback: '网络访问' } },
      rationale: { feature: { fallback: '同步数据' }, deniedBehavior: { fallback: '同步不可用' } },
      security: { dataUse: 'external-service', retention: 'none', externalTransfer: true },
    }],
  }
  const { window, dom } = await mountManager((path, input) => {
    calls.push({ path, input })
    if (path === '/api/session') return { token: 'session' }
    if (path === '/api/state') return base()
    if (path === '/api/management') {
      return { status: 'permission-review-required', permissionPlan: plan, snapshot: { activationRevision: 3 } }
    }
    if (path === '/api/permission-review') return { status: 'ok', result: { outcome: 'applied' } }
    return { status: 'unavailable' }
  })
  try {
    const enable = [...window.document.querySelectorAll('button')].find(button => button.textContent === '启用')!
    enable.click()
    await vi.waitFor(() => expect(window.document.querySelector('dialog[open]')).not.toBeNull())
    const dialog = window.document.querySelector('dialog')!
    expect(dialog.textContent).toContain('sample')
    expect(dialog.textContent).toContain('https://example.test')
    expect(dialog.textContent).toContain('同步不可用')
    expect(dialog.textContent).toContain('externalTransfer')
    const submit = [...dialog.querySelectorAll('button')].find(button => button.textContent === '提交审核')!
    submit.click()
    await vi.waitFor(() => expect(dialog.textContent).toContain('请逐项选择'))
    expect(calls.filter(call => call.path === '/api/permission-review')).toHaveLength(0)
    const select = dialog.querySelector('select')!
    select.value = 'allow-once'
    ;(window.confirm as ReturnType<typeof vi.fn>).mockReturnValueOnce(false)
    submit.click()
    await vi.waitFor(() => expect(window.confirm).toHaveBeenCalled())
    expect(calls.filter(call => call.path === '/api/permission-review')).toHaveLength(0)
    submit.click()
    await vi.waitFor(() => expect(calls.filter(call => call.path === '/api/permission-review')).toHaveLength(1))
    expect(calls.find(call => call.path === '/api/permission-review').input).toMatchObject({
      userConfirmed: true,
      expectedRevision: 3,
      decision: {
        identity: plan.identity,
        binding: plan.binding,
        decisions: [{ scope: plan.declarations[0]!.scope, decision: 'allow-once' }],
      },
    })
    await vi.waitFor(() => expect(window.document.getElementById('message')!.textContent).toContain('权限决定已保存'))
    await new Promise(resolve => setTimeout(resolve, 10))
  } finally {
    dom.window.close()
  }
})

it('does not retry or report approval when a permission review is busy', async () => {
  let submissions = 0
  const plan = {
    schemaVersion: 4,
    planId: 'plan',
    operation: 'enable',
    profileId: 'fixture',
    identity: { source: 'https://example.test/plugin', pluginId: 'sample' },
    binding: {},
    declarations: [{
      capability: 'network.http',
      required: true,
      decisionRequired: true,
      scope: { origins: ['https://example.test'] },
      securityFingerprint: `sha256:${'a'.repeat(64)}`,
      allowedDecisions: ['allow-once'],
    }],
  }
  const { window, dom } = await mountManager((route) => {
    if (route === '/api/session') return { token: 'session' }
    if (route === '/api/state') return base()
    if (route === '/api/management') {
      return {
        status: 'permission-review-required',
        permissionPlan: plan,
        snapshot: { activationRevision: 3 },
      }
    }
    if (route === '/api/permission-review') {
      submissions++
      return { status: 'rejected', reason: 'review-busy' }
    }
    return { status: 'unavailable' }
  })
  try {
    ;[...window.document.querySelectorAll('button')].find(button => button.textContent === '启用')!.click()
    await vi.waitFor(() => expect(window.document.querySelector('dialog[open]')).not.toBeNull())
    const dialog = window.document.querySelector('dialog')!
    dialog.querySelector('select')!.value = 'allow-once'
    ;[...dialog.querySelectorAll('button')].find(button => button.textContent === '提交审核')!.click()
    await vi.waitFor(() => expect(window.document.getElementById('message')!.textContent).toContain('正在进行'))
    expect(submissions).toBe(1)
    expect(window.document.getElementById('message')!.textContent).not.toContain('已保存')
  } finally {
    dom.window.close()
  }
})

it('starts a plugin login only after a user action and fences an uncertain result', async () => {
  const requests: Array<Record<string, unknown>> = []
  const service = {
    status: 'available',
    pluginId: 'sample-provider',
    serviceId: 'gateway',
    pluginGeneration: 'generation',
    bindingId: 'binding',
    sequence: 4,
    authState: 'missing',
    readiness: 'stopped',
    explicitLogin: true,
    canLogin: true,
  }
  const { window, dom } = await mountManager((route, input) => {
    if (route === '/api/session') return { token: 'session' }
    if (route === '/api/state') return base()
    if (route === '/api/managed-services') {
      requests.push(input)
      if (input.action === 'list') return { status: 'available', services: [service] }
      if (input.action === 'view') return service
      if (input.action === 'prepare-login') return { status: 'prepared', leaseId: 'lease', expiresAt: 'later' }
      if (input.action === 'login') return { status: 'unknown', code: 'LOGIN_RESULT_UNKNOWN' }
    }
    return { status: 'unavailable' }
  })
  try {
    await vi.waitFor(() =>
      expect(window.document.getElementById('managed-services')!.textContent).toContain('sample-provider')
    )
    expect(requests.map(request => request.action)).toEqual(['list'])
    ;[...window.document.querySelectorAll('#managed-services button')].find(button => button.textContent === '登录')!
      .click()
    await vi.waitFor(() => expect(window.document.getElementById('message')!.textContent).toContain('结果不确定'))
    await vi.waitFor(() =>
      expect(window.document.getElementById('managed-services')!.textContent).toContain('上次登录结果未知')
    )
    expect(requests.filter(request => request.action === 'login')).toEqual([{ action: 'login', leaseId: 'lease' }])
    expect(requests.find(request => request.action === 'prepare-login')).toMatchObject({
      pluginId: 'sample-provider',
      serviceId: 'gateway',
      pluginGeneration: 'generation',
      bindingId: 'binding',
    })
    const login = [...window.document.querySelectorAll<HTMLButtonElement>('#managed-services button')]
      .find(button => button.textContent === '登录')!
    expect(login.disabled).toBe(true)
    login.click()
    expect(requests.filter(request => request.action === 'login')).toHaveLength(1)
  } finally {
    dom.window.close()
  }
})

it('verifies a write-only Feishu credential and requires confirmation before saving it', async () => {
  const requests: Array<Record<string, any>> = []
  const view = {
    status: 'available',
    revision: 4,
    serviceGeneration: 'service-generation',
    writable: true,
    connections: [],
    pendingConnections: [],
  }
  const { window, dom } = await mountManager((route, input) => {
    if (route === '/api/session') return { token: 'session' }
    if (route === '/api/state') return base()
    if (route === '/api/channel-credentials') {
      requests.push(input)
      if (input.action === 'view') return view
      if (input.action === 'capture') {
        if (requests.filter(request => request.action === 'capture').length === 1) {
          return { status: 'rejected', code: 'TENANT_MISMATCH' }
        }
        return {
          status: 'applied',
          code: 'CAPTURED',
          draftId: 'draft',
          ref: { adapterId: 'feishu', accountId: 'cli_example', tenantId: 'tenant' },
        }
      }
      if (input.action === 'commit') return { status: 'applied', code: 'APPLIED' }
    }
    return { status: 'unavailable' }
  })
  try {
    await vi.waitFor(() =>
      expect(window.document.getElementById('channel-credentials-list')!.textContent).toContain('添加飞书')
    )
    ;[...window.document.querySelectorAll('#channel-credentials button')]
      .find(button => button.textContent === '添加飞书/Lark 连接')!.click()
    const fields = window.document.querySelectorAll<HTMLInputElement>('#channel-credentials-list input')
    fields[0]!.value = 'cli_example'
    fields[1]!.value = 'wrong-tenant'
    fields[2]!.value = 'Work'
    fields[3]!.value = 'temporary-test-secret'
    const verify = [...window.document.querySelectorAll<HTMLButtonElement>('#channel-credentials button')]
      .find(button => button.textContent === '验证并暂存')!
    verify.click()
    await vi.waitFor(() => expect(window.document.getElementById('message')!.textContent).toContain('不一致'))
    expect(fields[3]!.value).toBe('')
    expect(requests.some(request => request.action === 'commit')).toBe(false)
    await vi.waitFor(() => expect(verify.disabled).toBe(false))
    fields[1]!.value = ''
    fields[3]!.value = 'temporary-test-secret'
    verify.click()
    await vi.waitFor(() =>
      expect(window.document.getElementById('channel-credentials-list')!.textContent).toContain('已验证')
    )
    expect(fields[3]!.value).toBe('')
    expect(requests.filter(request => request.action === 'capture').at(-1)).toMatchObject({
      purpose: 'create',
      expectedRevision: 4,
      serviceGeneration: 'service-generation',
      secret: 'temporary-test-secret',
      account: { adapterId: 'feishu', accountId: 'cli_example', tenantId: '' },
    })
    const commit = [...window.document.querySelectorAll('#channel-credentials button')]
      .find(button => button.textContent === '确认保存')!
    ;(window.confirm as ReturnType<typeof vi.fn>).mockReturnValueOnce(false)
    commit.click()
    await vi.waitFor(() => expect(window.confirm).toHaveBeenCalled())
    expect(requests.filter(request => request.action === 'commit')).toHaveLength(0)
    await vi.waitFor(() => expect((commit as HTMLButtonElement).disabled).toBe(false))
    commit.click()
    await vi.waitFor(() => expect(requests.filter(request => request.action === 'commit')).toHaveLength(1))
    expect(requests.find(request => request.action === 'commit')).toEqual({
      action: 'commit',
      draftId: 'draft',
      draft: { displayName: 'Work' },
    })
    await vi.waitFor(() => expect(window.document.getElementById('message')!.textContent).toContain('凭据已保存'))
    await new Promise(resolve => setTimeout(resolve, 10))
  } finally {
    dom.window.close()
  }
})

it('locks an uncertain Channel capture until the user refreshes and checks status', async () => {
  let captures = 0
  const { window, dom } = await mountManager((route, input) => {
    if (route === '/api/session') return { token: 'session' }
    if (route === '/api/state') return base()
    if (route === '/api/channel-credentials' && input.action === 'view') {
      return {
        status: 'available',
        revision: 1,
        serviceGeneration: 'generation',
        writable: true,
        connections: [],
        pendingConnections: [],
      }
    }
    if (route === '/api/channel-credentials' && input.action === 'capture') {
      captures++
      throw new Error('connection lost')
    }
    return { status: 'unavailable' }
  })
  try {
    await vi.waitFor(() =>
      expect(window.document.getElementById('channel-credentials-list')!.textContent).toContain('添加飞书')
    )
    ;[...window.document.querySelectorAll('#channel-credentials button')]
      .find(button => button.textContent === '添加飞书/Lark 连接')!.click()
    const fields = window.document.querySelectorAll<HTMLInputElement>('#channel-credentials-list input')
    fields[0]!.value = 'cli_example'
    fields[2]!.value = 'Work'
    fields[3]!.value = 'temporary-test-secret'
    const verify = [...window.document.querySelectorAll<HTMLButtonElement>('#channel-credentials button')]
      .find(button => button.textContent === '验证并暂存')!
    verify.click()
    await vi.waitFor(() => expect(window.document.getElementById('message')!.textContent).toContain('结果不确定'))
    expect(fields[3]!.value).toBe('')
    expect(verify.disabled).toBe(true)
    verify.click()
    expect(captures).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 10))
  } finally {
    dom.window.close()
  }
})

it('keeps a Channel credential draft when an earlier refresh completes late', async () => {
  let reads = 0
  let release: (() => void) | undefined
  const { window, dom } = await mountManager(async (route, input) => {
    if (route === '/api/session') return { token: 'session' }
    if (route === '/api/state') return base()
    if (route === '/api/channel-credentials' && input.action === 'view') {
      reads++
      if (reads === 2) {
        await new Promise<void>(resolve => {
          release = resolve
        })
      }
      return {
        status: 'available',
        revision: 1,
        serviceGeneration: 'generation',
        writable: true,
        connections: [],
        pendingConnections: [],
      }
    }
    return { status: 'unavailable' }
  })
  try {
    await vi.waitFor(() =>
      expect(window.document.getElementById('channel-credentials-list')!.textContent).toContain('添加飞书')
    )
    window.document.getElementById('refresh-channel-credentials')!.click()
    await vi.waitFor(() => expect(release).toBeDefined())
    ;[...window.document.querySelectorAll('#channel-credentials button')]
      .find(button => button.textContent === '添加飞书/Lark 连接')!.click()
    const secret = window.document.querySelector<HTMLInputElement>('#channel-credentials-list input[type=password]')!
    secret.value = 'unsaved-fixture-secret'
    release!()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(window.document.querySelector<HTMLInputElement>('#channel-credentials-list input[type=password]')?.value)
      .toBe('unsaved-fixture-secret')
  } finally {
    dom.window.close()
  }
})

it('lets the user resolve a pending Channel tenant against the observed revision', async () => {
  const requests: Array<Record<string, any>> = []
  const { window, dom } = await mountManager((route, input) => {
    if (route === '/api/session') return { token: 'session' }
    if (route === '/api/state') return base()
    if (route === '/api/channel-credentials') {
      requests.push(input)
      if (input.action === 'view') {
        return {
          status: 'available',
          revision: 9,
          serviceGeneration: 'generation',
          writable: true,
          connections: [],
          pendingConnections: [{ account: { adapterId: 'lark', accountId: 'cli_fixture' }, displayName: 'Work' }],
        }
      }
      if (input.action === 'resolve-tenant') return { status: 'applied', code: 'APPLIED' }
    }
    return { status: 'unavailable' }
  })
  try {
    await vi.waitFor(() =>
      expect(window.document.getElementById('channel-credentials-list')!.textContent).toContain('租户待确认')
    )
    ;[...window.document.querySelectorAll('#channel-credentials button')]
      .find(button => button.textContent === '确认租户')!.click()
    window.document.querySelector<HTMLInputElement>('#channel-credentials-list input')!.value = 'tenant-1'
    const confirm = [...window.document.querySelectorAll<HTMLButtonElement>('#channel-credentials button')]
      .filter(button => button.textContent === '确认租户').at(-1)!
    ;(window.confirm as ReturnType<typeof vi.fn>).mockReturnValueOnce(false)
    confirm.click()
    await vi.waitFor(() => expect(confirm.disabled).toBe(false))
    expect(requests.filter(request => request.action === 'resolve-tenant')).toHaveLength(0)
    confirm.click()
    await vi.waitFor(() => expect(requests.filter(request => request.action === 'resolve-tenant')).toHaveLength(1))
    expect(requests.find(request => request.action === 'resolve-tenant')).toMatchObject({
      expectedRevision: 9,
      serviceGeneration: 'generation',
      tenantId: 'tenant-1',
      account: { adapterId: 'lark', accountId: 'cli_fixture', tenantId: '' },
    })
    await vi.waitFor(() => expect(window.document.getElementById('message')!.textContent).toContain('租户已确认'))
    await new Promise(resolve => setTimeout(resolve, 10))
  } finally {
    dom.window.close()
  }
})

it('fences a Channel enablement change to the displayed generation and does not retry unknown results', async () => {
  const requests: Array<Record<string, any>> = []
  const account = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'tenant' }
  const { window, dom } = await mountManager((route, input) => {
    if (route === '/api/session') return { token: 'session' }
    if (route === '/api/state') return base()
    if (route === '/api/channel-credentials') {
      requests.push(input)
      if (input.action === 'view') {
        return {
          status: 'available',
          revision: 7,
          serviceGeneration: 'generation',
          writable: true,
          connections: [{ ref: account, enabled: true, connectionState: 'retrying' }],
          pendingConnections: [],
        }
      }
      if (input.action === 'set-enabled') return { status: 'unknown' }
    }
    return { status: 'unavailable' }
  })
  try {
    await vi.waitFor(() =>
      expect(window.document.getElementById('channel-credentials-list')!.textContent).toContain('重试中')
    )
    const toggle = [...window.document.querySelectorAll<HTMLButtonElement>('#channel-credentials button')]
      .find(button => button.textContent === '停用连接')!
    toggle.click()
    await vi.waitFor(() => expect(window.document.getElementById('message')!.textContent).toContain('结果不确定'))
    expect(requests.filter(request => request.action === 'set-enabled')).toEqual([{
      action: 'set-enabled',
      account,
      enabled: false,
      expectedRevision: 7,
      serviceGeneration: 'generation',
    }])
    await vi.waitFor(() => expect(toggle.disabled).toBe(true))
    toggle.click()
    expect(requests.filter(request => request.action === 'set-enabled')).toHaveLength(1)
    await new Promise(resolve => setTimeout(resolve, 10))
  } finally {
    dom.window.close()
  }
})

it('confirms before one plugin editor discards another unsaved editor', async () => {
  const calls: string[] = []
  const descriptor = {
    identity: { source: 'https://example.test', pluginId: 'sample', serviceId: 'runtime' },
    scope: { profileId: 'fixture', generation: 'generation' },
    revision: 1,
    writable: true,
    configuration: { label: 'before' },
    secrets: [],
    schema: {
      projection: {
        kind: 'schemastery',
        envelope: {
          uid: 1,
          refs: {
            1: { type: 'object', dict: { label: 2 } },
            2: { type: 'string' },
          },
        },
      },
    },
  }
  const { window, dom } = await mountManager((route, input) => {
    if (route === '/api/session') return { token: 'session' }
    if (route === '/api/state') return base()
    if (route === '/api/plugin-configuration') {
      calls.push(input.action)
      if (input.action === 'read') {
        return {
          status: 'ok',
          configuration: {
            writable: true,
            applies: 'live',
            revision: 1,
            fields: [{ path: ['name'], label: '名称', value: 'before' }],
            secrets: [],
          },
        }
      }
      if (input.action === 'services') return { status: 'ok', services: [descriptor] }
      if (input.action === 'update') return { status: 'ok' }
    }
    return { status: 'unavailable' }
  })
  try {
    ;[...window.document.querySelectorAll('button')].find(button => button.textContent === '配置')!.click()
    await vi.waitFor(() => expect(window.document.querySelector('#plugins textarea')).not.toBeNull())
    const field = window.document.querySelector<HTMLInputElement>('#plugins input')!
    const service = window.document.querySelector<HTMLTextAreaElement>('#plugins textarea')!
    field.value = 'edited plugin'
    field.dispatchEvent(new window.Event('input', { bubbles: true }))
    service.value = JSON.stringify({ label: 'unsaved service' })
    service.dispatchEvent(new window.Event('input', { bubbles: true }))
    ;(window.confirm as ReturnType<typeof vi.fn>).mockReturnValueOnce(false)
    const save = [...window.document.querySelectorAll('button')].find(button => button.textContent === '保存插件配置')!
    save.click()
    await vi.waitFor(() => expect(window.confirm).toHaveBeenCalled())
    expect(calls).not.toContain('update')
    expect(service.value).toContain('unsaved service')
    save.click()
    await vi.waitFor(() => expect(calls).toContain('update'))
    await new Promise(resolve => setTimeout(resolve, 10))
  } finally {
    dom.window.close()
  }
})

it('keeps another plugin draft while saving and refreshing the first one', async () => {
  const both = base()
  both.management.plugins.push({ id: 'second', name: 'Second', status: 'disabled', enabled: false })
  both.rendererPlugins.plugins.push({ id: 'second', name: 'Second', status: 'disabled', writable: true })
  let release: (() => void) | undefined
  const { window, dom } = await mountManager(async (route, input) => {
    if (route === '/api/session') return { token: 'session' }
    if (route === '/api/state') return both
    if (route === '/api/plugin-configuration' && input.action === 'read') {
      return {
        status: 'ok',
        configuration: {
          writable: true,
          applies: 'live',
          revision: 1,
          fields: [{ path: ['name'], label: '名称', value: 'before' }],
          secrets: [],
        },
      }
    }
    if (route === '/api/plugin-configuration' && input.action === 'services') return { status: 'ok', services: [] }
    if (route === '/api/plugin-configuration' && input.action === 'update') {
      await new Promise<void>(resolve => {
        release = resolve
      })
      return { status: 'ok' }
    }
    return { status: 'unavailable' }
  })
  try {
    const cards = [...window.document.querySelectorAll('#plugins .card')]
    for (const card of cards) {
      ;[...card.querySelectorAll('button')].find(button => button.textContent === '配置')!.click()
    }
    await vi.waitFor(() => expect(window.document.querySelectorAll('#plugins input')).toHaveLength(2))
    const fields = [...window.document.querySelectorAll<HTMLInputElement>('#plugins input')]
    fields.forEach((field, index) => {
      field.value = `draft-${index}`
      field.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    ;[...cards[0]!.querySelectorAll('button')].find(button => button.textContent === '保存插件配置')!.click()
    await vi.waitFor(() => expect(release).toBeDefined())
    expect(fields[0]!.disabled).toBe(true)
    expect(fields[1]!.disabled).toBe(false)
    release!()
    await vi.waitFor(() => expect(window.document.getElementById('message')!.textContent).toContain('已保存'))
    window.document.getElementById('refresh')!.click()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(window.document.querySelectorAll<HTMLInputElement>('#plugins input')[1]!.value).toBe('draft-1')
  } finally {
    dom.window.close()
  }
})

it('never submits an unavailable read as an empty service list and freezes pending edits', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cx-manager-ui-store-'))
  const configPath = path.join(directory, 'config.json')
  await writeFile(configPath, JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })
  const service = {
    id: 'sample',
    displayName: 'Sample',
    baseUrl: 'https://example.test',
    protocols: ['openai-responses'] as const,
    codexModels: ['model'],
    claudeModels: [],
    enabled: true,
  }
  const empty = await readModelServices(configPath, {})
  if (empty.status !== 'ok') throw new Error('fixture read failed')
  await saveModelServices(configPath, { expectedRevision: empty.revision, services: [service] })
  let reads = 0, saves = 0
  let release: (() => void) | undefined
  const { window, dom } = await mountManager(async (route, input) => {
    if (route === '/api/session') return { token: 'session' }
    if (route === '/api/state') {
      reads++
      const services = await readModelServices(configPath, {})
      return {
        ...base(),
        services: reads === 2
          ? { status: 'unavailable' }
          : { ...services, managerSafeWrite: MODEL_SERVICE_SAFE_WRITE_CONTRACT },
      }
    }
    if (route === '/api/model-services') {
      saves++
      await new Promise<void>(resolve => {
        release = resolve
      })
      return await saveModelServices(configPath, input)
    }
    return { status: 'unavailable' }
  })
  try {
    const inputs = window.document.querySelectorAll<HTMLInputElement>('#models input')
    inputs[1]!.value = 'Renamed'
    inputs[1]!.dispatchEvent(new window.Event('input', { bubbles: true }))
    window.document.getElementById('save-models')!.click()
    await vi.waitFor(() => expect(release).toBeDefined())
    expect(inputs[1]!.disabled).toBe(true)
    expect((window.document.getElementById('add-model') as HTMLButtonElement).disabled).toBe(true)
    release!()
    await vi.waitFor(() => expect(window.document.getElementById('models')!.textContent).toContain('未提供'))
    const save = window.document.getElementById('save-models') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    save.click()
    expect(saves).toBe(1)
    window.document.getElementById('refresh')!.click()
    await vi.waitFor(() => expect(window.document.getElementById('models')!.textContent).toContain('Renamed'))
    expect((await readModelServices(configPath, {}) as { services: Array<{ displayName: string }> }).services)
      .toEqual([expect.objectContaining({ displayName: 'Renamed' })])
  } finally {
    dom.window.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('reports staged service settings as pending restart rather than applied', async () => {
  const descriptor = {
    identity: { source: 'https://example.test', pluginId: 'sample', serviceId: 'runtime' },
    scope: { profileId: 'fixture', generation: 'generation' },
    revision: 1,
    writable: true,
    configApplies: 'app-restart',
    restartRequired: true,
    configuration: { label: 'before' },
    secrets: [],
    schema: {
      projection: {
        kind: 'schemastery',
        envelope: {
          uid: 1,
          refs: {
            1: { type: 'object', dict: { label: 2 } },
            2: { type: 'string' },
          },
        },
      },
    },
  }
  const { window, dom } = await mountManager((path, input) => {
    if (path === '/api/session') return { token: 'session' }
    if (path === '/api/state') return base()
    if (path === '/api/plugin-configuration' && input.action === 'read') {
      return { status: 'ok', configuration: { writable: true, applies: 'live', revision: 1, fields: [], secrets: [] } }
    }
    if (path === '/api/plugin-configuration' && input.action === 'services') {
      return { status: 'ok', services: [descriptor] }
    }
    if (path === '/api/plugin-configuration' && input.action === 'update-service') {
      return { status: 'ok', result: { status: 'staged' } }
    }
    return { status: 'unavailable' }
  })
  try {
    ;[...window.document.querySelectorAll('button')].find(button => button.textContent === '配置')!.click()
    await vi.waitFor(() => expect(window.document.querySelector('#plugins textarea')).not.toBeNull())
    expect(window.document.getElementById('plugins')!.textContent).toContain('等待重启')
    const editor = window.document.querySelector<HTMLTextAreaElement>('#plugins textarea')!
    editor.value = JSON.stringify({ label: 'after' })
    editor.dispatchEvent(new window.Event('input', { bubbles: true }))
    ;[...window.document.querySelectorAll('button')].find(button => button.textContent === '保存服务配置')!.click()
    await vi.waitFor(() => expect(window.document.getElementById('message')!.textContent).toContain('重启'))
    await new Promise(resolve => setTimeout(resolve, 10))
  } finally {
    dom.window.close()
  }
})

it.each(['rejected', 'conflict'])('locks plugin service editing on %s after an uncertain commit', async status => {
  let writes = 0
  const descriptor = {
    identity: { source: 'https://example.test', pluginId: 'sample', serviceId: 'runtime' },
    scope: { profileId: 'fixture', generation: 'generation' },
    revision: 1,
    writable: true,
    configuration: { label: 'before' },
    secrets: [],
    schema: {
      projection: {
        kind: 'schemastery',
        envelope: {
          uid: 1,
          refs: {
            1: { type: 'object', dict: { label: 2 } },
            2: { type: 'string' },
          },
        },
      },
    },
  }
  const { window, dom } = await mountManager((route, input) => {
    if (route === '/api/session') return { token: 'session' }
    if (route === '/api/state') return base()
    if (route === '/api/plugin-configuration' && input.action === 'read') {
      return {
        status: 'ok',
        configuration: { writable: true, applies: 'live', revision: 1, fields: [], secrets: [] },
      }
    }
    if (route === '/api/plugin-configuration' && input.action === 'services') {
      return { status: 'ok', services: [descriptor] }
    }
    if (route === '/api/plugin-configuration' && input.action === 'update-service') {
      writes++
      return { status: 'ok', result: { status, error: { code: 'validation-failed' } } }
    }
    return { status: 'unavailable' }
  })
  try {
    ;[...window.document.querySelectorAll('button')].find(button => button.textContent === '配置')!.click()
    await vi.waitFor(() => expect(window.document.querySelector('#plugins textarea')).not.toBeNull())
    const editor = window.document.querySelector<HTMLTextAreaElement>('#plugins textarea')!
    editor.value = JSON.stringify({ label: 'after' })
    editor.dispatchEvent(new window.Event('input', { bubbles: true }))
    const save = [...window.document.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === '保存服务配置')!
    save.click()
    await vi.waitFor(() => expect(window.document.getElementById('message')!.textContent).toContain('结果不确定'))
    await vi.waitFor(() => expect(save.disabled).toBe(true))
    expect(editor.value).toContain('after')
    save.click()
    expect(writes).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 10))
  } finally {
    dom.window.close()
  }
})

it.each(['unknown', 'transport'])('locks plugin writes on an uncertain %s update until reread', async reason => {
  let writes = 0
  const { window, dom } = await mountManager((route, input) => {
    if (route === '/api/session') return { token: 'session' }
    if (route === '/api/state') return base()
    if (route === '/api/plugin-configuration' && input.action === 'read') {
      return {
        status: 'ok',
        configuration: {
          writable: true,
          applies: 'live',
          revision: 1,
          fields: [{ path: ['name'], label: '名称', value: 'before' }],
          secrets: [],
        },
      }
    }
    if (route === '/api/plugin-configuration' && input.action === 'services') return { status: 'ok', services: [] }
    if (route === '/api/plugin-configuration' && input.action === 'update') {
      writes++
      if (reason === 'transport') throw new Error('connection lost')
      return { status: 'unknown', reason: 'renderer-disconnected' }
    }
    return { status: 'unavailable' }
  })
  try {
    const configure = [...window.document.querySelectorAll<HTMLButtonElement>('#plugins button')]
      .find(button => button.textContent === '配置')!
    configure.click()
    await vi.waitFor(() => expect(window.document.querySelector('#plugins input')).not.toBeNull())
    const field = window.document.querySelector<HTMLInputElement>('#plugins input')!
    field.value = 'draft'
    field.dispatchEvent(new window.Event('input', { bubbles: true }))
    const save = [...window.document.querySelectorAll<HTMLButtonElement>('#plugins button')]
      .find(button => button.textContent === '保存插件配置')!
    save.click()
    await vi.waitFor(() => expect(window.document.getElementById('message')!.textContent).toContain('结果不确定'))
    const enable = [...window.document.querySelectorAll<HTMLButtonElement>('#plugins button')]
      .find(button => button.textContent === '启用')!
    expect(save.disabled).toBe(true)
    expect(enable.disabled).toBe(true)
    expect(configure.disabled).toBe(false)
    expect(field.value).toBe('draft')
    save.click()
    expect(writes).toBe(1)
    configure.click()
    await vi.waitFor(() => expect(enable.disabled).toBe(false))
    await new Promise(resolve => setTimeout(resolve, 10))
  } finally {
    dom.window.close()
  }
})
