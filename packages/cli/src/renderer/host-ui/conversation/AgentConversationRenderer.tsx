import * as React from 'react'
import { HostSurfaceIcon } from '../HostSurfaceIcon.js'
import { useAutoFollow } from '../useAutoFollow.js'
import type { AgentConversationCommandController } from './commands.js'
import {
  participantFor,
  participantInitials,
  type AgentConversationAction,
  type AgentConversationEntry,
  type AgentConversationMessage,
  type AgentConversationModel,
} from './model.js'
import { AGENT_CONVERSATION_STYLES } from './styles.js'

export interface AgentConversationRendererCopy {
  readonly locale: string
  readonly newRoomTitle: string
  readonly newRoomDescription: string
  readonly timelineLabel: string
  readonly composerLabel: string
  readonly sendLabel: string
  readonly running: string
  readonly stopped: string
  readonly failed: string
  readonly pending: string
  readonly unavailable: string
}

export interface AgentConversationRendererProps {
  readonly model: AgentConversationModel
  readonly commands: AgentConversationCommandController
  readonly copy: AgentConversationRendererCopy
  readonly debugFixture?: boolean
}

function stateCopy(message: AgentConversationMessage, copy: AgentConversationRendererCopy): string | undefined {
  if (message.runState === 'running') return copy.running
  if (message.runState === 'stopped') return copy.stopped
  if (message.runState === 'failed' || message.deliveryState === 'failed') return copy.failed
  if (message.deliveryState === 'pending') return copy.pending
  return undefined
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

function MessageEntry({
  entry, previous, model, commands, onCommandError, copy,
}: {
  readonly entry: AgentConversationMessage
  readonly previous: AgentConversationEntry | undefined
  readonly model: AgentConversationModel
  readonly commands: AgentConversationCommandController
  readonly onCommandError: (error: unknown) => void
  readonly copy: AgentConversationRendererCopy
}) {
  const labelId = React.useId()
  const participant = participantFor(model, entry.authorId)
  if (participant === undefined) return null
  const showInitials = model.selection.kind === 'room'
    && model.selection.multiParticipant
    && model.selection.participantPresentation === 'host-initials'
  const groupStart = previous?.kind !== 'message' || previous.authorId !== entry.authorId
  const state = stateCopy(entry, copy)
  return <article
    className="cxa-entry cxa-message"
    data-entry-id={entry.id}
    data-role={participant.role}
    data-group-start={String(groupStart)}
    data-delivery-state={entry.deliveryState}
    data-run-state={entry.runState}
    aria-labelledby={labelId}
    aria-live={entry.ariaLive}
  >
    {showInitials && participant.role !== 'human'
      ? <span className="cxa-avatar" aria-hidden="true">{participantInitials(participant.name)}</span>
      : null}
    <div className="cxa-message-content">
      <div className="cxa-message-meta" id={labelId}>
        <span className="cxa-author">{participant.name}</span>
        <time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleTimeString(copy.locale, { hour: '2-digit', minute: '2-digit' })}</time>
        {state === undefined ? null : <span className="cxa-message-state">{state}</span>}
      </div>
      <div className="cxa-message-body">{entry.body.map((block, index) => <p key={index}>{block}</p>)}</div>
      {entry.actions.length === 0 ? null : <div className="cxa-message-actions">
        {entry.actions.map(action => <ActionButton key={action.id} action={action} run={() => {
          void commands.runMessage(model, entry.id, action).catch(onCommandError)
        }} />)}
      </div>}
    </div>
  </article>
}

function Timeline({
  model, commands, copy, onCommandError,
}: Pick<AgentConversationRendererProps, 'model' | 'commands' | 'copy'> & { readonly onCommandError: (error: unknown) => void }) {
  const follow = useAutoFollow<HTMLDivElement>(`${model.bindingId}:${model.revision}:${model.entries.length}`)
  return <div ref={follow.ref} onScroll={follow.onScroll} className="cxa-timeline" data-agent-conversation-scroll-owner="timeline" role="log" aria-label={copy.timelineLabel} tabIndex={0}>
    {model.selection.kind === 'new-room' ? null : <div className="cxa-timeline-list">
      {model.entries.map((entry, index) => entry.kind === 'message'
        ? <MessageEntry key={entry.id} entry={entry} previous={model.entries[index - 1]} model={model} commands={commands} copy={copy} onCommandError={onCommandError} />
        : <div key={entry.id} className="cxa-entry cxa-status" data-entry-id={entry.id} data-state={entry.state} role="status" aria-live={entry.ariaLive}>
            <span className="cxa-status-dot" aria-hidden="true" /><span>{entry.label}</span>
          </div>)}
    </div>}
  </div>
}

