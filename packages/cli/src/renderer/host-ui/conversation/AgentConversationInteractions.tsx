import * as React from 'react'
import { createPortal } from 'react-dom'
import { HostIcon } from '../HostIcon.js'
import type { HostNavigationCollectionAction } from '../NavigationCollectionActions.js'
import { HostNavigationCollectionActionController } from '../NavigationCollectionActions.js'
import { HostSurfaceIcon } from '../HostSurfaceIcon.js'
import { HostThemeProjection } from '../../host-theme.js'
import { HostAgentAvatar } from './AgentAvatar.js'
import type { HostAgentIdentityPresentation } from './AgentIdentityPanel.js'
import type { AgentConversationCommandController } from './commands.js'
import type { AgentConversationRendererCopy } from './AgentConversationRenderer.js'
import type {
  AgentConversationAction,
  AgentConversationApproval,
  AgentConversationMessage,
  AgentConversationModel,
} from './model.js'
import { participantFor } from './model.js'

export function ApprovalEntry(
  { entry, model, commands, copy, onCommandError, onOpenMention, onMentionParticipant, onOpenContextMenu }: {
    readonly entry: AgentConversationApproval
    readonly model: AgentConversationModel
    readonly commands: AgentConversationCommandController
    readonly copy: AgentConversationRendererCopy
    readonly onCommandError: (error: unknown) => void
    readonly onOpenMention: (participantId: string) => void
    readonly onMentionParticipant: (participantId: string) => void
    readonly onOpenContextMenu: (target: ConversationContextTarget) => void
  },
) {
  const participant = participantFor(model, entry.participantId)
  const chinese = copy.locale.toLowerCase().startsWith('zh')
  const articleRef = React.useRef<HTMLElement>(null)
  const approvalActionHadFocus = React.useRef(false)
  React.useLayoutEffect(() => {
    if (approvalActionHadFocus.current && entry.state !== 'pending') {
      articleRef.current?.focus({ preventScroll: true })
      approvalActionHadFocus.current = false
    }
  }, [entry.state])
  if (entry.requester !== undefined && participant !== undefined) {
    const authority = participantFor(model, entry.authority.participantId)
    const authorityName = authority?.name ?? entry.authority.identity.agentId
    const outcome = entry.state === 'approved'
      ? (chinese ? '已批准' : 'Approved')
      : entry.state === 'denied'
      ? (chinese ? '已拒绝' : 'Rejected')
      : entry.state === 'cancelled'
      ? (chinese ? '已取消' : 'Cancelled')
      : entry.state === 'failed'
      ? (chinese ? '审批失败' : 'Approval failed')
      : chinese
      ? '等待审批'
      : 'Approval pending'
    const target = chinese ? `由 ${authorityName} 审批` : `Approval by ${authorityName}`
    const openAvatarContext = (event: React.MouseEvent<HTMLButtonElement>): void => {
      event.preventDefault()
      event.stopPropagation()
      onOpenContextMenu({
        kind: 'avatar',
        x: event.clientX,
        y: event.clientY,
        participantId: participant.id,
        participantName: participant.name,
        participantRole: participant.role,
        restoreFocus: event.currentTarget,
      })
    }
    const keyboardAvatarContext = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      onOpenContextMenu({
        kind: 'avatar',
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        participantId: participant.id,
        participantName: participant.name,
        participantRole: participant.role,
        restoreFocus: event.currentTarget,
      })
    }
    const approvalContextTarget = (
      x: number,
      y: number,
      restoreFocus: HTMLElement,
    ): ConversationContextTarget => ({
      kind: 'message',
      x,
      y,
      participantId: participant.id,
      participantName: participant.name,
      participantRole: participant.role,
      restoreFocus,
      messageText: entry.reason.text,
    })
    const openApprovalContext = (event: React.MouseEvent<HTMLElement>): void => {
      event.preventDefault()
      event.stopPropagation()
      onOpenContextMenu(approvalContextTarget(event.clientX, event.clientY, event.currentTarget))
    }
    const keyboardApprovalContext = (event: React.KeyboardEvent<HTMLElement>): void => {
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
      event.preventDefault()
      event.stopPropagation()
      const rect = event.currentTarget.getBoundingClientRect()
      onOpenContextMenu(approvalContextTarget(
        rect.left + Math.min(24, rect.width / 2),
        rect.top + Math.min(24, rect.height / 2),
        event.currentTarget,
      ))
    }
    const copyApprovalReason = (event: React.MouseEvent<HTMLButtonElement>): void => {
      const clipboard = event.currentTarget.ownerDocument.defaultView?.navigator.clipboard
      if (clipboard === undefined) {
        onCommandError(new Error(chinese ? '当前环境不支持复制。' : 'Copy is unavailable in this environment.'))
        return
      }
      void clipboard.writeText(entry.reason.text).catch(onCommandError)
    }
    return (
      <article
        ref={articleRef}
        className="cxa-entry cxa-approval-message"
        data-entry-id={entry.itemId}
        data-role="agent"
        data-state={entry.state}
        data-selected-outcome={entry.state === 'pending' ? undefined : entry.state}
        role="group"
        tabIndex={-1}
        aria-label={`${participant.name}: ${target}, ${outcome}`}
      >
        <div className="cxa-approval-message-content">
          <div className="cxa-message-meta">
            <button
              type="button"
              className="cxa-author cxa-author-button"
              aria-label={chinese ? `@提及 ${participant.name}` : `Mention @${participant.name}`}
              onClick={() => onMentionParticipant(participant.id)}
            >
              {participant.name}
            </button>
          </div>
          <div className="cxa-approval-card-row">
            <span className="cxa-approval-avatar-seat" data-avatar-seat="visible">
              <button
                type="button"
                className="cx-agent-identity-avatar-button"
                aria-label={chinese ? `查看 ${participant.name}` : `Open ${participant.name}`}
                onClick={() => onOpenMention(participant.id)}
                onContextMenu={openAvatarContext}
                onKeyDown={keyboardAvatarContext}
              >
                <HostAgentAvatar participant={participant} />
              </button>
            </span>
            <div className="cxa-approval-card-shell">
              <div className="cxa-approval-card-anchor">
                <div
                  className="cxa-approval-card"
                  tabIndex={0}
                  onContextMenu={openApprovalContext}
                  onKeyDown={keyboardApprovalContext}
                >
                  <div className="cxa-approval-card-copy">
                    <span className="cxa-approval-target">{target}</span>
                    <p className="cxa-approval-reason">{entry.reason.text}</p>
                    {entry.diagnostic === undefined
                      ? null
                      : <p className="cxa-approval-diagnostic" role="status">{entry.diagnostic}</p>}
                  </div>
                  {entry.state === 'pending'
                    ? (
                      <div
                        className="cxa-approval-card-actions"
                        role="group"
                        aria-label={chinese ? `${authorityName} 的审批操作` : `${authorityName} approval actions`}
                      >
                        {entry.actions.map(action => {
                          const approve = action.decision === 'approve'
                          const actionLabel = approve ? (chinese ? '批准' : 'Approve') : (chinese ? '拒绝' : 'Reject')
                          return (
                            <button
                              key={action.decision}
                              type="button"
                              className="cxa-approval-action"
                              data-decision={action.decision}
                              aria-label={`${actionLabel} · ${authorityName}`}
                              title={`${actionLabel} · ${authorityName}`}
                              onFocus={() => {
                                approvalActionHadFocus.current = true
                              }}
                              onBlur={event => {
                                if (
                                  articleRef.current?.contains(event.relatedTarget as Node | null) !== true
                                ) approvalActionHadFocus.current = false
                              }}
                              onClick={() => {
                                void commands.runApproval(model, entry, action).catch(onCommandError)
                              }}
                            >
                              <HostSurfaceIcon token={approve ? 'host:success' : 'host:close'} />
                            </button>
                          )
                        })}
                      </div>
                    )
                    : (
                      <span className="cxa-approval-outcome" data-state={entry.state} role="status">
                        <HostSurfaceIcon
                          token={entry.state === 'approved'
                            ? 'host:success'
                            : entry.state === 'failed'
                            ? 'host:error'
                            : 'host:close'}
                        />
                        <span>{outcome}</span>
                      </span>
                    )}
                </div>
                <div
                  className="cxa-message-hover-actions cxa-approval-hover-actions"
                  role="toolbar"
                  aria-label={chinese ? '审批卡片操作' : 'Approval card actions'}
                >
                  <button
                    type="button"
                    className="cxa-message-hover-action"
                    aria-label={chinese ? '复制审批理由' : 'Copy approval reason'}
                    onClick={copyApprovalReason}
                  >
                    <HostIcon token="action.copy" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </article>
    )
  }
  const label = entry.state === 'pending'
    ? (chinese ? `${participant?.name ?? 'Agent'} 请求批准` : `${participant?.name ?? 'Agent'} requests approval`)
    : chinese
    ? `批准状态：${entry.state}`
    : `Approval: ${entry.state}`
  return (
    <article
      className="cxa-entry cxa-approval"
      data-entry-id={entry.itemId}
      data-state={entry.state}
      role="group"
      aria-label={label}
    >
      <div className="cxa-approval-copy">
        <strong>{label}</strong>
        {entry.rationale === undefined ? null : <p>{entry.rationale}</p>}
        {entry.diagnostic === undefined ? null : <p role="status">{entry.diagnostic}</p>}
      </div>
      {entry.actions.length === 0 ? null : (
        <div className="cxa-approval-actions">
          {entry.actions.map(action => (
            <button
              key={action.decision}
              type="button"
              className="cxa-action"
              onClick={() => {
                void commands.runApproval(model, entry, action).catch(onCommandError)
              }}
            >
              {action.decision === 'approve'
                ? (chinese ? '批准' : 'Approve')
                : action.decision === 'deny'
                ? (chinese ? '拒绝' : 'Deny')
                : (chinese ? '取消' : 'Cancel')}
            </button>
          ))}
        </div>
      )}
    </article>
  )
}

