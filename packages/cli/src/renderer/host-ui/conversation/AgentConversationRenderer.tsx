import * as React from 'react'
import { HostSurfaceIcon } from '../HostSurfaceIcon.js'
import { useAutoFollow } from '../useAutoFollow.js'
import type { AgentConversationCommandController } from './commands.js'
import {
  participantFor,
  type AgentConversationAction,
  type AgentConversationEntry,
  type AgentConversationMessage,
  type AgentConversationModel,
} from './model.js'
import { AGENT_CONVERSATION_STYLES } from './styles.js'
import { HostAgentAvatar } from './AgentAvatar.js'
import type { HostAgentTaskDetailsNavigator } from '../AgentTaskDetailsNavigator.js'
import {
  createHostAgentIdentityPresentation,
  HostAgentIdentityAvatarButton,
  HostAgentIdentityPanel,
  type HostAgentIdentityPresentation,
} from './AgentIdentityPanel.js'
import { HostConversationRightInspector } from './RightInspector.js'
import { HostRoomCompositeAvatar } from './RoomCompositeAvatar.js'

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

type ConversationInspector =
  | Readonly<{ kind: 'members' | 'settings' | 'more' }>
  | Readonly<{ kind: 'identity'; participantId: string }>

function MessageEntry({
  entry, previous, model, commands, onCommandError, copy, identityPresentation, onOpenIdentity,
}: {
  readonly entry: AgentConversationMessage
  readonly previous: AgentConversationEntry | undefined
  readonly model: AgentConversationModel
  readonly commands: AgentConversationCommandController
  readonly onCommandError: (error: unknown) => void
  readonly copy: AgentConversationRendererCopy
  readonly identityPresentation?: HostAgentIdentityPresentation
  readonly onOpenIdentity: () => void
}) {
  const labelId = React.useId()
  const participant = participantFor(model, entry.authorId)
  if (participant === undefined) return null
  const showInitials = model.selection.kind === 'room'
    && model.selection.multiParticipant
    && model.selection.participantPresentation === 'host-initials'
  const showAgentAvatar = participant.role === 'agent'
    && (participant.avatar !== undefined || showInitials)
  const groupStart = previous?.kind !== 'message' || previous.authorId !== entry.authorId
  const state = stateCopy(entry, copy)
  const outgoing = participant.role === 'human'
  return <article
    className="cxa-entry cxa-message"
    data-entry-id={entry.itemId}
    data-role={participant.role}
    data-group-start={String(groupStart)}
    data-delivery-state={entry.deliveryState}
    data-run-state={entry.runState}
    {...(outgoing ? { 'aria-label': participant.name } : { 'aria-labelledby': labelId })}
    aria-live={entry.ariaLive}
  >
    {showAgentAvatar
      ? identityPresentation === undefined
        ? <HostAgentAvatar participant={participant} />
        : <HostAgentIdentityAvatarButton presentation={identityPresentation} label={`Open ${participant.name}`} onOpen={onOpenIdentity} />
      : null}
    <div className="cxa-message-content">
      {outgoing ? null : <div className="cxa-message-meta" id={labelId}>
          <span className="cxa-author">{participant.name}</span>
          <time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleTimeString(copy.locale, { hour: '2-digit', minute: '2-digit' })}</time>
        </div>}
      <div className="cxa-message-surface">
        <div className="cxa-message-body">{entry.body.map((block, index) => <p key={index}>{block}</p>)}</div>
        {outgoing || state === undefined ? null : <span className="cxa-message-state">{state}</span>}
        {!outgoing || entry.deliveryState !== 'failed' ? null : <span className="cxa-outgoing-error" role="status">{copy.failed}</span>}
        {(entry.reactions ?? []).length === 0 ? null : <div className="cxa-message-reactions" role="list" aria-label={copy.locale.toLowerCase().startsWith('zh') ? '消息反应' : 'Message reactions'}>
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
        </div>}
        {entry.actions.length === 0 ? null : <div className="cxa-message-actions">
          {entry.actions.map(action => <ActionButton key={action.id} action={action} run={() => {
            void commands.runMessage(model, entry.itemId, action).catch(onCommandError)
          }} />)}
        </div>}
      </div>
    </div>
  </article>
}

