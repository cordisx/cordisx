export function attachNativeCreation(
  composer: HTMLElement,
  options: { clientThreadId?: string; model?: string; effort?: string; phase?: string; operationToken?: string } = {},
) {
  const clientThreadId = options.clientThreadId ?? 'own-client-thread'
  const pending = {
    id: 'own-worktree',
    clientThreadId,
    hostId: 'local',
    launchMode: 'start-conversation',
    phase: options.phase ?? 'setting-up',
    startConversationParamsInput: {
      model: null,
      reasoningEffort: null,
      collaborationMode: {
        mode: 'default',
        settings: { model: options.model ?? 'model-b', reasoning_effort: options.effort ?? 'low' },
      },
      config: { model: 'model-a', model_reasoning_effort: 'high' },
      ...(options.operationToken === undefined ? {} : {
        configOverrides: { 'cordisx.operation_token': options.operationToken },
      }),
    },
  }
  const progress = { memoizedProps: { pendingWorktree: pending } }
  const fiber = { memoizedProps: {}, return: undefined as unknown, sibling: progress }
  const owner = {
    memoizedProps: { conversationId: null, hostId: 'local', pendingClientThreadId: clientThreadId },
    child: fiber,
  }
  fiber.return = owner
  Object.defineProperty(composer, '__reactFiber$creation', { configurable: true, value: fiber })
  return { pending, owner, progress, fiber }
}

/** Native committed client route persists above the replacement Composer. */
export function attachNativeCreatedRoute(composer: HTMLElement, clientThreadId: string, threadId: string) {
  const route = { memoizedProps: { clientThreadId, conversationId: threadId, hostId: 'local' } }
  const owner = {
    memoizedProps: { conversationId: threadId, pendingClientThreadId: null, hostId: 'local' },
    return: route,
  }
  const fiber = { memoizedProps: {}, return: owner }
  Object.defineProperty(composer, '__reactFiber$creation', { configurable: true, value: fiber })
  return { owner, route, fiber }
}