export function stateCopy(message: AgentConversationMessage, copy: AgentConversationRendererCopy): string | undefined {
  if (message.runState === 'running') return copy.running
  if (message.runState === 'stopped') return copy.stopped
  if (message.runState === 'failed' || message.deliveryState === 'failed') return copy.failed
  if (message.deliveryState === 'pending') return copy.pending
  return undefined
}

export function reactionStateCopy(state: 'pending' | 'completed' | 'failed', locale: string): string {
  const chinese = locale.toLowerCase().startsWith('zh')
  if (state === 'pending') return chinese ? '处理中' : 'pending'
  if (state === 'completed') return chinese ? '已完成' : 'completed'
  return chinese ? '失败' : 'failed'
}

export function ActionButton({ action, run }: { readonly action: AgentConversationAction; readonly run: () => void }) {
  const reasonId = React.useId()
  return (
    <>
      <button
        type="button"
        className="cxa-action"
        disabled={action.disabled}
        aria-describedby={action.disabled && action.disabledReason !== undefined ? reasonId : undefined}
        onClick={run}
      >
        {action.icon === undefined ? null : <HostSurfaceIcon token={action.icon} />}
        <span className="cxa-action-copy">{action.label}</span>
      </button>
      {action.disabled && action.disabledReason !== undefined
        ? <span id={reasonId} className="cxa-live-region">{action.disabledReason}</span>
        : null}
    </>
  )
}

