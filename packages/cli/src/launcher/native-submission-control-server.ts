import { bindDiagnostic, diagnosticError } from '../diagnostics/context.js'
import { projectDiagnostic } from '../diagnostics/journal.js'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { NativeExistingThreadSwitch, NativeSubmissionController } from './native-submission-controller.js'
import { NativeAgentModelSelectionRejected } from './native-agent-models.js'
import type { NativeAgentTaskRouting } from './native-agent-task-routing.js'
import { NativeThreadSwitchError } from './native-thread-switch-error.js'
import { bindProfileLogicalFences } from './profile-logical-fence-projection.js'
import type { ProfileLogicalConversationOwner } from './profile-logical-conversation-owner.js'
import type { DesktopLogicalTurnAuthority } from './desktop-logical-turn-authority.js'
import { callLogicalHistory, unavailableLogicalHistory } from './desktop-logical-turn-rpc.js'
import { nativeMarkedRequestRpc } from './native-marked-request-rpc.js'
import type { ChatExecutionPreferences } from './chat-execution-preferences.js'
import type { NativeManagedModelListRequest } from './native-managed-model-list.js'
import { createDesktopLogicalHandoffControl } from './desktop-logical-handoff-control.js'
import type { ChannelLogicalHandoffPermits } from './channel-logical-handoff-permits.js'
import { MAX_LINE, processId, record, rejectionReason, requestId, TIMEOUT, valid } from './native-control-validation.js'

// Requests stay small; authenticated native responses may contain history.
export type NativeBridgeMethod =
  | 'model/list'
  | 'thread/list'
  | 'thread/read'
  | 'thread/turns/list'
  | 'thread/settings/update'
  | 'thread/items/list'
  | 'thread/start'
  | 'thread/fork'
  | 'thread/resume'
  | 'thread/name/set'
  | 'thread/metadata/update'
  | 'turn/start'
  | 'turn/steer'
  | 'turn/interrupt'
  | 'threadSection/list'
  | 'threadSection/create'
  | 'thread/section/move'

