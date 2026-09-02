import * as React from 'react'
import { createPortal } from 'react-dom'
import { HostSurfaceIcon } from '../HostSurfaceIcon.js'
import { HostIcon } from '../HostIcon.js'
import { useAutoFollow } from '../useAutoFollow.js'
import type { AgentConversationCommandController } from './commands.js'
import {
  participantFor,
  type AgentConversationAction,
  type AgentConversationActiveRun,
  type AgentConversationApproval,
  type AgentConversationEntry,
  type AgentConversationMessage,
  type AgentConversationModel,
} from './model.js'
import { AGENT_CONVERSATION_STYLES } from './styles.js'
import { HostAgentAvatar } from './AgentAvatar.js'
import type { HostAgentTaskDetailsNavigator } from '../AgentTaskDetailsNavigator.js'
import {
  createHostAgentIdentityPresentation,
  HostAgentIdentityContent,
  type HostAgentIdentityPanelCopy,
  type HostAgentIdentityPresentation,
} from './AgentIdentityPanel.js'
import { HostConversationRightInspector } from './RightInspector.js'
import { HostRoomCompositeAvatar } from './RoomCompositeAvatar.js'
import { useHostShikitorComposer } from './ShikitorComposerAdapter.js'
import type { HostSchemaFormProps } from '../HostSchemaForm.js'
import type { CordisXConfigFieldSnapshot } from '../../../contracts.js'
import { PLAYGROUND_ROOM_SIMULATION_BINDING_CONTRACT } from '../../playground-room-simulation-bridge.js'
import { HostThemeProjection } from '../../host-theme.js'

// The schema renderer is loaded only when the Host-owned settings inspector
// opens. This preserves the same Schemastery/TDesign form path while allowing
// the conversation shell itself to remain a lightweight structured surface.
const HostSchemaForm = React.lazy(async () => {
  const module = await import('../HostSchemaForm.js')
  return { default: module.HostSchemaForm }
})

export interface AgentConversationRendererCopy {
  readonly locale: string
  readonly newRoomTitle: string
  readonly timelineLabel: string
  readonly composerLabel: string
  readonly sendLabel: string
  readonly running: string
  readonly stopped: string
  readonly failed: string
  readonly pending: string
  readonly unavailable: string
}

function ApprovalEntry({ entry, model, commands, copy, onCommandError }: {
  readonly entry: AgentConversationApproval
  readonly model: AgentConversationModel
  readonly commands: AgentConversationCommandController
  readonly copy: AgentConversationRendererCopy
  readonly onCommandError: (error: unknown) => void
}) {
  const participant = participantFor(model, entry.participantId)
  const chinese = copy.locale.toLowerCase().startsWith('zh')
  const label = entry.state === 'pending'
    ? (chinese ? `${participant?.name ?? 'Agent'} 请求批准` : `${participant?.name ?? 'Agent'} requests approval`)
    : chinese ? `批准状态：${entry.state}` : `Approval: ${entry.state}`
  return <article className="cxa-entry cxa-approval" data-entry-id={entry.itemId} data-state={entry.state} role="group" aria-label={label}>
    <div className="cxa-approval-copy"><strong>{label}</strong>{entry.rationale === undefined ? null : <p>{entry.rationale}</p>}{entry.diagnostic === undefined ? null : <p role="status">{entry.diagnostic}</p>}</div>
    {entry.actions.length === 0 ? null : <div className="cxa-approval-actions">{entry.actions.map(action => <button
      key={action.decision}
      type="button"
      className="cxa-action"
      onClick={() => { void commands.runApproval(model, entry, action).catch(onCommandError) }}
    >{action.decision === 'approve' ? (chinese ? '批准' : 'Approve') : action.decision === 'deny' ? (chinese ? '拒绝' : 'Deny') : (chinese ? '取消' : 'Cancel')}</button>)}</div>}
  </article>
}

export interface AgentConversationRendererProps {
  readonly model: AgentConversationModel
  readonly commands: AgentConversationCommandController
  readonly copy: AgentConversationRendererCopy
  readonly debugFixture?: boolean
  readonly identity?: {
    readonly resolve: (identity: { readonly agentId: string; readonly revision: string }) => { readonly identity: { readonly agentId: string; readonly revision: string }; readonly name: string; readonly introduction: string } | undefined
    readonly navigator: HostAgentTaskDetailsNavigator
    readonly onSettings: (identity: { readonly agentId: string; readonly revision: string }) => void | Promise<void>
  }
  readonly roomSettings?: {
    readonly update: (patch: { readonly name?: string; readonly description?: { readonly state: 'empty' } | { readonly state: 'present'; readonly text: string } }) => Promise<void>
  }
}

function stateCopy(message: AgentConversationMessage, copy: AgentConversationRendererCopy): string | undefined {
  if (message.runState === 'running') return copy.running
  if (message.runState === 'stopped') return copy.stopped
  if (message.runState === 'failed' || message.deliveryState === 'failed') return copy.failed
  if (message.deliveryState === 'pending') return copy.pending
  return undefined
}

function reactionStateCopy(state: 'pending' | 'completed' | 'failed', locale: string): string {
  const chinese = locale.toLowerCase().startsWith('zh')
  if (state === 'pending') return chinese ? '处理中' : 'pending'
  if (state === 'completed') return chinese ? '已完成' : 'completed'
  return chinese ? '失败' : 'failed'
}

function ActionButton({ action, run }: { readonly action: AgentConversationAction; readonly run: () => void }) {
  const reasonId = React.useId()
  return <>
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
}