export function MessageHoverActions({
  entry,
  model,
  commands,
  copy,
  onCommandError,
}: {
  readonly entry: AgentConversationMessage
  readonly model: AgentConversationModel
  readonly commands: AgentConversationCommandController
  readonly copy: AgentConversationRendererCopy
  readonly onCommandError: (error: unknown) => void
}) {
  const chinese = copy.locale.toLowerCase().startsWith('zh')
  const directActions = entry.actions.slice(0, 2)
  const overflowActions = entry.actions.slice(2)
  const copyMessage = (event: React.MouseEvent<HTMLButtonElement>): void => {
    const clipboard = event.currentTarget.ownerDocument.defaultView?.navigator.clipboard
    if (clipboard === undefined) {
      onCommandError(new Error(chinese ? '当前环境不支持复制。' : 'Copy is unavailable in this environment.'))
      return
    }
    void clipboard.writeText(entry.body.join('\n\n')).catch(onCommandError)
  }
  return (
    <div className="cxa-message-hover-actions" role="toolbar" aria-label={chinese ? '消息操作' : 'Message actions'}>
      <div className="cxa-message-extension-actions" data-host-conversation-message-action-slot="v1">
        {directActions.map(action => (
          <ActionButton
            key={action.id}
            action={action}
            run={() => {
              void commands.runMessage(model, entry.itemId, action).catch(onCommandError)
            }}
          />
        ))}
      </div>
      <button
        type="button"
        className="cxa-message-hover-action"
        aria-label={chinese ? '复制消息' : 'Copy message'}
        onClick={copyMessage}
      >
        <HostIcon token="action.copy" />
      </button>
      <details className="cxa-message-more">
        <summary className="cxa-message-hover-action" aria-label={chinese ? '更多消息操作' : 'More message actions'}>
          <HostSurfaceIcon token="host:more" />
        </summary>
        <div className="cxa-message-more-menu" role="menu" data-host-conversation-message-action-overflow="v1">
          {overflowActions.length === 0
            ? <span className="cxa-message-more-empty">{chinese ? '暂无更多操作' : 'No more actions'}</span>
            : overflowActions.map(action => (
              <ActionButton
                key={action.id}
                action={action}
                run={() => {
                  void commands.runMessage(model, entry.itemId, action).catch(onCommandError)
                }}
              />
            ))}
        </div>
      </details>
    </div>
  )
}