function Timeline({
  model, commands, copy, onCommandError, identityPresentations, onOpenIdentity,
}: Pick<AgentConversationRendererProps, 'model' | 'commands' | 'copy'> & {
  readonly onCommandError: (error: unknown) => void
  readonly identityPresentations: ReadonlyMap<string, HostAgentIdentityPresentation>
  readonly onOpenIdentity: (participantId: string) => void
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
            model={model}
            commands={commands}
            copy={copy}
            onCommandError={onCommandError}
            {...(identityPresentations.get(entry.authorId) === undefined ? {} : { identityPresentation: identityPresentations.get(entry.authorId)! })}
            onOpenIdentity={() => onOpenIdentity(entry.authorId)}
          />
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
  model, commands, copy, commandError, setCommandError,
}: Pick<AgentConversationRendererProps, 'model' | 'commands' | 'copy'> & {
  readonly commandError: string | undefined
  readonly setCommandError: (value: string | undefined) => void
}) {
  const [draft, setDraft] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const noticeId = React.useId()
  React.useEffect(() => { setDraft(''); setCommandError(undefined) }, [model.binding.bindingId, model.generation, setCommandError])
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
export function AgentConversationRenderer({ model, commands, copy, debugFixture = false, identity }: AgentConversationRendererProps) {
  const titleId = React.useId()
  const [commandError, setCommandErrorState] = React.useState<string | undefined>(undefined)
  const [inspector, setInspector] = React.useState<ConversationInspector | undefined>()
  const setCommandError = React.useCallback((value: string | undefined) => setCommandErrorState(value), [])
  const title = model.selection.kind === 'room' ? model.selection.title : copy.newRoomTitle
  // Shell v2 does not yet expose a Room description/update capability. Never
  // substitute participant names or a fixture subtitle for product data.
  const description: string | undefined = undefined
  const headerActions = model.headerActions
  const onCommandError = React.useCallback((error: unknown) => {
    setCommandError(error instanceof Error ? error.message : String(error))
  }, [])
  const identityPresentations = React.useMemo(() => {
    const output = new Map<string, HostAgentIdentityPresentation>()
    if (identity === undefined || model.selection.kind !== 'room') return output
    const roomTitle = model.selection.title
    for (const participant of model.selection.participants) {
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
        activeSessions: (model.selection.activeRuns ?? [])
          .filter(run => run.participantId === participant.id)
          .map(run => ({
            run,
            roomLabel: roomTitle,
            taskLabel: `${copy.locale.toLowerCase().startsWith('zh') ? 'Agent 任务' : 'Agent task'} · ${run.lifecycle.phase}`,
          })),
      }))
    }
    return output
  }, [copy.locale, identity, model.selection])
  React.useEffect(() => {
    if (inspector?.kind === 'identity' && !identityPresentations.has(inspector.participantId)) setInspector(undefined)
  }, [identityPresentations, inspector])
  const selectedIdentity = inspector?.kind === 'identity' ? identityPresentations.get(inspector.participantId) : undefined
  const chinese = copy.locale.toLowerCase().startsWith('zh')
  const participants = model.selection.kind === 'room' ? model.selection.participants : []
  const activeRuns = model.selection.kind === 'room' ? model.selection.activeRuns ?? [] : []
  const closeInspector = (): void => setInspector(undefined)
  const lifecycleFor = (participantId: string): string | undefined => {
    const phase = activeRuns.find(run => run.participantId === participantId)?.lifecycle.phase
    if (phase === undefined) return undefined
    return chinese
      ? ({ active: '可用', running: '运行中', waiting: '等待中', attention: '需处理' } as const)[phase]
      : ({ active: 'Available', running: 'Running', waiting: 'Waiting', attention: 'Needs attention' } as const)[phase]
  }
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
          onOpen={() => setInspector({ kind: 'members' })}
        /> : <span className="cxa-room-avatar" data-count="zero"><span className="cxa-room-avatar-fallback"><HostSurfaceIcon token="host:layers" /></span></span>}
        <div className="cxa-title-block">
          <h1 id={titleId} className="cxa-title">{title}</h1>
          {model.selection.kind !== 'room' ? null : <button type="button" className="cxa-description-action" onClick={() => setInspector({ kind: 'settings' })}>
            {description ?? (chinese ? '添加群聊介绍' : 'Add a room description')}
          </button>}
        </div>
        {model.selection.kind !== 'room' ? null : <div className="cxa-header-actions">
          <button type="button" className="cxa-header-icon-action" aria-label={chinese ? '群成员' : 'Members'} onClick={() => setInspector({ kind: 'members' })}><HostSurfaceIcon token="host:layers" /></button>
          <button type="button" className="cxa-header-icon-action" aria-label={chinese ? '设置' : 'Settings'} onClick={() => setInspector({ kind: 'settings' })}><HostSurfaceIcon token="host:settings" /></button>
          <button type="button" className="cxa-header-icon-action" aria-label={chinese ? '更多' : 'More'} onClick={() => setInspector({ kind: 'more' })}><HostSurfaceIcon token="host:more" /></button>
        </div>}
      </div>
    </header>
    <div className="cxa-body">
      <Timeline model={model} commands={commands} copy={copy} onCommandError={onCommandError} identityPresentations={identityPresentations} onOpenIdentity={participantId => setInspector({ kind: 'identity', participantId })} />
      <Composer model={model} commands={commands} copy={copy} commandError={commandError} setCommandError={setCommandError} />
    </div>
    {identity === undefined ? null : <HostAgentIdentityPanel
      open={selectedIdentity !== undefined}
      {...(selectedIdentity === undefined ? {} : { presentation: selectedIdentity })}
      navigator={identity.navigator}
      onOpenChange={open => { if (!open) closeInspector() }}
      onSettings={identity.onSettings}
      onNavigationError={onCommandError}
      copy={{
        settings: chinese ? '设置' : 'Settings',
        close: chinese ? '关闭' : 'Close',
        introduction: chinese ? '介绍' : 'Introduction',
        activeSessions: chinese ? '当前激活的会话' : 'Active sessions',
        noActiveSessions: chinese ? '当前没有激活会话' : 'No active sessions',
        sessionCount: count => chinese ? `${count} 个激活会话` : `${count} active session${count === 1 ? '' : 's'}`,
        lifecycle: {
          active: chinese ? '激活' : 'Active', running: chinese ? '运行中' : 'Running',
          waiting: chinese ? '等待中' : 'Waiting', attention: chinese ? '需处理' : 'Attention',
        },
      }}
    />}
    {inspector?.kind !== 'members' ? null : <HostConversationRightInspector
      open={true}
      title={chinese ? '群成员' : 'Members'}
      closeLabel={chinese ? '关闭群成员' : 'Close members'}
      onOpenChange={open => { if (!open) closeInspector() }}
    >
      <ul className="cxa-members-list">{participants.map(participant => {
        const presentation = identityPresentations.get(participant.id)
        const role = participant.role === 'agent'
          ? (chinese ? 'Agent' : 'Agent')
          : participant.role === 'human' ? (chinese ? '成员' : 'Member') : (chinese ? '系统' : 'System')
        return <li key={participant.id}><button
          type="button"
          className="cxa-member-button"
          disabled={presentation === undefined}
          onClick={() => { if (presentation !== undefined) setInspector({ kind: 'identity', participantId: participant.id }) }}
        >
          <HostAgentAvatar participant={participant} />
          <span className="cxa-member-copy"><span className="cxa-member-name">{participant.name}</span><span className="cxa-member-role">{role}</span></span>
          {lifecycleFor(participant.id) === undefined ? null : <span className="cxa-member-status">{lifecycleFor(participant.id)}</span>}
        </button></li>
      })}</ul>
    </HostConversationRightInspector>}
    {inspector?.kind !== 'settings' ? null : <HostConversationRightInspector
      open={true}
      title={chinese ? '群聊设置' : 'Room settings'}
      closeLabel={chinese ? '关闭群聊设置' : 'Close room settings'}
      onOpenChange={open => { if (!open) closeInspector() }}
    >
      <dl className="cxa-inspector-readonly"><dt>{chinese ? '群聊名称' : 'Room name'}</dt><dd>{title}</dd><dt>{chinese ? '群聊介绍' : 'Description'}</dt><dd>{description ?? (chinese ? '尚未添加' : 'Not added')}</dd></dl>
      <p className="cxa-inspector-note">{chinese ? '当前 Conversation Shell 尚未提供群聊介绍的结构化更新能力。' : 'The Conversation Shell does not yet expose a structured room-description update capability.'}</p>
    </HostConversationRightInspector>}
    {inspector?.kind !== 'more' ? null : <HostConversationRightInspector
      open={true}
      title={chinese ? '更多' : 'More'}
      closeLabel={chinese ? '关闭更多操作' : 'Close more actions'}
      onOpenChange={open => { if (!open) closeInspector() }}
    >
      {headerActions.length === 0 ? null : <div className="cxa-inspector-actions">{headerActions.map(action => <ActionButton key={action.id} action={action} run={() => {
        void commands.runHeader(model, action).then(closeInspector).catch(onCommandError)
      }} />)}</div>}
    </HostConversationRightInspector>}
    <div className="cxa-live-region" role="status" aria-live="polite">{commandError ?? ''}</div>
  </section>
}
