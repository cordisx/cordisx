import { isModelReasoningEffort, type ModelReasoningEffort } from '../../model-reasoning-capabilities.js'

interface ReactFiber {
  readonly return?: ReactFiber | null
  readonly child?: ReactFiber | null
  readonly sibling?: ReactFiber | null
  readonly alternate?: ReactFiber | null
  readonly memoizedProps?: unknown
  readonly stateNode?: { readonly current?: ReactFiber }
}

export interface NativeComposerCreationSelection {
  readonly clientThreadId: string
  readonly model: string
  readonly reasoningEffort: ModelReasoningEffort
}

export interface NativeComposerCreationInput {
  readonly selection: NativeComposerCreationSelection
  /** Private admission identity; never publish it in selector snapshots or diagnostics. */
  readonly operationToken?: string
}

export interface NativeComposerCreationRoute {
  readonly clientThreadId: string
  readonly threadId?: string
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value)

function currentFiber(element: HTMLElement): ReactFiber | undefined {
  const key = Object.getOwnPropertyNames(element).find(key => key.startsWith('__reactFiber$'))
  if (!key) return undefined
  const fiber = (element as unknown as Record<string, unknown>)[key] as ReactFiber | undefined
  let root = fiber
  for (let depth = 0; root?.return && depth < 128; depth++) root = root.return
  return root?.stateNode?.current && root.stateNode.current !== root ? fiber?.alternate ?? undefined : fiber
}

function creationSelection(
  entry: Record<string, unknown>,
  clientThreadId: string,
  hostId: string,
  worktree: boolean,
): NativeComposerCreationInput | undefined {
  if (entry.clientThreadId !== clientThreadId || entry.hostId !== hostId) return undefined
  if (
    worktree
      ? entry.launchMode !== 'start-conversation'
        || !['queued', 'creating', 'setting-up', 'worktree-ready'].includes(String(entry.phase))
      : !['queued', 'creating'].includes(String(entry.status))
  ) return undefined
  const input = record(worktree ? entry.startConversationParamsInput : entry.task)
  const settings = record(record(input?.collaborationMode)?.settings)
  // These are captured creation choices. Config defaults and other chats cannot
  // supply a missing model or effort while the new native Composer is disabled.
  const model = settings?.model ?? input?.model
  const reasoningEffort = settings?.reasoning_effort ?? input?.reasoningEffort ?? input?.thinking
  if (!identifier(model) || !isModelReasoningEffort(reasoningEffort)) return undefined
  const token = record(input?.configOverrides)?.['cordisx.operation_token']
    ?? record(input?.config)?.['cordisx.operation_token']
  return {
    selection: { clientThreadId, model, reasoningEffort },
    ...(typeof token === 'string' && token.length >= 16 && token.length <= 256 && !/[\0\r\n]/u.test(token)
      ? { operationToken: token }
      : {}),
  }
}

function conversationOwner(composer: HTMLElement | undefined): ReactFiber | undefined {
  if (!composer?.isConnected) return undefined
  let fiber = currentFiber(composer)
  for (let depth = 0; fiber && depth < 64; depth++, fiber = fiber.return ?? undefined) {
    const props = record(fiber.memoizedProps)
    if (props && Object.hasOwn(props, 'pendingClientThreadId') && Object.hasOwn(props, 'conversationId')) {
      return fiber
    }
  }
  return undefined
}

/** A native creation shell can mount before its captured request is attached. */
export function nativeComposerCreationPending(composer: HTMLElement | undefined): boolean {
  const props = record(conversationOwner(composer)?.memoizedProps)
  return props?.hostId === 'local' && props.conversationId == null && props.isConversationStartFailed !== true
}

/** The committed native client route, including its explicit pending-to-real relationship. */
export function locateNativeComposerCreationRoute(
  composer: HTMLElement | undefined,
): NativeComposerCreationRoute | undefined {
  let owner = conversationOwner(composer)
  const props = record(owner?.memoizedProps)
  if (!props || props.hostId !== 'local' || props.isConversationStartFailed === true) return undefined
  const threadId = identifier(props.conversationId) ? props.conversationId : undefined
  if (identifier(props.pendingClientThreadId) && threadId === undefined) {
    const nativeIds = new Set(
      [...composer!.querySelectorAll('[data-above-composer-conversation-id]')]
        .filter(element => element.closest('[data-codex-composer-root]') === composer)
        .map(element => element.getAttribute('data-above-composer-conversation-id'))
        .filter(identifier),
    )
    if (nativeIds.size > 1) return undefined
    const committed = [...nativeIds][0]
    return { clientThreadId: props.pendingClientThreadId, ...(committed === undefined ? {} : { threadId: committed }) }
  }
  for (let depth = 0; owner && depth < 24; depth++, owner = owner.return ?? undefined) {
    const route = record(owner.memoizedProps)
    if (depth > 0 && route && Object.hasOwn(route, 'pendingClientThreadId')) return undefined
    if (!identifier(route?.clientThreadId) || !route.clientThreadId.startsWith('client-new-thread:')) continue
    if (Object.hasOwn(route, 'conversationId') && (route.conversationId ?? null) !== (props.conversationId ?? null)) {
      return undefined
    }
    return { clientThreadId: route.clientThreadId, ...(threadId === undefined ? {} : { threadId }) }
  }
  return undefined
}

/** Display-only selection from the pending native conversation that owns this Composer. */
export function locateNativeComposerCreationSelection(
  composer: HTMLElement | undefined,
): NativeComposerCreationSelection | undefined {
  return locateNativeComposerCreationInput(composer)?.selection
}

export function locateNativeComposerCreationInput(
  composer: HTMLElement | undefined,
): NativeComposerCreationInput | undefined {
  const owner = conversationOwner(composer)
  const props = record(owner?.memoizedProps)
  const route = locateNativeComposerCreationRoute(composer)
  // Never search through a settled, failed or unrelated conversation owner.
  if (!owner || !props || !route || props.conversationId != null) return undefined
  const { clientThreadId } = route
  const hostId = 'local'
  const stack = owner.child ? [{ fiber: owner.child, depth: 0 }] : []
  const visited = new Set<ReactFiber>()
  const selections = new Map<string, NativeComposerCreationInput>()
  while (stack.length > 0) {
    if (visited.size >= 1024) return undefined
    const { fiber, depth } = stack.pop()!
    if (visited.has(fiber)) continue
    visited.add(fiber)
    const props = record(fiber.memoizedProps)
    if (props) {
      const worktree = record(props.pendingWorktree)
      const pending = worktree ?? record(props.pendingThreadStart) ?? record(props.submittedThreadStart)
      if (pending?.clientThreadId === clientThreadId && pending.hostId === hostId) {
        if (props.isConversationStartFailed === true || pending.phase === 'failed' || pending.status === 'failed') {
          return undefined
        }
        const selection = creationSelection(pending, clientThreadId, hostId, worktree !== undefined)
        if (selection) selections.set(JSON.stringify(selection), selection)
      }
    }
    if (fiber.sibling) stack.push({ fiber: fiber.sibling, depth })
    if (fiber.child && depth < 48) stack.push({ fiber: fiber.child, depth: depth + 1 })
  }
  return selections.size === 1 ? [...selections.values()][0] : undefined
}