export function HeaderMoreMenu({
  actions,
  navigationActions,
  model,
  commands,
  copy,
  onCommandError,
}: {
  readonly actions: readonly AgentConversationAction[]
  readonly navigationActions: readonly HostNavigationCollectionAction[]
  readonly model: AgentConversationModel
  readonly commands: AgentConversationCommandController
  readonly copy: AgentConversationRendererCopy
  readonly onCommandError: (error: unknown) => void
}) {
  const [open, setOpen] = React.useState(false)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const menuRef = React.useRef<HTMLDivElement>(null)
  const navigationControllerRef = React.useRef<HostNavigationCollectionActionController | undefined>(undefined)
  const menuId = React.useId()
  const chinese = copy.locale.toLowerCase().startsWith('zh')
  const closeAndRestoreFocus = React.useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])

  React.useEffect(() => {
    const document = triggerRef.current?.ownerDocument
    if (document === undefined) return
    const controller = new HostNavigationCollectionActionController(document)
    navigationControllerRef.current = controller
    return () => {
      if (navigationControllerRef.current === controller) navigationControllerRef.current = undefined
      controller.dispose()
    }
  }, [])

  React.useEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    const menu = menuRef.current
    const document = trigger?.ownerDocument
    if (trigger === null || menu === null || document === undefined) return
    const firstAction = menu.querySelector<HTMLButtonElement>('button:not(:disabled)')
    ;(firstAction ?? menu).focus()
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof document.defaultView!.Node) || trigger.contains(target) || menu.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeAndRestoreFocus()
        return
      }
      const items = [...menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')]
      const current = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'ArrowDown'
        ? current < 0 || current === items.length - 1 ? 0 : current + 1
        : event.key === 'ArrowUp'
        ? current <= 0 ? items.length - 1 : current - 1
        : event.key === 'Home'
        ? 0
        : event.key === 'End'
        ? items.length - 1
        : undefined
      if (next === undefined) return
      event.preventDefault()
      items[next]?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [closeAndRestoreFocus, open])

  const select = (action: AgentConversationAction): void => {
    closeAndRestoreFocus()
    void commands.runHeader(model, action).catch(onCommandError)
  }
  const selectNavigation = (action: HostNavigationCollectionAction): void => {
    const trigger = triggerRef.current
    const controller = navigationControllerRef.current
    closeAndRestoreFocus()
    if (trigger === null || controller === undefined) return
    void controller.invoke(action, trigger)
  }
  const itemCount = actions.length + navigationActions.length
  return (
    <span className="cxa-header-more-anchor">
      <button
        ref={triggerRef}
        type="button"
        className="cxa-header-icon-action"
        aria-label={chinese ? '更多' : 'More'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(value => !value)}
        onKeyDown={event => {
          if (event.key !== 'ArrowDown') return
          event.preventDefault()
          setOpen(true)
        }}
      >
        <HostSurfaceIcon token="host:more" />
      </button>
      {!open ? null : (
        <div
          ref={menuRef}
          id={menuId}
          className="cxa-header-more-menu"
          role="menu"
          aria-label={chinese ? '更多操作' : 'More actions'}
          tabIndex={-1}
          data-host-conversation-header-action-overflow="v1"
        >
          {itemCount === 0
            ? (
              <span className="cxa-header-more-empty" role="status">
                {chinese ? '暂无更多操作' : 'No more actions'}
              </span>
            )
            : (
              <>
                {actions.map(action => (
                  <button
                    key={action.id}
                    type="button"
                    className="cxa-header-more-item"
                    role="menuitem"
                    disabled={action.disabled}
                    title={action.disabledReason}
                    data-host-conversation-header-action-id={action.id}
                    onClick={() => select(action)}
                  >
                    {action.icon === undefined ? null : <HostSurfaceIcon token={action.icon} />}
                    <span>{action.label}</span>
                  </button>
                ))}
                {navigationActions.map(action => (
                  <button
                    key={`navigation:${action.id}`}
                    type="button"
                    className="cxa-header-more-item"
                    role="menuitem"
                    disabled={action.disabled}
                    title={action.disabledReason}
                    data-tone={action.tone}
                    data-pressed={String(action.pressed)}
                    data-host-navigation-action-id={action.id}
                    onClick={() => selectNavigation(action)}
                  >
                    {action.icon === undefined
                      ? null
                      : <HostSurfaceIcon token={action.icon} state={action.pressed ? 'active' : 'default'} />}
                    <span>{action.label}</span>
                  </button>
                ))}
              </>
            )}
        </div>
      )}
    </span>
  )
}