function EmptyRoom({ model, commands, copy, onCommandError }: Pick<AgentConversationRendererProps, 'model' | 'commands' | 'copy'> & { readonly onCommandError: (error: unknown) => void }) {
  const newRoomAction = model.headerActions.find(action => action.id === 'new-room')
  return <div className="cxa-empty" data-agent-conversation-empty="true">
    <span className="cxa-empty-mark" aria-hidden="true">＋</span>
    <p className="cxa-empty-copy">{copy.newRoomDescription}</p>
    {newRoomAction === undefined ? null : <ActionButton action={newRoomAction} run={() => {
      void commands.runHeader(model, newRoomAction).catch(onCommandError)
    }} />}
  </div>
}

function Composer({
  model, commands, copy, commandError, setCommandError,
}: Pick<AgentConversationRendererProps, 'model' | 'commands' | 'copy'> & {
  readonly commandError: string | undefined
  readonly setCommandError: (value: string | undefined) => void
}) {
  const [draft, setDraft] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const noticeId = React.useId()
  React.useEffect(() => { setDraft(''); setCommandError(undefined) }, [model.bindingId, setCommandError])
  const unavailable = model.composer.availability !== 'available'
  const reason = commandError ?? model.composer.disabledReason ?? (unavailable ? copy.unavailable : undefined)
  const disabled = unavailable || model.composer.disabled || submitting || draft.trim() === ''
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
        className="cxa-draft"
        aria-label={copy.composerLabel}
        aria-describedby={reason === undefined ? undefined : noticeId}
        placeholder={model.composer.placeholder}
        value={draft}
        maxLength={65_536}
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

/** Production Host-owned conversation shell. It has no fixture dependency. */
export function AgentConversationRenderer({ model, commands, copy, debugFixture = false }: AgentConversationRendererProps) {
  const titleId = React.useId()
  const [commandError, setCommandErrorState] = React.useState<string | undefined>(undefined)
  const setCommandError = React.useCallback((value: string | undefined) => setCommandErrorState(value), [])
  const title = model.selection.kind === 'room' ? model.selection.title : copy.newRoomTitle
  const participantSummary = model.selection.kind === 'room'
    ? model.selection.participants.map(participant => participant.name).join(' · ')
    : undefined
  const headerActions = model.selection.kind === 'new-room'
    ? model.headerActions.filter(action => action.id !== 'new-room')
    : model.headerActions
  const onCommandError = React.useCallback((error: unknown) => {
    setCommandError(error instanceof Error ? error.message : String(error))
  }, [])
  return <section
    className="cxa-root"
    data-agent-conversation-renderer="production"
    data-agent-conversation-view={model.selection.kind}
    {...(debugFixture ? { 'data-agent-conversation-fixture': 'debug-only' } : {})}
    aria-labelledby={titleId}
  >
    <style data-agent-conversation-styles="production">{AGENT_CONVERSATION_STYLES}</style>
    <header className="cxa-chrome" data-agent-conversation-chrome="true">
      <div className="cxa-title-block">
        <h1 id={titleId} className="cxa-title">{title}</h1>
        {participantSummary === undefined || participantSummary === '' ? null : <span className="cxa-participants">{participantSummary}</span>}
      </div>
      {headerActions.length === 0 ? null : <div className="cxa-header-actions">
        {headerActions.map(action => <ActionButton key={action.id} action={action} run={() => {
          void commands.runHeader(model, action).catch(onCommandError)
        }} />)}
      </div>}
    </header>
    <div className="cxa-body">
      {model.selection.kind === 'new-room'
        ? <EmptyRoom model={model} commands={commands} copy={copy} onCommandError={onCommandError} />
        : <>
            <Timeline model={model} commands={commands} copy={copy} onCommandError={onCommandError} />
            <Composer model={model} commands={commands} copy={copy} commandError={commandError} setCommandError={setCommandError} />
          </>}
    </div>
    <div className="cxa-live-region" role="status" aria-live="polite">{commandError ?? ''}</div>
  </section>
}