function MessageHoverActions({
  entry, model, commands, copy, onCommandError,
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
  return <div className="cxa-message-hover-actions" role="toolbar" aria-label={chinese ? '消息操作' : 'Message actions'}>
    <div className="cxa-message-extension-actions" data-host-conversation-message-action-slot="v1">
      {directActions.map(action => <ActionButton key={action.id} action={action} run={() => {
        void commands.runMessage(model, entry.itemId, action).catch(onCommandError)
      }} />)}
    </div>
    <button type="button" className="cxa-message-hover-action" aria-label={chinese ? '复制消息' : 'Copy message'} onClick={copyMessage}><HostIcon token="action.copy" /></button>
    <details className="cxa-message-more">
      <summary className="cxa-message-hover-action" aria-label={chinese ? '更多消息操作' : 'More message actions'}><HostSurfaceIcon token="host:more" /></summary>
      <div className="cxa-message-more-menu" role="menu" data-host-conversation-message-action-overflow="v1">
        {overflowActions.length === 0
          ? <span className="cxa-message-more-empty">{chinese ? '暂无更多操作' : 'No more actions'}</span>
          : overflowActions.map(action => <ActionButton key={action.id} action={action} run={() => {
            void commands.runMessage(model, entry.itemId, action).catch(onCommandError)
          }} />)}
      </div>
    </details>
  </div>
}

function HeaderMoreMenu({
  actions, model, commands, copy, onCommandError,
}: {
  readonly actions: readonly AgentConversationAction[]
  readonly model: AgentConversationModel
  readonly commands: AgentConversationCommandController
  readonly copy: AgentConversationRendererCopy
  readonly onCommandError: (error: unknown) => void
}) {
  const [open, setOpen] = React.useState(false)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const menuRef = React.useRef<HTMLDivElement>(null)
  const menuId = React.useId()
  const chinese = copy.locale.toLowerCase().startsWith('zh')
  const closeAndRestoreFocus = React.useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus()
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
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeAndRestoreFocus()
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
  return <span className="cxa-header-more-anchor">
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
    ><HostSurfaceIcon token="host:more" /></button>
    {!open ? null : <div
      ref={menuRef}
      id={menuId}
      className="cxa-header-more-menu"
      role="menu"
      aria-label={chinese ? '更多操作' : 'More actions'}
      tabIndex={-1}
      data-host-conversation-header-action-overflow="v1"
    >
      {actions.length === 0
        ? <span className="cxa-header-more-empty" role="status">{chinese ? '暂无更多操作' : 'No more actions'}</span>
        : actions.map(action => <button
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
        </button>)}
    </div>}
  </span>
}

type ConversationInspector =
  | Readonly<{ kind: 'members' | 'settings' }>
  | Readonly<{ kind: 'identity'; participantId: string }>

type ConversationContextTarget = Readonly<{
  kind: 'avatar' | 'message'
  x: number
  y: number
  participantId: string
  participantName: string
  participantRole: 'agent' | 'human' | 'system'
  restoreFocus: HTMLElement
  messageText?: string
}>

type ComposerMentionRequest = Readonly<{
  sequence: number
  participantId: string
  participantName: string
}>

function identityMentionAliases(
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

function MessageText({ text, mentions, onOpenMention }: {
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
    output.push(<button
      key={`${marker}:${participantId}`}
      type="button"
      className="cxa-message-mention"
      data-mention-participant-id={participantId}
      aria-label={`Open ${mention.name}${mention.presentation === undefined ? ' in members' : ''}`}
      onClick={() => onOpenMention(participantId)}
    >@{mention.alias}</button>)
    cursor = marker + mention.alias.length + 1
    searchFrom = cursor
  }
  if (cursor < text.length) output.push(text.slice(cursor))
  return output.length === 0 ? text : <>{output}</>
}

function ConversationContextMenu({ target, chinese, onClose, onMention, onOpenParticipant, onError }: {
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
    ...(target.kind === 'message' && target.messageText !== undefined ? [{
      id: 'copy', label: chinese ? '复制消息' : 'Copy message', run: copyMessage,
    }] : []),
    ...(target.participantRole === 'agent' ? [{
      id: 'mention', label: chinese ? `@提及 ${target.participantName}` : `Mention @${target.participantName}`,
      run: () => onMention(target.participantId),
    }, {
      id: 'profile', label: chinese ? `查看 ${target.participantName}` : `View ${target.participantName}`,
      run: () => onOpenParticipant(target.participantId),
    }] : []),
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
    menu.style.left = `${Math.round(Math.min(Math.max(edge, target.x), Math.max(edge, view.innerWidth - rect.width - edge)))}px`
    menu.style.top = `${Math.round(Math.min(Math.max(edge, target.y), Math.max(edge, view.innerHeight - rect.height - edge)))}px`
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    return () => { detachTheme(); theme.dispose() }
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
        : event.key === 'Home' ? buttons[0] : event.key === 'End' ? buttons.at(-1) : undefined
    if (next === undefined) return
    event.preventDefault()
    event.stopPropagation()
    next.focus()
  }

  return createPortal(<div
    ref={menuRef}
    id={menuId}
    className="cxa-context-menu"
    role="menu"
    aria-label={target.kind === 'avatar'
      ? (chinese ? `${target.participantName} 头像操作` : `${target.participantName} avatar actions`)
      : (chinese ? '消息操作' : 'Message actions')}
    onKeyDown={onKeyDown}
  >{actions.map(action => <button
    key={action.id}
    type="button"
    className="cxa-context-menu-item"
    role="menuitem"
    onClick={() => {
      onClose()
      action.run()
      if (action.id === 'copy') queueMicrotask(() => target.restoreFocus.focus({ preventScroll: true }))
    }}
  >{action.label}</button>)}</div>, document.body)
}

function MessageEntry({
  entry, previous, next, model, commands, onCommandError, copy, mentionPresentations, onOpenMention, onMentionParticipant, onOpenContextMenu,
}: {
  readonly entry: AgentConversationMessage
  readonly previous: AgentConversationEntry | undefined
  readonly next: AgentConversationEntry | undefined
  readonly model: AgentConversationModel
  readonly commands: AgentConversationCommandController
  readonly onCommandError: (error: unknown) => void
  readonly copy: AgentConversationRendererCopy
  readonly mentionPresentations: readonly Readonly<{
    alias: string
    participantId: string
    name: string
    presentation?: HostAgentIdentityPresentation
  }>[]
  readonly onOpenMention: (participantId: string) => void
  readonly onMentionParticipant: (participantId: string) => void
  readonly onOpenContextMenu: (target: ConversationContextTarget) => void
}) {
  const participant = participantFor(model, entry.authorId)
  if (participant === undefined) return null
  const showInitials = model.selection.kind === 'room'
    && model.selection.multiParticipant
    && model.selection.participantPresentation === 'host-initials'
  const showAgentAvatar = participant.role === 'agent'
    && (participant.avatar !== undefined || showInitials)
  const sameIncomingAgent = (other: AgentConversationEntry | undefined): boolean => {
    if (other?.kind !== 'message' || participant.role !== 'agent' || other.authorId !== participant.id) return false
    const otherParticipant = participantFor(model, other.authorId)
    return otherParticipant?.role === 'agent'
      && otherParticipant.agentIdentity?.agentId === participant.agentIdentity?.agentId
      && otherParticipant.agentIdentity?.revision === participant.agentIdentity?.revision
  }
  const groupStart = !sameIncomingAgent(previous)
  const groupEnd = !sameIncomingAgent(next)
  const state = stateCopy(entry, copy)
  const outgoing = participant.role === 'human'
  const time = new Date(entry.timestamp).toLocaleTimeString(copy.locale, { hour: '2-digit', minute: '2-digit' })
  const accessibleLabel = `${participant.name}, ${time}`
  const timestamp = <time className="cxa-message-time" dateTime={entry.timestamp} aria-label={time}>{time}</time>
  const contextTarget = (
    kind: ConversationContextTarget['kind'],
    x: number,
    y: number,
    restoreFocus: HTMLElement,
  ): ConversationContextTarget => ({
    kind,
    x,
    y,
    participantId: participant.id,
    participantName: participant.name,
    participantRole: participant.role,
    restoreFocus,
    ...(kind === 'message' ? { messageText: entry.body.join('\n\n') } : {}),
  })
  const openPointerContextMenu = (kind: ConversationContextTarget['kind'], event: React.MouseEvent<HTMLElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    onOpenContextMenu(contextTarget(kind, event.clientX, event.clientY, event.currentTarget))
  }
  const openKeyboardContextMenu = (kind: ConversationContextTarget['kind'], event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    onOpenContextMenu(contextTarget(
      kind,
      rect.left + Math.min(24, rect.width / 2),
      rect.top + Math.min(24, rect.height / 2),
      event.currentTarget,
    ))
  }
  const messageReactions = (entry.reactions ?? []).length === 0 ? null : <div className="cxa-message-reactions" role="list" aria-label={copy.locale.toLowerCase().startsWith('zh') ? '消息反应' : 'Message reactions'}>
    {(entry.reactions ?? []).map(reaction => {
      const actor = participantFor(model, reaction.actorParticipantId)
      const actorName = actor?.name ?? (copy.locale.toLowerCase().startsWith('zh') ? '未知参与者' : 'Unknown participant')
      const value = reaction.value.kind === 'emoji' ? reaction.value.emoji : reaction.value.token
      const state = reactionStateCopy(reaction.state, copy.locale)
      return <span
        key={reaction.reactionId}
        className="cxa-message-reaction"
        data-reaction-state={reaction.state}
        role="listitem"
        aria-label={copy.locale.toLowerCase().startsWith('zh') ? `${actorName} 的反应：${value}，${state}` : `${actorName}'s reaction: ${value}, ${state}`}
      >
        {actor === undefined ? null : <span className="cxa-message-reaction-avatar"><HostAgentAvatar participant={actor} /></span>}
        <span className="cxa-message-reaction-actor">{actorName}</span>
        <span className="cxa-message-reaction-value">{value}</span>
      </span>
    })}
  </div>
  const messageSurface = <div
    className="cxa-message-surface"
    tabIndex={0}
    aria-label={accessibleLabel}
    onContextMenu={event => openPointerContextMenu('message', event)}
    onKeyDown={event => openKeyboardContextMenu('message', event)}
  >
    <div className="cxa-message-body">{entry.body.map((block, index) => <p key={index}><MessageText text={block} mentions={mentionPresentations} onOpenMention={onOpenMention} /></p>)}</div>
    {outgoing || state === undefined ? null : <span className="cxa-message-state">{state}</span>}
    {!outgoing || entry.deliveryState !== 'failed' ? null : <span className="cxa-outgoing-error" role="status">{copy.failed}</span>}
  </div>
  const avatarSeatEmpty = !groupEnd || !showAgentAvatar
  const avatarSeat = participant.role !== 'agent' ? null : <span
    className="cxa-message-avatar-seat"
    data-avatar-seat={avatarSeatEmpty ? 'placeholder' : 'visible'}
    {...(avatarSeatEmpty ? { 'aria-hidden': true, inert: true } : {})}
  >
    {avatarSeatEmpty
      ? null
      : <button
          type="button"
          className="cx-agent-identity-avatar-button"
          aria-label={copy.locale.toLowerCase().startsWith('zh') ? `查看 ${participant.name}` : `Open ${participant.name}`}
          onClick={() => onOpenMention(entry.authorId)}
          onContextMenu={event => openPointerContextMenu('avatar', event)}
          onKeyDown={event => openKeyboardContextMenu('avatar', event)}
        ><HostAgentAvatar participant={participant} /></button>}
  </span>
  return <article
    className="cxa-entry cxa-message"
    data-entry-id={entry.itemId}
    data-role={participant.role}
    data-group-start={String(groupStart)}
    data-group-end={String(groupEnd)}
    data-delivery-state={entry.deliveryState}
    data-run-state={entry.runState}
    aria-label={accessibleLabel}
    aria-live={entry.ariaLive}
  >
    <div className="cxa-message-content">
      {outgoing ? null : <div className="cxa-message-meta">{groupStart ? <button
        type="button"
        className="cxa-author cxa-author-button"
        aria-label={copy.locale.toLowerCase().startsWith('zh') ? `@提及 ${participant.name}` : `Mention @${participant.name}`}
        onClick={() => onMentionParticipant(participant.id)}
      >{participant.name}</button> : null}{timestamp}</div>}
      <div className="cxa-message-bubble-row">{avatarSeat}<div className="cxa-message-bubble-shell">
        <div className="cxa-message-bubble-anchor">
          {outgoing ? timestamp : null}
          {messageSurface}
          <MessageHoverActions entry={entry} model={model} commands={commands} copy={copy} onCommandError={onCommandError} />
        </div>
        {messageReactions}
      </div></div>
    </div>
  </article>
}

function Timeline({
  model, commands, copy, onCommandError, mentionPresentations, onOpenMention, onMentionParticipant, onOpenContextMenu,
}: Pick<AgentConversationRendererProps, 'model' | 'commands' | 'copy'> & {
  readonly onCommandError: (error: unknown) => void
  readonly mentionPresentations: readonly Readonly<{
    alias: string
    participantId: string
    name: string
    presentation?: HostAgentIdentityPresentation
  }>[]
  readonly onOpenMention: (participantId: string) => void
  readonly onMentionParticipant: (participantId: string) => void
  readonly onOpenContextMenu: (target: ConversationContextTarget) => void
}) {
  const follow = useAutoFollow<HTMLDivElement>(`${model.binding.bindingId}:${model.generation}:${model.snapshotSequence}:${model.entries.length}`)
  const presence = (entry: Extract<AgentConversationEntry, { kind: 'member-presence' }>): string => {
    const name = participantFor(model, entry.participantId)?.name ?? entry.participantId
    const chinese = copy.locale.toLowerCase().startsWith('zh')
    if (entry.state === 'inviting') return chinese ? `正在邀请 ${name} 加入…` : `Inviting ${name}…`
    if (entry.state === 'creating') return chinese ? `正在为 ${name} 创建会话…` : `Creating a session for ${name}…`
    if (entry.state === 'joined') return chinese ? `${name} 已加入群聊` : `${name} joined the room`
    if (entry.state === 'ready') return chinese ? `${name} 已准备好` : `${name} is ready`
    return chinese ? `${name} 加入失败` : `${name} failed to join`
  }
  return <div ref={follow.ref} onScroll={follow.onScroll} className="cxa-timeline" data-agent-conversation-scroll-owner="timeline" role="log" aria-label={copy.timelineLabel} tabIndex={0}>
    <div className="cxa-timeline-list">
      {model.entries.map((entry, index) => entry.kind === 'message'
        ? <MessageEntry
            key={entry.itemId}
            entry={entry}
            previous={model.entries[index - 1]}
            next={model.entries[index + 1]}
            model={model}
            commands={commands}
            copy={copy}
            onCommandError={onCommandError}
            mentionPresentations={mentionPresentations}
            onOpenMention={onOpenMention}
            onMentionParticipant={onMentionParticipant}
            onOpenContextMenu={onOpenContextMenu}
          />
        : entry.kind === 'approval'
          ? <ApprovalEntry key={entry.itemId} entry={entry} model={model} commands={commands} copy={copy} onCommandError={onCommandError} />
        : entry.kind === 'member-presence'
          ? <div key={entry.itemId} className="cxa-entry cxa-status" data-entry-id={entry.itemId} data-state={entry.state} role="status" aria-live="polite">
              <span className="cxa-status-dot" aria-hidden="true" /><span>{presence(entry)}</span>
            </div>
          : <div key={entry.itemId} className="cxa-entry cxa-status" data-entry-id={entry.itemId} data-state={entry.state} role="status" aria-live={entry.ariaLive}>
            <span className="cxa-status-dot" aria-hidden="true" /><span>{entry.label}</span>
          </div>)}
    </div>
  </div>
}

function Composer({
  model, commands, copy, commandError, setCommandError, mentionRequest,
}: Pick<AgentConversationRendererProps, 'model' | 'commands' | 'copy'> & {
  readonly commandError: string | undefined
  readonly setCommandError: (value: string | undefined) => void
  readonly mentionRequest: ComposerMentionRequest | undefined
}) {
  const [draft, setDraft] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const noticeId = React.useId()
  React.useEffect(() => { setDraft(''); setCommandError(undefined) }, [model.binding.bindingId, model.generation, setCommandError])
  const unavailable = model.composer.availability !== 'available'
  const reason = commandError ?? model.composer.disabledReason ?? (unavailable ? copy.unavailable : undefined)
  const disabled = unavailable || model.composer.disabled || submitting || draft.trim() === ''
  const inputRef = useHostShikitorComposer({
    draft,
    instanceKey: `${model.binding.bindingId}:${model.generation}`,
    placeholder: model.composer.placeholder,
    unavailable,
    onDraftChange: setDraft,
  })
  React.useEffect(() => {
    if (mentionRequest === undefined || unavailable) return
    const token = `@${mentionRequest.participantName}`
    setDraft(current => `${current}${current === '' || /\s$/u.test(current) ? '' : ' '}${token} `)
    const view = inputRef.current?.ownerDocument.defaultView ?? undefined
    const frame = view?.requestAnimationFrame(() => {
      const input = inputRef.current
      if (input === null) return
      input.focus({ preventScroll: true })
      input.setSelectionRange(input.value.length, input.value.length)
    })
    return () => { if (view !== undefined && frame !== undefined) view.cancelAnimationFrame(frame) }
  }, [inputRef, mentionRequest, unavailable])
  const submit = async (): Promise<void> => {
    if (disabled) return
    setSubmitting(true)
    setCommandError(undefined)
    try {
      await commands.runComposer(model, draft)
      setDraft('')
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }
  return <div className="cxa-composer-region" data-agent-conversation-composer="fixed">
    <form className="cxa-composer" aria-label={copy.composerLabel} onSubmit={event => { event.preventDefault(); void submit() }}>
      <textarea
        ref={inputRef}
        className="cxa-draft"
        aria-label={copy.composerLabel}
        aria-describedby={reason === undefined ? undefined : noticeId}
        placeholder={model.composer.placeholder}
        value={draft}
        rows={2}
        disabled={unavailable}
        onInput={event => setDraft(event.currentTarget.value)}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
          event.preventDefault()
          void submit()
        }}
      />
      <div className="cxa-composer-footer">
        <p id={noticeId} className="cxa-composer-notice" data-error={String(commandError !== undefined)}>{reason ?? ''}</p>
        <button type="submit" className="cxa-send" disabled={disabled} aria-describedby={reason === undefined ? undefined : noticeId} aria-label={copy.sendLabel}>↑</button>
      </div>
    </form>
  </div>
}

function RoomSettingsEditor({ title, description, chinese, settings, onError, onDone }: {
  readonly title: string
  readonly description: string | undefined
  readonly chinese: boolean
  readonly settings: NonNullable<AgentConversationRendererProps['roomSettings']>
  readonly onError: (error: unknown) => void
  readonly onDone: () => void
}) {
  const fields = React.useMemo<readonly CordisXConfigFieldSnapshot[]>(() => [
    {
      namespace: 'host.agent-conversation.room-settings/v1', path: ['name'], type: 'string',
      label: chinese ? '群聊名称' : 'Room name', description: chinese ? '显示在群聊标题中。' : 'Shown in the room header.',
      value: title, disabled: false, required: true, min: 1, max: 256,
    },
    {
      namespace: 'host.agent-conversation.room-settings/v1', path: ['description'], type: 'string', role: 'textarea',
      label: chinese ? '群聊介绍' : 'Description', description: chinese ? '可选，显示在群聊标题下方。' : 'Optional. Shown below the room title.',
      value: description ?? '', disabled: false, required: false, max: 4_000,
    },
  ], [chinese, description, title])
  const props: HostSchemaFormProps = {
    id: 'agent-conversation-room-settings',
    fields,
    locale: chinese ? 'zh-CN' : 'en',
    resetKey: `${title}\u0000${description ?? ''}`,
    submitLabel: chinese ? '保存' : 'Save',
    savingLabel: chinese ? '保存中…' : 'Saving…',
    onSubmit: async values => {
      const name = typeof values.name === 'string' ? values.name.trim() : ''
      const details = typeof values.description === 'string' ? values.description.trim() : ''
      if (name === '') throw new Error(chinese ? '群聊名称不能为空。' : 'Room name is required.')
      await settings.update({ name, description: details === '' ? { state: 'empty' } : { state: 'present', text: details } })
    },
    onSubmitted: onDone,
    onError,
  }
  return <React.Suspense fallback={<p className="cxa-inspector-note" role="status">{chinese ? '正在载入设置…' : 'Loading settings…'}</p>}><HostSchemaForm {...props} /></React.Suspense>
}

/** Production Host-owned conversation shell. It has no fixture dependency. */
export function AgentConversationRenderer({ model, commands, copy, debugFixture = false, identity, roomSettings }: AgentConversationRendererProps) {
  const titleId = React.useId()
  const identityContentId = React.useId()
  const [commandError, setCommandErrorState] = React.useState<string | undefined>(undefined)
  const [inspector, setInspector] = React.useState<ConversationInspector | undefined>()
  const [inspectorWidth, setInspectorWidth] = React.useState(360)
  const [memberSearch, setMemberSearch] = React.useState('')
  const [memberTargetParticipantId, setMemberTargetParticipantId] = React.useState<string | undefined>()
  const [contextMenuTarget, setContextMenuTarget] = React.useState<ConversationContextTarget | undefined>()
  const [mentionRequest, setMentionRequest] = React.useState<ComposerMentionRequest | undefined>()
  const mentionSequence = React.useRef(0)
  const memberSearchRef = React.useRef<HTMLInputElement>(null)
  const setCommandError = React.useCallback((value: string | undefined) => setCommandErrorState(value), [])
  const title = model.selection.kind === 'room' ? model.selection.title : copy.newRoomTitle
  const description = model.selection.kind === 'room' && model.selection.description?.state === 'present'
    ? model.selection.description.text
    : undefined
  const headerActions = model.headerActions
  const inlineHeaderActions = headerActions.filter(action => action.icon !== undefined).slice(0, 2)
  const inlineHeaderActionSet = new Set(inlineHeaderActions)
  const overflowHeaderActions = headerActions.filter(action => !inlineHeaderActionSet.has(action))
  const onCommandError = React.useCallback((error: unknown) => {
    setCommandError(error instanceof Error ? error.message : String(error))
  }, [])
  const identityPresentations = React.useMemo(() => {
    const output = new Map<string, HostAgentIdentityPresentation>()
    if (identity === undefined || model.selection.kind !== 'room') return output
    const roomSelection = model.selection
    const roomTitle = roomSelection.title
    for (const participant of roomSelection.participants) {
      if (participant.role !== 'agent' || participant.agentIdentity === undefined) continue
      const effective = identity.resolve(participant.agentIdentity)
      if (effective === undefined) continue
      output.set(participant.id, createHostAgentIdentityPresentation({
        participant: {
          participantId: participant.id,
          role: 'agent',
          displayName: { key: 'host.agent.identity.name', fallback: participant.name },
          ...(participant.avatar === undefined ? {} : { avatar: participant.avatar }),
          agentIdentity: participant.agentIdentity,
        },
        name: effective.name,
        introduction: effective.introduction,
        activeSessions: (roomSelection.activeRuns ?? [])
          .filter(run => run.participantId === participant.id)
          .map(run => ({
            run,
            roomLabel: roomTitle,
            taskLabel: `${copy.locale.toLowerCase().startsWith('zh') ? 'Agent 任务' : 'Agent task'} · ${run.lifecycle.phase}`,
            simulationBinding: {
              contract: PLAYGROUND_ROOM_SIMULATION_BINDING_CONTRACT,
              roomId: roomSelection.roomId,
              runId: run.runId,
              memberId: run.memberId,
              bindingId: model.binding.bindingId,
              ownerGeneration: model.binding.ownerGeneration,
              generation: model.generation,
            },
          })),
      }))
    }
    return output
  }, [copy.locale, identity, model.selection])
  const mentionPresentations = React.useMemo(
    () => identityMentionAliases(model, identityPresentations),
    [identityPresentations, model],
  )
  React.useEffect(() => {
    if (inspector?.kind === 'identity' && !identityPresentations.has(inspector.participantId)) setInspector(undefined)
  }, [identityPresentations, inspector])
  const selectedIdentity = inspector?.kind === 'identity' ? identityPresentations.get(inspector.participantId) : undefined
  const chinese = copy.locale.toLowerCase().startsWith('zh')
  const identityCopy: HostAgentIdentityPanelCopy = {
    settings: chinese ? '设置' : 'Settings',
    close: chinese ? '关闭' : 'Close',
    members: chinese ? '群成员' : 'Members',
    backToMembers: chinese ? '返回群成员' : 'Back to members',
    hierarchyNavigation: chinese ? '详情栏层级导航' : 'Inspector hierarchy',
    introduction: chinese ? '介绍' : 'Introduction',
    activeSessions: chinese ? '当前激活的会话' : 'Active sessions',
    noActiveSessions: chinese ? '当前没有激活会话' : 'No active sessions',
    sessionCount: count => chinese ? `${count} 个激活会话` : `${count} active session${count === 1 ? '' : 's'}`,
    lifecycle: {
      active: chinese ? '激活' : 'Active', running: chinese ? '运行中' : 'Running',
      waiting: chinese ? '等待中' : 'Waiting', attention: chinese ? '需处理' : 'Attention',
    },
  }
  const memberInspectorIdentity = inspector?.kind === 'identity' ? selectedIdentity : undefined
  const memberInspectorOpen = inspector?.kind === 'members' || memberInspectorIdentity !== undefined
  const participants = model.selection.kind === 'room' ? model.selection.participants : []
  const activeRuns = model.selection.kind === 'room' ? model.selection.activeRuns ?? [] : []
  const roomId = model.selection.kind === 'room' ? model.selection.roomId : undefined
  const memberTargetParticipant = memberTargetParticipantId === undefined
    ? undefined
    : participants.find(participant => participant.id === memberTargetParticipantId)
  React.useEffect(() => {
    setMemberSearch('')
    setMemberTargetParticipantId(undefined)
    setContextMenuTarget(undefined)
  }, [roomId])
  const closeInspector = (): void => {
    setInspector(undefined)
    setMemberSearch('')
    setMemberTargetParticipantId(undefined)
  }
  const openMembersInspector = (): void => {
    setMemberSearch('')
    setMemberTargetParticipantId(undefined)
    setInspector({ kind: 'members' })
  }
  const openIdentityInspector = (participantId: string): void => {
    setMemberSearch('')
    setMemberTargetParticipantId(undefined)
    setInspector({ kind: 'identity', participantId })
  }
  const openMentionInspector = (participantId: string): void => {
    const presentation = identityPresentations.get(participantId)
    if (presentation !== undefined) {
      openIdentityInspector(participantId)
      return
    }
    const participant = participants.find(candidate => candidate.id === participantId)
    if (participant === undefined) return
    setMemberSearch(participant.name)
    setMemberTargetParticipantId(participantId)
    setInspector({ kind: 'members' })
  }
  const mentionParticipant = (participantId: string): void => {
    const participant = participants.find(candidate => candidate.id === participantId)
    if (participant?.role !== 'agent') return
    mentionSequence.current += 1
    setMentionRequest({
      sequence: mentionSequence.current,
      participantId: participant.id,
      participantName: participant.name,
    })
  }
  const lifecycleFor = (participantId: string): Readonly<{
    phase: AgentConversationActiveRun['lifecycle']['phase']
    label: string
  }> | undefined => {
    const phase = activeRuns.find(run => run.participantId === participantId)?.lifecycle.phase
    if (phase === undefined) return undefined
    const label = chinese
      ? ({ active: '可用', running: '运行中', waiting: '等待中', attention: '需处理' } as const)[phase]
      : ({ active: 'Available', running: 'Running', waiting: 'Waiting', attention: 'Needs attention' } as const)[phase]
    return { phase, label }
  }
  const memberRoleLabel = chinese ? 'Agent' : 'Agent'
  const memberAgents = participants.filter(participant => participant.role === 'agent')
  const normalizedMemberSearch = memberSearch.trim().toLocaleLowerCase()
  const visibleMemberAgents = normalizedMemberSearch === ''
    ? memberAgents
    : memberAgents.filter(participant => participant.name.toLocaleLowerCase().includes(normalizedMemberSearch)
      || memberRoleLabel.toLocaleLowerCase().includes(normalizedMemberSearch))
  return <section
    className="cxa-root"
    data-agent-conversation-renderer="production"
    data-agent-conversation-view={model.selection.kind}
    {...(model.selection.kind === 'room' ? { 'data-agent-conversation-room-id': model.selection.roomId } : {})}
    {...(debugFixture ? { 'data-agent-conversation-fixture': 'debug-only' } : {})}
    aria-labelledby={titleId}
  >
    <style data-agent-conversation-styles="production">{AGENT_CONVERSATION_STYLES}</style>
    <header className="cxa-chrome" data-agent-conversation-chrome="true">
      <div className="cxa-chrome-inner">
        {model.selection.kind === 'room' ? <HostRoomCompositeAvatar
          participants={participants}
          size="header"
          label={chinese ? '打开群成员' : 'Open room members'}
          moreLabel={count => chinese ? `查看其余 ${count} 位群成员` : `View ${count} more room members`}
          onOpen={openMembersInspector}
        /> : <span className="cxa-room-avatar" data-count="zero"><span className="cxa-room-avatar-fallback"><HostSurfaceIcon token="host:layers" /></span></span>}
        <div className="cxa-title-block">
          <h1 id={titleId} className="cxa-title">{title}</h1>
          {model.selection.kind !== 'room' ? null : <button type="button" className="cxa-description-action" onClick={() => setInspector({ kind: 'settings' })}>
            {description ?? (chinese ? '添加群聊介绍' : 'Add a room description')}
          </button>}
        </div>
        {model.selection.kind !== 'room' ? null : <div className="cxa-header-actions">
          <button type="button" className="cxa-header-icon-action" aria-label={chinese ? '群成员' : 'Members'} onClick={openMembersInspector}><HostSurfaceIcon token="host:layers" /></button>
          <button type="button" className="cxa-header-icon-action" aria-label={chinese ? '设置' : 'Settings'} onClick={() => setInspector({ kind: 'settings' })}><HostSurfaceIcon token="host:settings" /></button>
          <span
            className="cxa-header-plugin-actions"
            data-host-conversation-header-action-slot="v1"
            data-host-conversation-header-action-inline-limit="2"
          >{inlineHeaderActions.map(action => <button
            key={action.id}
            type="button"
            className="cxa-header-icon-action cxa-header-plugin-action"
            aria-label={action.label}
            disabled={action.disabled}
            title={action.disabledReason}
            data-host-conversation-header-action-id={action.id}
            onClick={() => { void commands.runHeader(model, action).catch(onCommandError) }}
          ><HostSurfaceIcon token={action.icon!} /></button>)}</span>
          <HeaderMoreMenu actions={overflowHeaderActions} model={model} commands={commands} copy={copy} onCommandError={onCommandError} />
        </div>}
      </div>
    </header>
    <div className="cxa-body">
      <Timeline
        model={model}
        commands={commands}
        copy={copy}
        onCommandError={onCommandError}
        mentionPresentations={mentionPresentations}
        onOpenMention={openMentionInspector}
        onMentionParticipant={mentionParticipant}
        onOpenContextMenu={setContextMenuTarget}
      />
      <Composer
        model={model}
        commands={commands}
        copy={copy}
        commandError={commandError}
        setCommandError={setCommandError}
        mentionRequest={mentionRequest}
      />
    </div>
    {contextMenuTarget === undefined ? null : <ConversationContextMenu
      target={contextMenuTarget}
      chinese={chinese}
      onClose={() => setContextMenuTarget(undefined)}
      onMention={mentionParticipant}
      onOpenParticipant={openMentionInspector}
      onError={onCommandError}
    />}
    {!memberInspectorOpen ? null : <HostConversationRightInspector
      open={true}
      title={memberInspectorIdentity?.name ?? (chinese ? '群成员' : 'Members')}
      closeLabel={memberInspectorIdentity === undefined ? (chinese ? '关闭群成员' : 'Close members') : identityCopy.close}
      resizeLabel={chinese ? '调整详情栏宽度' : 'Resize inspector'}
      width={inspectorWidth}
      onWidthChange={setInspectorWidth}
      pageKey={memberInspectorIdentity === undefined ? 'members' : `identity:${memberInspectorIdentity.participant.participantId}`}
      {...(memberInspectorIdentity === undefined ? {
        leading: <HostSurfaceIcon token="host:layers" />,
      } : {
        breadcrumb: {
          parentLabel: identityCopy.members ?? (chinese ? '群成员' : 'Members'),
          backLabel: identityCopy.backToMembers ?? (chinese ? '返回群成员' : 'Back to members'),
          navigationLabel: identityCopy.hierarchyNavigation ?? (chinese ? '详情栏层级导航' : 'Inspector hierarchy'),
          onBack: () => setInspector({ kind: 'members' }),
        },
        describedBy: `${identityContentId}-introduction`,
      })}
      onOpenChange={open => { if (!open) closeInspector() }}
    >
      {memberInspectorIdentity !== undefined && identity !== undefined ? <HostAgentIdentityContent
        presentation={memberInspectorIdentity}
        copy={identityCopy}
        navigator={identity.navigator}
        onClose={closeInspector}
        onSettings={identity.onSettings}
        onNavigationError={onCommandError}
        idPrefix={identityContentId}
      /> : <div
        className="cxa-members-panel"
        {...(memberTargetParticipant === undefined ? {} : {
          'data-mention-target-participant-id': memberTargetParticipant.id,
          'aria-label': `${chinese ? '消息提及目标' : 'Message mention target'}: ${memberTargetParticipant.name}`,
        })}
      >
        <div className="cxa-member-search" data-host-conversation-member-search="true">
          <input
            ref={memberSearchRef}
            type="search"
            value={memberSearch}
            aria-label={chinese ? '搜索成员' : 'Search members'}
            placeholder={chinese ? '搜索成员' : 'Search members'}
            autoComplete="off"
            spellCheck={false}
            onChange={event => {
              setMemberSearch(event.currentTarget.value)
              setMemberTargetParticipantId(undefined)
            }}
            onKeyDown={event => {
              if (event.key !== 'Escape' || memberSearch === '') return
              event.preventDefault()
              event.stopPropagation()
              setMemberSearch('')
              setMemberTargetParticipantId(undefined)
              memberSearchRef.current?.focus()
            }}
          />
          {memberSearch === '' ? null : <button
            type="button"
            aria-label={chinese ? '清除成员搜索' : 'Clear member search'}
            title={chinese ? '清除' : 'Clear'}
            onClick={() => {
              setMemberSearch('')
              setMemberTargetParticipantId(undefined)
              memberSearchRef.current?.focus()
            }}
          ><HostSurfaceIcon token="host:close" /></button>}
        </div>
        {memberTargetParticipant === undefined ? null : <p
          className="cxa-inspector-note"
          role="status"
          data-mention-target-participant-id={memberTargetParticipant.id}
        >{chinese
            ? `已定位到消息中提及的成员：${memberTargetParticipant.name}`
            : `Showing the member mentioned in the message: ${memberTargetParticipant.name}`}</p>}
        {visibleMemberAgents.length === 0 ? <p className="cxa-members-empty" role="status">
          {normalizedMemberSearch === ''
            ? (chinese ? '暂无协作 Agent' : 'No collaborative agents')
            : (chinese ? '未找到成员' : 'No members found')}
        </p> : <ul className="cxa-members-list">{visibleMemberAgents.map(participant => {
        const presentation = identityPresentations.get(participant.id)
        const lifecycle = lifecycleFor(participant.id)
        const mentionTarget = memberTargetParticipantId === participant.id
        return <li key={participant.id}><button
          type="button"
          className="cxa-member-button"
          disabled={presentation === undefined}
          {...(mentionTarget ? { 'data-mention-target': 'true', 'aria-current': 'true' as const } : {})}
          {...(lifecycle === undefined ? {} : { 'data-member-presence': lifecycle.phase })}
          onClick={() => { if (presentation !== undefined) setInspector({ kind: 'identity', participantId: participant.id }) }}
        >
          <span className="cxa-member-avatar-seat">
            <HostAgentAvatar participant={participant} />
            {lifecycle === undefined ? null : <span
              className="cxa-member-presence-dot"
              data-presence={lifecycle.phase}
              title={lifecycle.label}
              aria-hidden="true"
            />}
          </span>
          <span className="cxa-member-copy"><span className="cxa-member-name">{participant.name}</span><span className="cxa-member-role">{memberRoleLabel}</span></span>
          {lifecycle === undefined ? null : <span className="cxa-visually-hidden">{lifecycle.label}</span>}
        </button></li>
      })}</ul>}
      </div>}
    </HostConversationRightInspector>}
    {inspector?.kind !== 'settings' ? null : <HostConversationRightInspector
      open={true}
      title={chinese ? '群聊设置' : 'Room settings'}
      closeLabel={chinese ? '关闭群聊设置' : 'Close room settings'}
      resizeLabel={chinese ? '调整详情栏宽度' : 'Resize inspector'}
      width={inspectorWidth}
      onWidthChange={setInspectorWidth}
      onOpenChange={open => { if (!open) closeInspector() }}
    >
      {roomSettings === undefined
        ? <><dl className="cxa-inspector-readonly"><dt>{chinese ? '群聊名称' : 'Room name'}</dt><dd>{title}</dd><dt>{chinese ? '群聊介绍' : 'Description'}</dt><dd>{description ?? (chinese ? '尚未添加' : 'Not added')}</dd></dl><p className="cxa-inspector-note">{chinese ? '当前数据源未提供群聊设置更新。' : 'The current source does not provide room settings updates.'}</p></>
        : <RoomSettingsEditor title={title} description={description} chinese={chinese} settings={roomSettings} onError={onCommandError} onDone={closeInspector} />}
    </HostConversationRightInspector>}
    <div className="cxa-live-region" role="status" aria-live="polite">{commandError ?? ''}</div>
  </section>
}