export type ConversationInspector =
  | Readonly<{ kind: 'members' | 'settings' }>
  | Readonly<{ kind: 'identity'; participantId: string }>

export type ConversationContextTarget = Readonly<{
  kind: 'avatar' | 'message'
  x: number
  y: number
  participantId: string
  participantName: string
  participantRole: 'agent' | 'human' | 'system'
  restoreFocus: HTMLElement
  messageText?: string
}>

export type ComposerMentionRequest = Readonly<{
  sequence: number
  participantId: string
  participantName: string
}>

export function identityMentionAliases(
  model: AgentConversationModel,
  presentations: ReadonlyMap<string, HostAgentIdentityPresentation>,
): readonly Readonly<{
  alias: string
  participantId: string
  name: string
  presentation?: HostAgentIdentityPresentation
}>[] {
  if (model.selection.kind !== 'room') return []
  const candidates = new Map<string, Set<string>>()
  for (const participant of model.selection.participants) {
    for (const alias of [participant.id, participant.name]) {
      if (alias === '') continue
      const participantIds = candidates.get(alias) ?? new Set<string>()
      participantIds.add(participant.id)
      candidates.set(alias, participantIds)
    }
  }
  const participants = new Map(model.selection.participants.map(participant => [participant.id, participant] as const))
  const resolved: {
    alias: string
    participantId: string
    name: string
    presentation?: HostAgentIdentityPresentation
  }[] = []
  for (const [alias, participantIds] of candidates) {
    if (participantIds.size !== 1) continue
    const participantId = participantIds.values().next().value
    if (participantId === undefined) continue
    const participant = participants.get(participantId)
    if (participant === undefined) continue
    const presentation = presentations.get(participantId)
    resolved.push({
      alias,
      participantId,
      name: presentation?.name ?? participant.name,
      ...(presentation === undefined ? {} : { presentation }),
    })
  }
  return resolved.sort((left, right) => right.alias.length - left.alias.length)
}

export function MessageText({ text, mentions, onOpenMention }: {
  readonly text: string
  readonly mentions: readonly Readonly<{
    alias: string
    participantId: string
    name: string
    presentation?: HostAgentIdentityPresentation
  }>[]
  readonly onOpenMention: (participantId: string) => void
}) {
  if (mentions.length === 0 || !text.includes('@')) return text
  const output: React.ReactNode[] = []
  let cursor = 0
  let searchFrom = 0
  while (searchFrom < text.length) {
    const marker = text.indexOf('@', searchFrom)
    if (marker < 0) break
    const mention = mentions.find(candidate => {
      if (!text.startsWith(candidate.alias, marker + 1)) return false
      const next = text[marker + candidate.alias.length + 1]
      return next === undefined || !/[\p{L}\p{N}._~-]/u.test(next)
    })
    if (mention === undefined) {
      searchFrom = marker + 1
      continue
    }
    if (marker > cursor) output.push(text.slice(cursor, marker))
    const participantId = mention.participantId
    output.push(
      <button
        key={`${marker}:${participantId}`}
        type="button"
        className="cxa-message-mention"
        data-mention-participant-id={participantId}
        aria-label={`Open ${mention.name}${mention.presentation === undefined ? ' in members' : ''}`}
        onClick={() => onOpenMention(participantId)}
      >
        @{mention.alias}
      </button>,
    )
    cursor = marker + mention.alias.length + 1
    searchFrom = cursor
  }
  if (cursor < text.length) output.push(text.slice(cursor))
  return output.length === 0 ? text : <>{output}</>
}

