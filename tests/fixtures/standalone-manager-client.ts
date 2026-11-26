import { webcrypto } from 'node:crypto'
import { JSDOM } from 'jsdom'
import { vi } from 'vitest'
import { startStandaloneManager } from '../../packages/cli/src/independent-manager/standalone-client.js'

export const entryToken = 'a'.repeat(64)
export const sessionToken = 'b'.repeat(64)
export const rendererId = 'c'.repeat(64)
export const commandId = 'd'.repeat(64)
export const origin = 'http://127.0.0.1:43123'
export const activation = {
  recordKind: 'active',
  profileId: 'work',
  runtimeGeneration: 'owner-1',
  revision: 0,
  lastGoodRevision: 0,
  plugins: [],
}
const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200 })

function abortResponse(signal: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(new Error('closed'))
    signal.addEventListener('abort', () => reject(new Error('closed')), { once: true })
  })
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

export function fixture(input: {
  readonly browserOrigin?: string
  readonly secureContext?: boolean
  readonly noServiceWorker?: boolean
  readonly invalidSessionAt?: number
  readonly sessionTransportFailuresAt?: readonly number[]
  readonly unauthorizedSessionAt?: number
  readonly bundlePath?: string
  readonly graphs?: readonly unknown[]
  readonly configuredGraphs?: readonly { readonly pluginId: string; readonly moduleGeneration: string }[]
  readonly exchangeGate?: Promise<void>
  readonly entryTransportFailures?: number
  readonly entryUnauthorized?: boolean
  readonly entryMalformed?: boolean
  readonly openFailure?: { readonly status: number; readonly body: unknown }
  readonly openTransportFailure?: 'fetch' | 'body'
  readonly bootstrapGate?: Promise<void>
  readonly bootstrapTransportFailure?: 'fetch' | 'body'
  readonly bootstrapFailure?: { readonly status: number; readonly body: unknown }
  readonly importGate?: Promise<void>
  readonly startGate?: Promise<void>
  readonly loseAck?: boolean
  readonly resume?: boolean
  readonly resumeGate?: Promise<void>
  readonly loseResumeResponse?: boolean
  readonly resumeTransportFailures?: number
  readonly resumePendingResponses?: number
  readonly resumePendingDelay?: number
  readonly resumeUnauthorized?: boolean
  readonly resumeAttemptUnavailable?: boolean
  readonly issueResume?: boolean
  readonly controlledPoll?: boolean
  readonly pollRecovery?: boolean
  readonly holdBindings?: boolean
  readonly pluginManagement?: boolean
  readonly permissionPolicy?: boolean
  readonly modelServices?: boolean
  readonly admissionGate?: Promise<void>
  readonly credentialFailure?: boolean
} = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: `${origin}/?host=1${input.resume ? '' : `#${entryToken}`}`,
  })
  if (input.browserOrigin) {
    dom.reconfigure({ url: input.browserOrigin + '/?host=1' + (input.resume ? '' : '#' + entryToken) })
  }
  const win = dom.window
  if (input.secureContext !== undefined) {
    Object.defineProperty(win, 'isSecureContext', { value: input.secureContext })
  }
  if (input.permissionPolicy) Object.defineProperty(win.crypto, 'subtle', { value: webcrypto.subtle })
  if (input.resumeAttemptUnavailable) {
    Object.defineProperty(win.crypto, 'getRandomValues', {
      value: () => {
        throw new Error('unavailable')
      },
    })
  }
  let beforeUnload: ((event: BeforeUnloadEvent) => void) | undefined
  let pageHide: ((event: PageTransitionEvent) => void) | undefined
  const addListener = win.addEventListener.bind(win)
  Object.defineProperty(win, 'addEventListener', {
    value: (type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) => {
      if (type === 'beforeunload') beforeUnload = listener as (event: BeforeUnloadEvent) => void
      if (type === 'pagehide') pageHide = listener as (event: PageTransitionEvent) => void
      addListener(type, listener, options)
    },
  })
  if (input.resume) win.sessionStorage.setItem('cordisx-manager-resume-id', 'e'.repeat(64))
  const serviceWorker = new win.EventTarget()
  if (!input.noServiceWorker) Object.defineProperty(win.navigator, 'serviceWorker', { value: serviceWorker })
  const unavailable = vi.fn()
  const registry = { stage: vi.fn(), publish: vi.fn(), retire: vi.fn(), dispose: vi.fn() }
  const runtime = {
    activePluginGeneration: vi.fn(() => activation),
    configuredPluginGraphGenerations: vi.fn(() => input.configuredGraphs ?? []),
    pluginRegistryEpoch: vi.fn(() => 3),
    settleRegistryProjection: vi.fn(async () => {}),
    adoptRecoveredActivation: vi.fn(),
    stagePluginMutation: vi.fn(),
    publishPluginMutation: vi.fn(),
    completePluginMutation: vi.fn(),
    finalizePluginMutation: vi.fn(),
    rollbackPluginMutation: vi.fn(),
    dispose: vi.fn(async () => {}),
  }
  let allowAdmission!: () => void
  let checks = 0
  let polls = 0
  let resumes = 0
  let entryTransportFailures = input.entryTransportFailures ?? 0
  let resumeTransportFailures = input.resumeTransportFailures ?? 0
  let rejectPoll: ((error: Error) => void) | undefined
  let resolvePoll: ((response: Response) => void) | undefined
  let rejectBinding: ((error: Error) => void) | undefined
  let sessionCurrent = true
  const fetch = vi.fn((path: string, options: RequestInit): Promise<Response> => {
    if (path === '/api/session') {
      if (entryTransportFailures > 0) {
        entryTransportFailures--
        return Promise.reject(new Error('interrupted entry exchange'))
      }
      if (input.entryUnauthorized) return Promise.resolve(new Response('{}', { status: 401 }))
      if (input.entryMalformed) return Promise.resolve(new Response('{}'))
      const result = response({ token: sessionToken, ...(input.issueResume ? { resumeId: 'f'.repeat(64) } : {}) })
      return input.exchangeGate
        ? Promise.race([input.exchangeGate.then(() => result), abortResponse(options.signal!)])
        : Promise.resolve(result)
    }
    if (path === `/api/session/resume/${'e'.repeat(64)}`) {
      if (input.loseResumeResponse) return Promise.reject(new Error('lost recovery response'))
      if (resumeTransportFailures > 0) {
        resumeTransportFailures--
        return Promise.reject(new Error('interrupted recovery response'))
      }
      if (input.resumeUnauthorized) return Promise.resolve(new Response('{}', { status: 401 }))
      if (input.resumeGate) {
        return Promise.race([
          input.resumeGate.then(() => response({ token: sessionToken, resumeId: 'f'.repeat(64) })),
          abortResponse(options.signal!),
        ])
      }
      if (resumes++ < (input.resumePendingResponses ?? 1)) {
        const pending = new Response(JSON.stringify({ error: 'RESUME_PENDING' }), { status: 409 })
        return input.resumePendingDelay === undefined
          ? Promise.resolve(pending)
          : Promise.race([
            new Promise<Response>(resolve => setTimeout(() => resolve(pending), input.resumePendingDelay)),
            abortResponse(options.signal!),
          ])
      }
      return Promise.resolve(response({ token: sessionToken, resumeId: 'f'.repeat(64) }))
    }
    if (path === '/api/renderer/open') {
      if (input.openTransportFailure === 'fetch') return Promise.reject(new TypeError('lost open response'))
      if (input.openFailure) {
        const result = new Response(JSON.stringify(input.openFailure.body), { status: input.openFailure.status })
        if (input.openTransportFailure === 'body') {
          vi.spyOn(result, 'text').mockRejectedValue(new TypeError('lost open error body'))
        }
        return Promise.resolve(result)
      }
      const result = response({
        status: 'ok',
        rendererId,
        generation: 'owner-1',
        profileId: 'work',
        channels: [
          'config',
          ...(input.pluginManagement ? ['plugin-management'] : []),
          ...(input.permissionPolicy ? ['permission-policy'] : []),
          ...(input.modelServices ? ['model-services'] : []),
          ...(input.credentialFailure ? ['channel-credentials'] : []),
        ],
        commands: true,
      })
      if (input.openTransportFailure === 'body') {
        vi.spyOn(result, 'text').mockRejectedValue(new TypeError('lost open body'))
      }
      return Promise.resolve(result)
    }
    if (path === '/api/renderer/session') {
      checks++
      if (input.sessionTransportFailuresAt?.includes(checks)) {
        return Promise.reject(new TypeError('temporary network failure'))
      }
      if (checks === input.unauthorizedSessionAt) {
        return Promise.resolve(new Response('{}', { status: 401 }))
      }
      return Promise.resolve(
        response({ current: sessionCurrent && checks !== input.invalidSessionAt, rendererId, generation: 'owner-1' }),
      )
    }
    if (path === '/api/renderer/bootstrap') {
      if (input.bootstrapTransportFailure === 'fetch') return Promise.reject(new TypeError('lost bootstrap response'))
      if (input.bootstrapFailure) {
        return Promise.resolve(
          new Response(JSON.stringify(input.bootstrapFailure.body), {
            status: input.bootstrapFailure.status,
          }),
        )
      }
      const result = response({
        status: 'ok',
        bundleUrl: input.bundlePath ?? '/api/renderer/bundle.js',
        initialGraphs: input.graphs ?? [],
      })
      if (input.bootstrapTransportFailure === 'body') {
        vi.spyOn(result, 'text').mockRejectedValue(new TypeError('lost bootstrap body'))
      }
      return input.bootstrapGate
        ? Promise.race([input.bootstrapGate.then(() => result), abortResponse(options.signal!)])
        : Promise.resolve(result)
    }
    if (path === '/api/renderer/poll-recover' && input.pollRecovery !== undefined) {
      return Promise.resolve(response({ recovered: input.pollRecovery }))
    }
    if (path === '/api/renderer/poll') {
      if (polls++ === 0) {
        return Promise.resolve(response({
          command: {
            id: commandId,
            sequence: 1,
            method: 'synchronize',
            payload: { active: activation, registryEpoch: 3 },
          },
        }))
      }
      if (!input.controlledPoll) return abortResponse(options.signal!)
      return new Promise((resolve, reject) => {
        resolvePoll = resolve
        rejectPoll = reject
        options.signal!.addEventListener('abort', () => reject(new Error('closed')), { once: true })
      })
    }
    if (path === '/api/renderer/admit') {
      return new Promise((resolve, reject) => {
        allowAdmission = () => {
          void Promise.resolve(input.admissionGate).then(() => resolve(response({ admitted: true })))
        }
        options.signal!.addEventListener('abort', () => reject(new Error('closed')), { once: true })
      })
    }
    if (path === '/api/renderer/acknowledge') {
      if (input.loseAck) return Promise.reject(new Error('lost acknowledgement'))
      allowAdmission()
      return Promise.resolve(response({ accepted: true }))
    }
    if (path === '/api/renderer/close') return Promise.resolve(response({ closed: true }))
    if (path === '/api/renderer/binding' && input.credentialFailure) {
      return Promise.resolve(new Response('{}', { status: 503 }))
    }
    if (path === '/api/renderer/binding' && input.holdBindings) {
      return Promise.race([
        abortResponse(options.signal!),
        new Promise<Response>((_, reject) => rejectBinding = reject),
      ])
    }
    throw new Error(`Unexpected request ${path}`)
  })
  Object.defineProperty(win, 'fetch', { value: fetch })
  const auth = {
    start: vi.fn(async () => true),
    isBound: vi.fn(async (): Promise<boolean | undefined> => true),
    recover: vi.fn(async () => true),
    revokeLocal: vi.fn(async () => true),
  }
  const createResourceAuth = vi.fn((config: { isSessionCurrent: () => Promise<boolean> }) => {
    auth.start.mockImplementation(async () => await config.isSessionCurrent())
    return auth
  })
  let reportResultUnknown: ((source?: 'permission-policy') => void) | undefined
  const start = vi.fn(async (...args: unknown[]) => {
    reportResultUnknown = args[2] as (source?: 'permission-policy') => void
    await input.startGate
    Object.assign(win, { __cordisxRuntime: runtime, __cordisxPluginGenerationResourcesV1: registry })
    return runtime
  })
  const importBundle = vi.fn(async () => {
    await input.importGate
    return { startStandaloneManagerComposition: start }
  })
  const manager = startStandaloneManager({
    window: win as unknown as Window,
    onUnavailable: unavailable,
    createResourceAuth: createResourceAuth as never,
    importBundle: importBundle as never,
  })
  return {
    dom,
    win,
    serviceWorker,
    manager,
    fetch,
    auth,
    start,
    importBundle,
    unavailable,
    runtime,
    registry,
    beforeUnload: () => beforeUnload?.({ isTrusted: true } as BeforeUnloadEvent),
    pageHide: () => pageHide?.({ isTrusted: true } as PageTransitionEvent),
    failPoll: () => rejectPoll?.(new Error('navigation interrupted the poll')),
    denyPoll: () => resolvePoll?.(new Response('{}', { status: 401 })),
    failBinding: () => rejectBinding?.(new Error('navigation interrupted the binding')),
    reportResultUnknown: () => reportResultUnknown?.(),
    reportPermissionUnknown: () => reportResultUnknown?.('permission-policy'),
    deliverPoll: (value: unknown) => resolvePoll?.(response({ command: value })),
    pollStarted: () => rejectPoll !== undefined,
    revokeSession: () => {
      sessionCurrent = false
    },
  }
}