export interface NativeSubmissionControlServer {
  readonly socketPath: string
  readonly nonce: string
  readonly existingThread: NativeExistingThreadSwitch
  switchAgentThread(
    input: Readonly<{
      threadId: string
      providerId: string
      model: string
      configOverrides: Readonly<Record<string, unknown>>
    }>,
  ): Promise<void>
  isThreadIdle(threadId: string): Promise<boolean>
  acquireLogicalFence(threadId: string): Promise<string | undefined>
  releaseLogicalFence(threadId: string, lease: string): Promise<boolean>
  restoreLogicalFences(revision: number, sources: readonly string[]): Promise<boolean>
  bindLogicalFenceOwner(owner: ProfileLogicalConversationOwner): void
  bindLogicalHandoffPermits(permits: ChannelLogicalHandoffPermits): void
  logicalHandoffReady(): boolean
  createFencedLogicalDestination(
    method: 'thread/start' | 'thread/fork',
    params: Readonly<Record<string, unknown>>,
    sourceThreadId: string,
    logicalFenceLease: string,
    configuredProviderOverrides?: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<{ result: unknown; destinationLease: string }>>
  /** One allowlisted method on the desktop's own app-server; see `native-app-server-protocol.mjs`. */
  nativeRequest(
    method: NativeBridgeMethod,
    params: Readonly<Record<string, unknown>>,
    configuredProviderOverrides?: Readonly<Record<string, unknown>>,
    logicalFenceLease?: string,
  ): Promise<unknown>
  /** An opaque digest only; native account records do not cross this bridge. */
  nativeOwnerIdentity(): Promise<string | undefined>
  bindSourceConfigurationReader(
    read: (
      threadId: string,
    ) => Promise<import('./native-source-configuration.js').NativeSourceConfiguration | undefined>,
  ): void
  bindConfiguredProvider(prepare: (providerId?: string) => Promise<Readonly<Record<string, unknown>>>): void
  bindManagedModelList(read: (input: NativeManagedModelListRequest) => Promise<unknown | undefined>): void
  bindUnmarkedProviderGuard(guard: (input: { threadId?: string; providerId?: string }) => Promise<boolean>): void
  bindController(controller: NativeSubmissionController): void
  bindTaskRouting(routing: NativeAgentTaskRouting): void
  bindChatExecution(preferences: ChatExecutionPreferences): void
  bindLogicalHistory(handler: (params: unknown) => Promise<unknown>): void
  bindLogicalTurns(authority: DesktopLogicalTurnAuthority): void
  subscribeNativeApprovals(listener: (event: Record<string, unknown>) => void): () => void
  subscribeContinuationEvents(listener: (method: string, params: unknown) => void): () => void
  respondNativeApproval(input: Record<string, unknown>): Promise<unknown>
  invokeCodexTool(
    input: {
      tool: string
      sourceThreadId: string
      sourceTurnId?: string | undefined
      arguments: Record<string, unknown>
    },
  ): Promise<unknown>
  invokeTask(
    input: { callId: string; sourceThreadId: string; sourceTurnId: string; arguments: Record<string, unknown> },
  ): Promise<unknown>
  close(): Promise<void>
}

/** Private launch-scoped transport. No renderer-supplied scope crosses this boundary. */
export async function startNativeSubmissionControlServer(
  options: { readonly requestTimeoutMs?: number; readonly requireLogicalFences?: boolean } = {},
): Promise<NativeSubmissionControlServer> {
  const diagnostic = bindDiagnostic()
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'cx-native-'))
  const socketPath = path.join(directory, 'control.sock')
  const nonce = randomBytes(32).toString('hex')
  let peer: Socket | undefined
  let authenticated = false
  let peerReady = false
  let logicalFenceOwner: ProfileLogicalConversationOwner | undefined
  let handoffPermits: ChannelLogicalHandoffPermits | undefined
  const handoff = createDesktopLogicalHandoffControl({
    owner: () => logicalFenceOwner,
    permits: () => handoffPermits,
  })
  let fenceBarrierInstalled = false
  let supplyLogicalOwner: ((owner: ProfileLogicalConversationOwner) => void) | undefined
  const logicalOwnerReady = new Promise<ProfileLogicalConversationOwner>(resolve => {
    supplyLogicalOwner = resolve
  })
  let sourceConfiguration:
    | ((threadId: string) => Promise<import('./native-source-configuration.js').NativeSourceConfiguration | undefined>)
    | undefined
  let prepareConfigured: ((providerId?: string) => Promise<Readonly<Record<string, unknown>>>) | undefined
  let readManagedModelList: ((input: NativeManagedModelListRequest) => Promise<unknown | undefined>) | undefined
  let unmarkedGuard: ((input: { threadId?: string; providerId?: string }) => Promise<boolean>) | undefined
  let controller: NativeSubmissionController | undefined
  let taskRouting: NativeAgentTaskRouting | undefined
  let chatExecution: ChatExecutionPreferences | undefined
  let logicalHistory: ((params: unknown) => Promise<unknown>) | undefined
  let logicalTurns: DesktopLogicalTurnAuthority | undefined
  const approvalListeners = new Set<(event: Record<string, unknown>) => void>()
  const continuationListeners = new Set<(method: string, params: unknown) => void>()
  let closed = false
  let closePromise: Promise<void> | undefined
  // Retire only timed-out IDs; a late response cannot resolve a new request.
  const expiredIds = new Set<string>()
  const rememberExpired = (id: string): void => {
    expiredIds.add(id)
    if (expiredIds.size > 128) expiredIds.delete(expiredIds.values().next().value!)
  }
  const pending = new Map<
    string,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      timer: NodeJS.Timeout
      restoration?: Readonly<{ threadId: string; revalidate?: () => Promise<boolean> }>
      taskCreation?: boolean
    }
  >()
  const switchResumes = new Map<string, Readonly<{ switchId: string; threadId: string }>>()
  const retireSwitchResumes = (switchId?: string): void => {
    for (const [resumeToken, resume] of switchResumes) {
      if (switchId !== undefined && resume.switchId !== switchId) continue
      switchResumes.delete(resumeToken)
      void controller?.completeThreadResume({
        threadId: resume.threadId,
        resumeToken,
        succeeded: false,
      }).catch(() => undefined)
    }
  }
  const write = (socket: Socket, value: unknown): Promise<void> =>
    new Promise((resolve, reject) => {
      if (socket.destroyed) {
        reject(new Error('Native intermediary unavailable'))
        return
      }
      socket.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve())
    })
  const failPending = (): void => {
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(
        item.restoration
          ? new NativeThreadSwitchError('provider-switch-reconciliation-required')
          : new Error('Native intermediary disconnected'),
      )
    }
    pending.clear()
    retireSwitchResumes()
  }
  const callPeer = async (
    request: Record<string, unknown>,
    restoration?: Readonly<{ threadId: string; revalidate?: () => Promise<boolean> }>,
  ): Promise<unknown> => {
    const socket = peer
    if (
      closed || !authenticated || !peerReady && request.type !== 'logical-fence-restore'
      || socket === undefined || pending.size >= 32
    ) {
      throw new Error('Native intermediary unavailable')
    }
    const id = randomUUID()
    return await new Promise<unknown>((resolve, reject) => {
      const fail = (error: Error): void => {
        const item = pending.get(id)
        if (!item) return
        pending.delete(id)
        clearTimeout(item.timer)
        retireSwitchResumes(id)
        if (request.type === 'switch' || request.type === 'continuation-fork') {
          void write(socket, { type: 'switch-cancel', switchId: id, threadId: request.threadId }).catch(() => undefined)
        }
        reject(
          request.type === 'switch' || request.type === 'continuation-fork'
            ? new NativeThreadSwitchError('provider-switch-reconciliation-required')
            : error,
        )
      }
      const timer = setTimeout(() => {
        rememberExpired(id)
        fail(new Error('Native switch timed out'))
      }, options.requestTimeoutMs ?? TIMEOUT)
      pending.set(id, {
        resolve,
        reject,
        timer,
        ...(restoration ? { restoration } : {}),
        ...(request.type === 'task-create' ? { taskCreation: true } : {}),
      })
      void write(socket, { ...request, id }).catch(fail)
    })
  }
  const existingThread: NativeExistingThreadSwitch = {
    async switch(input) {
      await callPeer({
        type: 'switch',
        threadId: input.threadId,
        providerId: input.providerId,
        model: input.model,
        config: input.configOverrides,
      }, {
        threadId: input.threadId,
        ...(input.revalidateRestoration ? { revalidate: input.revalidateRestoration } : {}),
      })
    },
    async continue(input) {
      const result = record(
        await callPeer({
          type: 'continuation-fork',
          threadId: input.threadId,
          providerId: input.providerId,
          model: input.model,
          config: input.configOverrides,
          operationToken: input.operationToken,
        }, { threadId: input.threadId }),
      )
      if (!valid(result?.threadId) || result.threadId === input.threadId) {
        throw new NativeThreadSwitchError('provider-switch-reconciliation-required')
      }
      return { threadId: result.threadId }
    },
    async discardContinuation(input) {
      await callPeer({ type: 'continuation-discard', ...input })
    },
  }
  const server = createServer(socket => {
    const peerRef = randomUUID()
    if (closed || peer !== undefined) {
      diagnostic({
        event: 'native-control-peer-rejected',
        requestRef: peerRef,
        reason: closed ? 'disposed' : 'peer-already-connected',
      })
      socket.destroy()
      return
    }
    peer = socket
    diagnostic({ event: 'native-control-peer-connected', requestRef: peerRef })
    let fragments: string[] = []
    let fragmentBytes = 0
    let active = 0
    const activeIds = new Set<string>()
    const forkLeases = new Map<string, { threadId: string; timer: ReturnType<typeof setTimeout> }>()
    const authTimer = setTimeout(() => socket.destroy(), TIMEOUT)
    socket.setEncoding('utf8')
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      diagnostic({ event: 'native-control-peer-closed', requestRef: peerRef, verified: authenticated, aborted: closed })
      clearTimeout(authTimer)
      for (const [resumeToken, lease] of forkLeases) {
        clearTimeout(lease.timer)
        void controller?.completeThreadResume({ threadId: lease.threadId, resumeToken, succeeded: false }).catch(() =>
          undefined
        )
      }
      forkLeases.clear()
      if (peer === socket) {
        handoff.releaseAll()
        if (options.requireLogicalFences && fenceBarrierInstalled) logicalFenceOwner?.store.pauseCommitBarrier()
        if (authenticated) {
          logicalTurns?.clear()
          for (const listener of continuationListeners) {
            try {
              listener('cordisx/connection/closed', {})
            } catch {}
          }
        }
        peer = undefined
        authenticated = false
        peerReady = false
        failPending()
      }
    })
    const handle = async (value: Record<string, unknown>): Promise<void> => {
      if (value.type === 'continuation-event') {
        if (!authenticated || !valid(value.method)) throw new Error('Control unavailable')
        logicalTurns?.observe(value.method, value.params)
        for (const listener of continuationListeners) {
          try {
            listener(value.method, value.params)
          } catch {}
        }
        return
      }
      if (value.type === 'execution-observed') {
        if (!authenticated || !valid(value.threadId)) throw new Error('Control unavailable')
        await chatExecution?.observe(value.threadId, value.settings)
        return
      }
      if (value.type === 'execution-persistence-failed') {
        if (!authenticated) throw new Error('Control unavailable')
        diagnostic({
          event: 'chat-execution-persistence-failed',
          accepted: value.accepted === true,
          serviceRef: peerRef,
        })
        return
      }
      if (value.type === 'native-approval-event') {
        if (
          !authenticated || !['requested', 'resolved', 'answered', 'cancelled', 'unknown'].includes(String(value.event))
        ) {
          throw new Error('Control unavailable')
        }
        for (const listener of approvalListeners) {
          try {
            listener(value)
          } catch {}
        }
        return
      }
      if (!valid(value.id, 256) || activeIds.has(value.id)) throw new Error('Invalid control id')
      if (typeof value.ok === 'boolean') {
        if (!authenticated) throw new Error('Unauthenticated response')
        const item = pending.get(value.id)
        if (!item) {
          if (expiredIds.has(value.id)) return
          throw new Error('Unknown control response')
        }
        pending.delete(value.id)
        clearTimeout(item.timer)
        retireSwitchResumes(value.id)
        value.ok
          ? item.resolve(value.value)
          : item.reject(
            value.reason === 'provider-switch-unsupported' || value.reason === 'provider-switch-reconciliation-required'
              ? new NativeThreadSwitchError(value.reason)
              : item.taskCreation && value.reason === 'native-source-thread-not-loaded'
              ? Object.assign(new Error('Native source thread not loaded'), {
                code: 'NATIVE_TASK_SOURCE_THREAD_NOT_LOADED',
              })
              : new Error('Native switch rejected'),
          )
        return
      }
      if (value.type === 'logical-history') {
        if (!authenticated) throw new Error('Control unavailable')
        if (active >= 32) {
          await write(socket, { id: value.id, ok: true, value: unavailableLogicalHistory() })
          return
        }
        active++
        activeIds.add(value.id)
        try {
          const result = await callLogicalHistory(logicalHistory, value.params)
          await write(socket, { id: value.id, ok: true, value: result })
        } finally {
          active--
          activeIds.delete(value.id)
        }
        return
      }
      if (
        ['logical-handoff-status', 'logical-handoff-authorize', 'logical-handoff-release'].includes(String(value.type))
      ) {
        if (!authenticated || !peerReady || !options.requireLogicalFences || active >= 32) {
          throw new Error('Control unavailable')
        }
        active++
        activeIds.add(value.id)
        try {
          const result = await handoff.handle(
            value,
            () => peer === socket && authenticated && peerReady && !socket.destroyed,
          )
          await write(socket, { id: value.id, ok: true, value: result })
        } finally {
          active--
          activeIds.delete(value.id)
        }
        return
      }
      if (value.type === 'switch-resume' || value.type === 'switch-resume-complete') {
        if (
          !authenticated || !controller || active >= 32 || !valid(value.switchId, 256)
          || !valid(value.threadId) || !valid(value.providerId, 128) || !valid(value.model)
        ) throw new Error('Control unavailable')
        const item = pending.get(value.switchId)
        const current = async (): Promise<boolean> => {
          const restoration = item?.restoration
          if (!restoration || restoration.threadId !== value.threadId) return false
          const valid = await restoration.revalidate?.() ?? true
          return valid && !closed && pending.get(value.switchId as string) === item
        }
        active++
        activeIds.add(value.id)
        try {
          if (value.type === 'switch-resume-complete') {
            let accepted = await current() && value.succeeded === true
            if (value.providerId !== 'openai') {
              if (!valid(value.resumeToken, 256)) throw new Error('Invalid native thread resume completion')
              const resume = switchResumes.get(value.resumeToken)
              if (resume?.switchId !== value.switchId || resume.threadId !== value.threadId) {
                throw new Error('Invalid native thread resume completion')
              }
              switchResumes.delete(value.resumeToken)
              accepted = await controller.completeThreadResume({
                threadId: value.threadId,
                resumeToken: value.resumeToken,
                succeeded: accepted,
              }) && accepted
            }
            accepted = accepted && await current()
            await write(socket, { id: value.id, ok: true, value: accepted })
          } else {
            if (!await current()) throw new Error('Native restoration was stale')
            const result = value.providerId === 'openai'
              ? { kind: 'native', configOverrides: { model_provider: 'openai', model: value.model } }
              : await controller.prepareThreadResume({
                threadId: value.threadId,
                providerId: value.providerId,
                model: value.model,
              })
            if ('resumeToken' in result) {
              if (!await current()) {
                await controller.completeThreadResume({
                  threadId: value.threadId,
                  resumeToken: result.resumeToken,
                  succeeded: false,
                })
                throw new Error('Native restoration was stale')
              }
              switchResumes.set(result.resumeToken, { switchId: value.switchId, threadId: value.threadId })
            }
            await write(socket, { id: value.id, ok: true, value: result })
          }
        } catch {
          await write(socket, { id: value.id, ok: false })
        } finally {
          active--
          activeIds.delete(value.id)
        }
        return
      }
      if (value.type === 'diagnostic') {
        if (!authenticated) throw new Error('Unauthenticated diagnostic')
        if (typeof value.event === 'string' && /^model-[a-z-]{1,40}$/u.test(value.event)) {
          diagnostic({ ...projectDiagnostic(value as { event: string }), event: value.event, serviceRef: peerRef })
        }
        return
      }
      if (value.type === 'execution-prepare' || value.type === 'execution-complete') {
        if (!authenticated || active >= 32) throw new Error('Control unavailable')
        active++
        activeIds.add(value.id)
        try {
          if (value.type === 'execution-prepare') {
            if (!['thread/start', 'thread/resume', 'turn/start'].includes(String(value.method))) {
              throw new Error('Invalid native method')
            }
            const params = record(value.params) ?? {}
            const prepared = await chatExecution?.prepare(String(value.method), params, record(value.context))
            await write(socket, {
              id: value.id,
              ok: true,
              value: prepared
                ? {
                  fields: prepared.params,
                  captureId: prepared.captureId,
                  contextRequired: prepared.contextRequired === true,
                }
                : { fields: {} },
            })
          } else {
            if (!valid(value.captureId) || typeof value.accepted !== 'boolean') {
              throw new Error('Invalid execution completion')
            }
            await chatExecution?.complete(value.captureId, value.accepted, value.result)
            await write(socket, { id: value.id, ok: true })
          }
        } catch {
          await write(socket, { id: value.id, ok: false })
        } finally {
          active--
          activeIds.delete(value.id)
        }
        return
      }
      if (value.type === 'unmarked-provider') {
        if (
          !authenticated || active >= 32 || (value.threadId !== undefined && !valid(value.threadId))
          || (value.providerId !== undefined && !valid(value.providerId, 128))
        ) throw new Error('Control unavailable')
        active++
        activeIds.add(value.id)
        try {
          const allowed = await unmarkedGuard?.({
            ...(typeof value.threadId === 'string' ? { threadId: value.threadId } : {}),
            ...(typeof value.providerId === 'string' ? { providerId: value.providerId } : {}),
          }) ?? true
          await write(socket, { id: value.id, ok: true, value: allowed })
        } catch {
          await write(socket, { id: value.id, ok: true, value: false })
        } finally {
          active--
          activeIds.delete(value.id)
        }
        return
      }
      if (value.type === 'fork-prepare' || value.type === 'fork-complete') {
        if (!authenticated || !controller || active >= 32 || !valid(value.threadId)) {
          throw new Error('Control unavailable')
        }
        active++
        activeIds.add(value.id)
        try {
          if (value.type === 'fork-prepare') {
            if (forkLeases.size >= 64 || !valid(value.providerId, 128) || !valid(value.model)) {
              throw new Error('Invalid native thread')
            }
            const prepared = await controller.prepareThreadResume({
              threadId: value.threadId,
              providerId: value.providerId,
              model: value.model,
            })
            if (prepared.kind === 'resume') {
              if (peer !== socket || !authenticated) {
                await controller.completeThreadResume({
                  threadId: value.threadId,
                  resumeToken: prepared.resumeToken,
                  succeeded: false,
                })
                return
              }
              const resumeToken = prepared.resumeToken, threadId = value.threadId
              const timer = setTimeout(() => {
                forkLeases.delete(resumeToken)
                void controller?.completeThreadResume({ threadId, resumeToken, succeeded: false }).catch(() =>
                  undefined
                )
              }, 65_000)
              forkLeases.set(resumeToken, { threadId, timer })
            }
            await write(socket, { id: value.id, ok: true, value: prepared })
          } else {
            if (
              !valid(value.resumeToken, 256) || forkLeases.get(value.resumeToken)?.threadId !== value.threadId
              || typeof value.succeeded !== 'boolean'
              || value.succeeded && (!valid(value.createdThreadId) || value.createdThreadId === value.threadId)
            ) {
              throw new Error('Invalid native thread resume completion')
            }
            clearTimeout(forkLeases.get(value.resumeToken)!.timer)
            forkLeases.delete(value.resumeToken)
            const result = await controller.completeThreadResume({
              threadId: value.threadId,
              resumeToken: value.resumeToken,
              succeeded: value.succeeded,
              ...(value.succeeded && typeof value.createdThreadId === 'string'
                ? { createdThreadId: value.createdThreadId }
                : {}),
            })
            await write(socket, { id: value.id, ok: true, value: result })
          }
        } catch {
          await write(socket, { id: value.id, ok: false }).catch(() => undefined)
        } finally {
          active--
          activeIds.delete(value.id)
        }
        return
      }
      if (value.type === 'source-configuration') {
        if (!authenticated || active >= 32 || !valid(value.threadId)) throw new Error('Control unavailable')
        active++
        activeIds.add(value.id)
        try {
          const tuple = await sourceConfiguration?.(value.threadId)
          await write(socket, { id: value.id, ok: true, value: tuple ?? null })
        } catch {
          await write(socket, { id: value.id, ok: true, value: null })
        } finally {
          active--
          activeIds.delete(value.id)
        }
        return
      }
      if (value.type === 'configured-provider') {
        if (!authenticated || active >= 32 || (value.providerId !== undefined && !valid(value.providerId, 128))) {
          throw new Error('Configured provider unavailable')
        }
        active++
        activeIds.add(value.id)
        try {
          const overrides =
            await prepareConfigured?.(typeof value.providerId === 'string' ? value.providerId : undefined) ?? {}
          await write(socket, { id: value.id, ok: true, value: overrides })
        } catch {
          await write(socket, { id: value.id, ok: false })
        } finally {
          active--
          activeIds.delete(value.id)
        }
        return
      }
      if (value.type === 'managed-model-list') {
        if (
          !authenticated || active >= 32 || !valid(value.providerId, 128)
          || (value.limit != null && (!Number.isSafeInteger(value.limit) || Number(value.limit) < 1))
          || (value.cursor != null && !valid(value.cursor, 256))
          || (value.includeHidden != null && typeof value.includeHidden !== 'boolean')
        ) throw new Error('Control unavailable')
        active++
        activeIds.add(value.id)
        try {
          const result = await readManagedModelList?.({
            providerId: value.providerId,
            ...(typeof value.limit === 'number' ? { limit: value.limit } : {}),
            ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}),
            ...(typeof value.includeHidden === 'boolean' ? { includeHidden: value.includeHidden } : {}),
          })
          await write(socket, { id: value.id, ok: true, value: result ?? null })
        } catch {
          await write(socket, { id: value.id, ok: true, value: null })
        } finally {
          active--
          activeIds.delete(value.id)
        }
        return
      }
      if (value.type === 'hello') {
        if (authenticated || value.nonce !== nonce) throw new Error('Invalid control authentication')
        authenticated = true
        diagnostic({
          event: 'native-control-peer-authenticated',
          requestRef: peerRef,
          sourcePid: processId(value.sourcePid),
          parentPid: processId(value.parentPid),
          method: value.method === 'app-server-stdio' ? value.method : 'unknown',
        })
        if (options.requireLogicalFences) {
          const owner = logicalFenceOwner ?? await logicalOwnerReady
          const restore = async (revision: number, sources: readonly string[]) =>
            await callPeer({ type: 'logical-fence-restore', revision, sources }) === true
          const readyPeer = () => {
            if (peer !== socket || !authenticated || socket.destroyed) throw new Error('Native peer unavailable')
            peerReady = true
          }
          if (!fenceBarrierInstalled) {
            await bindProfileLogicalFences(owner, { restoreLogicalFences: restore }, readyPeer)
            fenceBarrierInstalled = true
          } else {
            await owner.store.resumeCommitBarrier(readyPeer)
          }
        }
        peerReady = true
        clearTimeout(authTimer)
        await write(socket, {
          id: value.id,
          ok: true,
          value: { version: 1, logicalHandoffGuard: !!options.requireLogicalFences },
        })
        return
      }
      if (value.type === 'resume' || value.type === 'managed-resume' || value.type === 'resume-complete') {
        // Thread resumes carry no Send token: the intermediary reports only what the app-server persisted.
        if (!authenticated || !controller || active >= 32 || !valid(value.threadId)) {
          throw new Error('Control unavailable')
        }
        active++
        activeIds.add(value.id)
        try {
          if (value.type === 'resume-complete') {
            if (
              !valid(value.resumeToken, 256) || value.resumeToken.length < 16 || typeof value.succeeded !== 'boolean'
            ) {
              throw new Error('Invalid native thread resume completion')
            }
            const result = await controller.completeThreadResume({
              threadId: value.threadId,
              resumeToken: value.resumeToken,
              succeeded: value.succeeded,
            })
            await write(socket, { id: value.id, ok: true, value: result })
          } else if (valid(value.providerId, 128) && valid(value.model)) {
            const result = await controller.prepareThreadResume({
              threadId: value.threadId,
              providerId: value.providerId,
              model: value.model,
              ...(value.type === 'managed-resume' ? { managedOnly: true } : {}),
            })
            await write(socket, { id: value.id, ok: true, value: result })
          } else throw new Error('Invalid native thread resume')
        } catch {
          await write(socket, { id: value.id, ok: false })
        } finally {
          active--
          activeIds.delete(value.id)
        }
        return
      }
      if (!authenticated || !controller || active >= 32 || !valid(value.token, 256) || value.token.length < 16) {
        throw new Error('Control unavailable')
      }
      if (value.threadId !== undefined && !valid(value.threadId)) throw new Error('Invalid native thread')
      if (!requestId(value.requestId)) throw new Error('Invalid native request id')
      active++
      activeIds.add(value.id)
      try {
        const result = await nativeMarkedRequestRpc(
          { ...value, token: value.token, requestId: value.requestId },
          controller,
          taskRouting,
          logicalTurns,
        )
        await write(socket, { id: value.id, ok: true, ...(result === undefined ? {} : { value: result }) })
      } catch {
        await write(socket, { id: value.id, ok: false })
      } finally {
        active--
        activeIds.delete(value.id)
      }
    }
    socket.on('data', (chunk: string) => {
      let start = 0
      for (;;) {
        const newline = chunk.indexOf('\n', start)
        const fragment = chunk.slice(start, newline < 0 ? undefined : newline)
        fragmentBytes += Buffer.byteLength(fragment)
        if (!authenticated && fragmentBytes > MAX_LINE) {
          diagnostic({
            event: 'native-control-frame-rejected',
            phase: 'request-frame-limit',
            bytes: fragmentBytes,
            count: MAX_LINE,
            verified: authenticated,
          })
          socket.destroy()
          return
        }
        if (fragment.length > 0) fragments.push(fragment)
        if (newline < 0) return
        const line = fragments.join('')
        const lineBytes = fragmentBytes
        fragments = []
        fragmentBytes = 0
        start = newline + 1
        try {
          const value = record(JSON.parse(line))
          if (!value) throw new Error('Invalid control envelope')
          // Only an authenticated reply to an outstanding request may be large.
          // Commands and diagnostics retain 256 KiB; model data has no byte cap.
          if (
            lineBytes > MAX_LINE
            && (!authenticated || typeof value.ok !== 'boolean' || !valid(value.id, 256)
              || (!pending.has(value.id) && !expiredIds.has(value.id)))
          ) {
            throw new Error('Invalid oversized control envelope')
          }
          void handle(value).catch(error => {
            diagnostic({
              event: 'native-control-message-rejected',
              requestRef: peerRef,
              reason: rejectionReason(error),
              phase: typeof value.type === 'string'
                  && ['hello', 'diagnostic', 'resume', 'resume-complete', 'consume', 'authorize', 'complete'].includes(
                    value.type,
                  )
                ? value.type
                : 'unknown',
              verified: authenticated,
              ready: controller !== undefined,
              ...diagnosticError(error),
            })
            socket.destroy()
          })
        } catch {
          socket.destroy()
          return
        }
      }
    })
  })
  try {
    await chmod(directory, 0o700)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    await chmod(socketPath, 0o600)
  } catch (error) {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return Object.freeze({
    socketPath,
    nonce,
    existingThread,
    bindLogicalFenceOwner(owner: ProfileLogicalConversationOwner) {
      if (!options.requireLogicalFences || logicalFenceOwner) throw new Error('Logical fence owner unavailable')
      logicalFenceOwner = owner
      owner.bindRecoveryProbe(async sources => await callPeer({ type: 'logical-fence-can-abandon', sources }) === true)
      supplyLogicalOwner?.(owner)
      supplyLogicalOwner = undefined
    },
    bindLogicalHandoffPermits(permits: ChannelLogicalHandoffPermits) {
      if (!options.requireLogicalFences || handoffPermits) throw new Error('Logical handoff guard unavailable')
      handoffPermits = permits
    },
    logicalHandoffReady() {
      return !!options.requireLogicalFences && !!handoffPermits && peerReady
        && logicalFenceOwner?.store.hasCommitBarrier() === true
    },
    bindLogicalHistory(handler: (params: unknown) => Promise<unknown>) {
      if (logicalHistory) throw new Error('Logical history already bound')
      logicalHistory = handler
    },
    bindLogicalTurns(authority: DesktopLogicalTurnAuthority) {
      if (logicalTurns) throw new Error('Logical turn authority already bound')
      logicalTurns = authority
    },
    bindTaskRouting(value: NativeAgentTaskRouting) {
      if (taskRouting) throw new Error('Native task routing already bound')
      taskRouting = value
    },
    invokeCodexTool(
      input: {
        tool: string
        sourceThreadId: string
        sourceTurnId?: string | undefined
        arguments: Record<string, unknown>
      },
    ) {
      return callPeer({ type: 'codex-tool', ...input, callId: `cordisx-config-${randomUUID()}` })
    },
    async invokeTask(
      input: { callId: string; sourceThreadId: string; sourceTurnId: string; arguments: Record<string, unknown> },
    ) {
      return await callPeer({ type: 'task-create', ...input })
    },
    async switchAgentThread(
      input: Readonly<{
        threadId: string
        providerId: string
        model: string
        configOverrides: Readonly<Record<string, unknown>>
      }>,
    ) {
      const result = await callPeer({
        type: 'switch',
        requireIdle: true,
        threadId: input.threadId,
        providerId: input.providerId,
        model: input.model,
        config: input.configOverrides,
      }, { threadId: input.threadId })
      if (record(result)?.status === 'rejected') {
        throw new NativeAgentModelSelectionRejected('The target thread is not idle')
      }
    },
    async isThreadIdle(threadId: string) {
      return await callPeer({ type: 'idle', threadId }) === true
    },
    async acquireLogicalFence(threadId: string) {
      if (!valid(threadId)) throw new Error('Invalid native thread')
      const lease = await callPeer({ type: 'logical-fence-begin', threadId })
      return valid(lease, 256) ? lease : undefined
    },
    async releaseLogicalFence(threadId: string, lease: string) {
      if (!valid(threadId) || !valid(lease, 256)) throw new Error('Invalid native thread')
      return await callPeer({ type: 'logical-fence-release', threadId, lease }) === true
    },
    async restoreLogicalFences(revision: number, sources: readonly string[]) {
      if (
        !Number.isSafeInteger(revision) || revision < 0 || !Array.isArray(sources) || sources.length > 4096
        || sources.some(source => !valid(source)) || new Set(sources).size !== sources.length
      ) throw new Error('Invalid logical fence state')
      return await callPeer({ type: 'logical-fence-restore', revision, sources }) === true
    },
    async createFencedLogicalDestination(
      method: 'thread/start' | 'thread/fork',
      params: Readonly<Record<string, unknown>>,
      sourceThreadId: string,
      logicalFenceLease: string,
      configuredProviderOverrides?: Readonly<Record<string, unknown>>,
    ) {
      if (
        !['thread/start', 'thread/fork'].includes(method) || !valid(sourceThreadId)
        || !valid(logicalFenceLease, 256) || method === 'thread/fork' && params.threadId !== sourceThreadId
      ) throw new Error('Invalid native request')
      const value = record(
        await callPeer({
          type: 'native-create-fenced',
          method,
          params,
          configuredProviderOverrides,
          logicalFenceLease,
          logicalSourceThreadId: sourceThreadId,
        }),
      )
      if (!value || !valid(value.destinationLease, 256)) throw new Error('Native destination unavailable')
      return { result: value.result, destinationLease: value.destinationLease as string }
    },
    async nativeRequest(
      method: NativeBridgeMethod,
      params: Readonly<Record<string, unknown>>,
      configuredProviderOverrides?: Readonly<Record<string, unknown>>,
      logicalFenceLease?: string,
    ) {
      if (logicalFenceLease !== undefined && !valid(logicalFenceLease, 256)) throw new Error('Invalid native lease')
      return await callPeer({ type: 'native-request', method, params, configuredProviderOverrides, logicalFenceLease })
    },
    async nativeOwnerIdentity() {
      const value = await callPeer({ type: 'native-owner-identity' })
      return typeof value === 'string' && /^desktop:[a-f0-9]{64}$/u.test(value) ? value : undefined
    },
    bindChatExecution(value: ChatExecutionPreferences) {
      chatExecution = value
    },
    subscribeNativeApprovals(listener: (event: Record<string, unknown>) => void) {
      approvalListeners.add(listener)
      return () => approvalListeners.delete(listener)
    },
    subscribeContinuationEvents(listener: (method: string, params: unknown) => void) {
      continuationListeners.add(listener)
      return () => continuationListeners.delete(listener)
    },
    respondNativeApproval(input: Record<string, unknown>) {
      return callPeer({ ...input, type: 'native-approval-response' })
    },
    bindUnmarkedProviderGuard(value: (input: { threadId?: string; providerId?: string }) => Promise<boolean>) {
      unmarkedGuard = value
    },
    bindSourceConfigurationReader(value: NonNullable<typeof sourceConfiguration>) {
      if (sourceConfiguration) throw new Error('Source configuration reader already bound')
      sourceConfiguration = value
    },
    bindConfiguredProvider(value: (providerId?: string) => Promise<Readonly<Record<string, unknown>>>) {
      if (prepareConfigured) throw new Error('Configured provider already bound')
      prepareConfigured = value
    },
    bindManagedModelList(value: (input: NativeManagedModelListRequest) => Promise<unknown | undefined>) {
      if (readManagedModelList) throw new Error('Managed model list already bound')
      readManagedModelList = value
    },
    bindController(value: NativeSubmissionController) {
      if (controller) throw new Error('Native controller already bound')
      controller = value
    },
    async close() {
      closePromise ??= (async () => {
        closed = true
        handoff.releaseAll()
        approvalListeners.clear()
        failPending()
        expiredIds.clear()
        peer?.destroy()
        await new Promise<void>(resolve => server.close(() => resolve()))
        await rm(directory, { recursive: true, force: true })
      })()
      await closePromise
    },
  })
}