export function ConversationContextMenu({ target, chinese, onClose, onMention, onOpenParticipant, onError }: {
  readonly target: ConversationContextTarget
  readonly chinese: boolean
  readonly onClose: () => void
  readonly onMention: (participantId: string) => void
  readonly onOpenParticipant: (participantId: string) => void
  readonly onError: (error: unknown) => void
}) {
  const menuRef = React.useRef<HTMLDivElement>(null)
  const menuId = React.useId()
  const closeAndRestoreFocus = (): void => {
    onClose()
    queueMicrotask(() => target.restoreFocus.focus({ preventScroll: true }))
  }
  const copyMessage = (): void => {
    const clipboard = menuRef.current?.ownerDocument.defaultView?.navigator.clipboard
    if (clipboard === undefined || target.messageText === undefined) {
      onError(new Error(chinese ? '当前环境不支持复制。' : 'Copy is unavailable in this environment.'))
      return
    }
    void clipboard.writeText(target.messageText).catch(onError)
  }
  const actions = [
    ...(target.kind === 'message' && target.messageText !== undefined
      ? [{
        id: 'copy',
        icon: 'host:copy' as const,
        label: chinese ? '复制消息' : 'Copy message',
        run: copyMessage,
      }]
      : []),
    ...(target.participantRole === 'agent'
      ? [{
        id: 'mention',
        icon: 'host:chat' as const,
        label: chinese ? `@提及 ${target.participantName}` : `Mention @${target.participantName}`,
        run: () => onMention(target.participantId),
      }, {
        id: 'profile',
        icon: 'host:people-search' as const,
        label: chinese ? `查看 ${target.participantName}` : `View ${target.participantName}`,
        run: () => onOpenParticipant(target.participantId),
      }]
      : []),
  ]

  React.useLayoutEffect(() => {
    const menu = menuRef.current
    if (menu === null) return
    const document = menu.ownerDocument
    const view = document.defaultView
    if (view === null) return
    const theme = new HostThemeProjection(document)
    const detachTheme = theme.attach(menu)
    const edge = 8
    const rect = menu.getBoundingClientRect()
    menu.style.left = `${
      Math.round(Math.min(Math.max(edge, target.x), Math.max(edge, view.innerWidth - rect.width - edge)))
    }px`
    menu.style.top = `${
      Math.round(Math.min(Math.max(edge, target.y), Math.max(edge, view.innerHeight - rect.height - edge)))
    }px`
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    return () => {
      detachTheme()
      theme.dispose()
    }
  }, [target.x, target.y])

  React.useEffect(() => {
    const menu = menuRef.current
    if (menu === null) return
    const document = menu.ownerDocument
    const view = document.defaultView
    if (view === null) return
    const closeOutside = (event: PointerEvent): void => {
      const candidate = event.target
      if (candidate instanceof view.Node && menu.contains(candidate)) return
      closeAndRestoreFocus()
    }
    const closeForViewport = (): void => onClose()
    document.addEventListener('pointerdown', closeOutside, true)
    view.addEventListener('resize', closeForViewport)
    document.addEventListener('scroll', closeForViewport, true)
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true)
      view.removeEventListener('resize', closeForViewport)
      document.removeEventListener('scroll', closeForViewport, true)
    }
  }, [onClose])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeAndRestoreFocus()
      return
    }
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    if (buttons.length === 0) return
    const index = buttons.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' || event.key === 'ArrowRight'
      ? buttons[(index + 1 + buttons.length) % buttons.length]
      : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
      ? buttons[(index - 1 + buttons.length) % buttons.length]
      : event.key === 'Home'
      ? buttons[0]
      : event.key === 'End'
      ? buttons.at(-1)
      : undefined
    if (next === undefined) return
    event.preventDefault()
    event.stopPropagation()
    next.focus()
  }

  return createPortal(
    <div
      ref={menuRef}
      id={menuId}
      className="cxa-context-menu"
      role="menu"
      aria-label={target.kind === 'avatar'
        ? (chinese ? `${target.participantName} 头像操作` : `${target.participantName} avatar actions`)
        : (chinese ? '消息操作' : 'Message actions')}
      onKeyDown={onKeyDown}
    >
      {actions.map(action => (
        <button
          key={action.id}
          type="button"
          className="cxa-context-menu-item"
          role="menuitem"
          onClick={() => {
            onClose()
            action.run()
            if (action.id === 'copy') queueMicrotask(() => target.restoreFocus.focus({ preventScroll: true }))
          }}
        >
          <HostSurfaceIcon token={action.icon} />
          <span>{action.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  )
}
