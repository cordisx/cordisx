import vm from 'node:vm'
import { vi } from 'vitest'
import { createNativeSubmissionCdpAuthority } from '../../packages/cli/src/launcher/native-submission-cdp-channel.js'
import type { CdpSession } from '../../packages/cli/src/launcher/cdp-session.js'
import type {
  NativeSubmissionController,
  NativeSubmissionScope,
} from '../../packages/cli/src/launcher/native-submission-controller.js'

import { createNativeSubmissionController } from '../../packages/cli/src/launcher/native-submission-controller.js'
export async function harness(options: Readonly<{
  controllerOptions?: Pick<
    import('../../packages/cli/src/launcher/native-submission-controller.js').NativeSubmissionControllerOptions,
    'prepareRemoteProvider' | 'providerSource' | 'validateSelection' | 'operationTtlMs' | 'now'
  >
  realController?: boolean
  taskExecutionUrl?: string
  evaluate?: (expression: string) => unknown
  submissionAvailable?: boolean
  documentTimeOrigin?: () => number
  management?: Parameters<typeof createNativeSubmissionCdpAuthority>[0]['management']
  defaultProviderId?: string
  defaultModelId?: string
  catalogSubscribe?: (listener: () => void) => () => void
  catalog?: () => readonly {
    providerId: string
    pluginId: string
    label: string
    models: readonly { id: string; label: string; aliases?: readonly string[] }[]
  }[]
}> = {}) {
  const world: Record<string, any> = { crypto, setTimeout, clearTimeout }
  let live: NativeSubmissionScope
  let receive: (params: Record<string, any>) => void
  const idle = vi.fn(async () => true)
  const authority = createNativeSubmissionCdpAuthority({
    ...(options.taskExecutionUrl === undefined ? {} : { taskExecutionUrl: options.taskExecutionUrl }),
    ...(options.submissionAvailable === undefined ? {} : { submissionAvailable: options.submissionAvailable }),
    ...(options.management ? { management: options.management } : {}),
    ...(options.catalogSubscribe === undefined ? {} : { catalogSubscribe: options.catalogSubscribe }),
    catalog: async () =>
      options.catalog?.() ?? [{
        providerId: 'provider-b',
        pluginId: 'plugin-b',
        label: 'Provider B',
        models: [{ id: 'model-b', label: 'Model B', aliases: [] }],
      }],
    isThreadIdle: idle,
    ...(options.defaultProviderId === undefined ? {} : { defaultProviderId: options.defaultProviderId }),
    ...(options.defaultModelId === undefined ? {} : { defaultModelId: options.defaultModelId }),
  })
  const session = {
    isClosed: () => false,
    onEvent: (_event: string, handler: typeof receive) => {
      receive = handler
      return () => {}
    },
    send: vi.fn(async (method: string, params: Record<string, any>) => {
      if (method === 'Runtime.addBinding') {
        world[params.name] = (payload: string) => receive({ name: params.name, payload })
      }
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script' }
      if (method === 'Runtime.evaluate') {
        if (params.expression === 'performance.timeOrigin') {
          return { result: { value: options.documentTimeOrigin?.() ?? 1_000 } }
        }
        if (params.expression.includes('__cordisxNativeAgentTask_initial')) {
          return { result: { value: await options.evaluate?.(params.expression) ?? false } }
        }
        if (
          params.expression === 'globalThis.__cordisxNativeSubmissionAuthority?.snapshot?.()'
          || params.expression.startsWith('globalThis.__cordisxNativeSubmissionAuthority?.resolve?.(')
        ) {
          return { result: { value: { scope: live } } }
        }
        vm.runInNewContext(params.expression, world)
      }
      return {}
    }),
  }
  const controller = {
    prepareSubmission: vi.fn<NativeSubmissionController['prepareSubmission']>(async () => ({
      kind: 'reject',
      reason: 'unsupported-submission-intent',
    })),
    commitSelection: vi.fn<NativeSubmissionController['commitSelection']>(async () => ({
      kind: 'reject',
      reason: 'stale-operation',
    })),
    releaseScope: vi.fn(async () => {}),
  } as unknown as NativeSubmissionController
  const credentialDispose = vi.fn()
  const prepare = vi.fn(async () => ({
    serviceGeneration: 'service',
    endpoint: { baseUrl: 'http://127.0.0.1:43127/v1', wireApi: 'responses' as const },
    auth: { scheme: 'none' as const },
    dispose: credentialDispose,
  }))
  const switchThread = vi.fn(async () => {})
  const actual = options.realController
    ? createNativeSubmissionController({
      selection: authority.selection,
      runtime: authority.runtime,
      credentials: { prepare },
      existingThread: { switch: switchThread },
      validateSelection: async selected =>
        selected.providerId === 'openai'
        || (await options.catalog?.())?.some(provider =>
            provider.providerId === selected.providerId
            && provider.models.some(model => model.id === selected.model)
          ) === true,
      ...options.controllerOptions,
    })
    : controller
  authority.bindController(actual)
  const installed = await authority.install(session as unknown as CdpSession, {
    id: 'target',
    url: 'app://-/index.html',
    type: 'page',
    title: '',
  })
  const draft: NativeSubmissionScope = { ...world.__cordisxNativeProviderOwner, navigationGeneration: 3 }
  live = draft
  return {
    session,
    authority,
    actual,
    prepare,
    switchThread,
    credentialDispose,
    draft,
    idle,
    installed,
    world,
    channel: world.__cordisxNativeProviderCommandChannel,
    controller,
    setLive(value: NativeSubmissionScope) {
      live = value
    },
  }
}
