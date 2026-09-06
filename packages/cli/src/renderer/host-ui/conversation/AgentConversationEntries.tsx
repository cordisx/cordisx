import * as React from 'react'
import { HostSurfaceIcon } from '../HostSurfaceIcon.js'
import { useAutoFollow } from '../useAutoFollow.js'
import { HostAgentAvatar } from './AgentAvatar.js'
import type { AgentConversationCommandController } from './commands.js'
import type { AgentConversationRendererCopy, AgentConversationRendererProps } from './AgentConversationRenderer.js'
import type { HostAgentIdentityPresentation } from './AgentIdentityPanel.js'
import {
  ApprovalEntry,
  type ComposerMentionRequest,
  type ConversationContextTarget,
  MessageHoverActions,
  MessageText,
  reactionStateCopy,
  stateCopy,
} from './AgentConversationInteractions.js'
import type { AgentConversationEntry, AgentConversationMessage, AgentConversationModel } from './model.js'
import { participantFor } from './model.js'
import { useHostShikitorComposer } from './ShikitorComposerAdapter.js'

export function MessageEntry({
  entry,
  previous,
  next,
  model,
  commands,
  onCommandError,
  copy,
  mentionPresentations,
  onOpenMention,
  onMentionParticipant,
  onOpenContextMenu,
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
  const openPointerContextMenu = (
    kind: ConversationContextTarget['kind'],
    event: React.MouseEvent<HTMLElement>,
  ): void => {
    event.preventDefault()
    event.stopPropagation()
    onOpenContextMenu(contextTarget(kind, event.clientX, event.clientY, event.currentTarget))
  }
  const openKeyboardContextMenu = (
    kind: ConversationContextTarget['kind'],
    event: React.KeyboardEvent<HTMLElement>,
  ): void => {
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
  const messageReactions = (entry.reactions ?? []).length === 0
    ? null
    : (
      <div
        className="cxa-message-reactions"
        role="list"
        aria-label={copy.locale.toLowerCase().startsWith('zh') ? '消息反应' : 'Message reactions'}
      >
        {(entry.reactions ?? []).map(reaction => {
          const actor = participantFor(model, reaction.actorParticipantId)
          const actorName = actor?.name
            ?? (copy.locale.toLowerCase().startsWith('zh') ? '未知参与者' : 'Unknown participant')
          const value = reaction.value.kind === 'emoji' ? reaction.value.emoji : reaction.value.token
          const state = reactionStateCopy(reaction.state, copy.locale)
          return (
            <span
              key={reaction.reactionId}
              className="cxa-message-reaction"
              data-reaction-state={reaction.state}
              role="listitem"
              aria-label={copy.locale.toLowerCase().startsWith('zh')
                ? `${actorName} 的反应：${value}，${state}`
                : `${actorName}'s reaction: ${value}, ${state}`}
            >
              {actor === undefined ? null : (
                <span className="cxa-message-reaction-avatar">
                  <HostAgentAvatar participant={actor} />
                </span>
              )}
              <span className="cxa-message-reaction-actor">{actorName}</span>
              <span className="cxa-message-reaction-value">{value}</span>
            </span>
          )
        })}
      </div>
    )
  const messageSurface = (
    <div
      className="cxa-message-surface"
      tabIndex={0}
      aria-label={accessibleLabel}
      onContextMenu={event => openPointerContextMenu('message', event)}
      onKeyDown={event => openKeyboardContextMenu('message', event)}
    >
      <div className="cxa-message-body">
        {entry.body.map((block, index) => (
          <p key={index}>
            <MessageText text={block} mentions={mentionPresentations} onOpenMention={onOpenMention} />
          </p>
        ))}
      </div>
      {outgoing || state === undefined ? null : <span className="cxa-message-state">{state}</span>}
      {!outgoing || entry.deliveryState !== 'failed'
        ? null
        : <span className="cxa-outgoing-error" role="status">{copy.failed}</span>}
    </div>
  )
  const avatarSeatEmpty = !groupEnd || !showAgentAvatar
  const identityPresentation = mentionPresentations.find(candidate => candidate.participantId === participant.id)
    ?.presentation
  const avatarSeat = participant.role !== 'agent' ? null : (
    <span
      className="cxa-message-avatar-seat"
      data-avatar-seat={avatarSeatEmpty ? 'placeholder' : 'visible'}
      {...(avatarSeatEmpty ? { 'aria-hidden': true, inert: true } : {})}
    >
      {avatarSeatEmpty
        ? null
        : identityPresentation === undefined
        ? <HostAgentAvatar participant={participant} />
        : (
          <button
            type="button"
            className="cx-agent-identity-avatar-button"
            aria-label={copy.locale.toLowerCase().startsWith('zh')
              ? `查看 ${participant.name}`
              : `Open ${participant.name}`}
            onClick={() => onOpenMention(entry.authorId)}
            onContextMenu={event => openPointerContextMenu('avatar', event)}
            onKeyDown={event => openKeyboardContextMenu('avatar', event)}
          >
            <HostAgentAvatar participant={participant} />
          </button>
        )}
    </span>
  )
  return (
    <article
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
        {outgoing ? null : (
          <div className="cxa-message-meta">
            {groupStart
              ? (
                <button
                  type="button"
                  className="cxa-author cxa-author-button"
                  aria-label={copy.locale.toLowerCase().startsWith('zh')
                    ? `@提及 ${participant.name}`
                    : `Mention @${participant.name}`}
                  onClick={() => onMentionParticipant(participant.id)}
                >
                  {participant.name}
                </button>
              )
              : null}
            {timestamp}
          </div>
        )}
        <div className="cxa-message-bubble-row">
          {avatarSeat}
          <div className="cxa-message-bubble-shell">
            <div className="cxa-message-bubble-anchor">
              {outgoing ? timestamp : null}
              {messageSurface}
              <MessageHoverActions
                entry={entry}
                model={model}
                commands={commands}
                copy={copy}
                onCommandError={onCommandError}
              />
            </div>
            {messageReactions}
          </div>
        </div>
      </div>
    </article>
  )
}

export function Timeline({
  model,
  commands,
  copy,
  onCommandError,
  mentionPresentations,
  onOpenMention,
  onMentionParticipant,
  onOpenContextMenu,
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
  const follow = useAutoFollow<HTMLDivElement>(
    `${model.binding.bindingId}:${model.generation}:${model.snapshotSequence}:${model.entries.length}`,
  )
  const presence = (entry: Extract<AgentConversationEntry, { kind: 'member-presence' }>): string => {
    const name = participantFor(model, entry.participantId)?.name ?? entry.participantId
    const chinese = copy.locale.toLowerCase().startsWith('zh')
    if (entry.state === 'inviting') return chinese ? `正在邀请 ${name} 加入…` : `Inviting ${name}…`
    if (entry.state === 'creating') return chinese ? `正在为 ${name} 创建会话…` : `Creating a session for ${name}…`
    if (entry.state === 'joined') return chinese ? `${name} 已加入群聊` : `${name} joined the room`
    if (entry.state === 'ready') return chinese ? `${name} 已准备好` : `${name} is ready`
    return chinese ? `${name} 加入失败` : `${name} failed to join`
  }
  return (
    <div
      ref={follow.ref}
      onScroll={follow.onScroll}
      className="cxa-timeline"
      data-agent-conversation-scroll-owner="timeline"
      role="log"
      aria-label={copy.timelineLabel}
      tabIndex={0}
    >
      <div className="cxa-timeline-list">
        {model.entries.map((entry, index) =>
          entry.kind === 'message'
            ? (
              <MessageEntry
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
            )
            : entry.kind === 'approval'
            ? (
              <ApprovalEntry
                key={entry.itemId}
                entry={entry}
                model={model}
                commands={commands}
                copy={copy}
                onCommandError={onCommandError}
                onOpenMention={onOpenMention}
                onMentionParticipant={onMentionParticipant}
                onOpenContextMenu={onOpenContextMenu}
              />
            )
            : entry.kind === 'member-presence'
            ? (
              <div
                key={entry.itemId}
                className="cxa-entry cxa-status"
                data-entry-id={entry.itemId}
                data-state={entry.state}
                role="status"
                aria-live="polite"
              >
                <span className="cxa-status-dot" aria-hidden="true" />
                <span>{presence(entry)}</span>
              </div>
            )
            : (
              <div
                key={entry.itemId}
                className="cxa-entry cxa-status"
                data-entry-id={entry.itemId}
                data-state={entry.state}
                role="status"
                aria-live={entry.ariaLive}
              >
                <span className="cxa-status-dot" aria-hidden="true" />
                <span>{entry.label}</span>
              </div>
            )
        )}
      </div>
    </div>
  )
}

export function Composer({
  model,
  commands,
  copy,
  setCommandError,
  mentionRequest,
}: Pick<AgentConversationRendererProps, 'model' | 'commands' | 'copy'> & {
  readonly setCommandError: (value: string | undefined) => void
  readonly mentionRequest: ComposerMentionRequest | undefined
}) {
  const [draft, setDraft] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const submittingRef = React.useRef(false)
  const noticeId = React.useId()
  const chinese = copy.locale.toLowerCase().startsWith('zh')
  const attachmentUnavailableLabel = chinese ? '添加附件（暂不可用）' : 'Add attachment (unavailable)'
  React.useEffect(() => {
    setDraft('')
    setCommandError(undefined)
  }, [model.binding.bindingId, model.generation, setCommandError])
  const unavailable = model.composer.availability !== 'available'
  const reason = model.composer.disabledReason ?? (unavailable ? copy.unavailable : undefined)
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
    return () => {
      if (view !== undefined && frame !== undefined) view.cancelAnimationFrame(frame)
    }
  }, [inputRef, mentionRequest, unavailable])
  const submit = async (): Promise<void> => {
    if (disabled || submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setCommandError(undefined)
    try {
      await commands.runComposer(model, draft)
      setDraft('')
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }
  return (
    <div className="cxa-composer-region" data-agent-conversation-composer="fixed">
      <form
        className="cxa-composer"
        aria-label={copy.composerLabel}
        onSubmit={event => {
          event.preventDefault()
          void submit()
        }}
      >
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
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            const shouldSubmit = model.composer.shortcutPolicy === 'enter'
              ? !event.shiftKey
              : event.metaKey || event.ctrlKey
            if (!shouldSubmit) return
            event.preventDefault()
            void submit()
          }}
        />
        <div className="cxa-composer-footer">
          <button
            type="button"
            className="cxa-attachment-placeholder"
            disabled
            aria-label={attachmentUnavailableLabel}
            title={attachmentUnavailableLabel}
            data-host-composer-attachment="unavailable"
          >
            <HostSurfaceIcon token="host:new" />
          </button>
          <p id={noticeId} className="cxa-composer-notice">{reason ?? ''}</p>
          <button
            type="submit"
            className="cxa-send"
            disabled={disabled}
            aria-describedby={reason === undefined ? undefined : noticeId}
            aria-label={copy.sendLabel}
          >
            ↑
          </button>
        </div>
      </form>
    </div>
  )
}

export function RoomSettingsEditor({ title, description, chinese, settings, onError, onDone }: {
  readonly title: string
  readonly description: string | undefined
  readonly chinese: boolean
  readonly settings: NonNullable<AgentConversationRendererProps['roomSettings']>
  readonly onError: (error: unknown) => void
  readonly onDone: () => void
}) {
  const [name, setName] = React.useState(title)
  const [details, setDetails] = React.useState(description ?? '')
  const [saving, setSaving] = React.useState(false)
  React.useEffect(() => {
    setName(title)
    setDetails(description ?? '')
  }, [description, title])
  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const normalizedName = name.trim()
    const normalizedDetails = details.trim()
    if (normalizedName === '') {
      onError(new Error(chinese ? '群聊名称不能为空。' : 'Room name is required.'))
      return
    }
    setSaving(true)
    try {
      await settings.update({
        name: normalizedName,
        description: normalizedDetails === ''
          ? { state: 'empty' }
          : { state: 'present', text: normalizedDetails },
      })
      onDone()
    } catch (error) {
      onError(error)
    } finally {
      setSaving(false)
    }
  }
  return (
    <form className="cxa-room-settings-form" onSubmit={event => void submit(event)}>
      <label>
        <span>{chinese ? '群聊名称' : 'Room name'}</span>
        <input
          name="name"
          value={name}
          required
          maxLength={256}
          disabled={saving}
          onInput={event => setName(event.currentTarget.value)}
        />
      </label>
      <label>
        <span>{chinese ? '群聊介绍' : 'Description'}</span>
        <textarea
          name="description"
          value={details}
          maxLength={4_000}
          disabled={saving}
          onInput={event => setDetails(event.currentTarget.value)}
        />
      </label>
      <button type="submit" className="cxa-action" disabled={saving || name.trim() === ''}>
        {saving ? (chinese ? '保存中…' : 'Saving…') : (chinese ? '保存' : 'Save')}
      </button>
    </form>
  )
}

/** Production Host-owned conversation shell. It has no fixture dependency. */
