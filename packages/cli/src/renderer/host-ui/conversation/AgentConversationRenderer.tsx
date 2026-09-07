import * as React from 'react'
import type { AgentConversationCommandController } from './commands.js'
import type { AgentConversationActiveRun, AgentConversationModel } from './model.js'
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
import { HOST_ROOM_COMPOSITE_AVATAR_STYLES } from '../RoomCompositeAvatar.js'
import type { HostNavigationCollectionAction } from '../NavigationCollectionActions.js'
import { HostRoomCompositeAvatar } from './RoomCompositeAvatar.js'
import { PLAYGROUND_ROOM_SIMULATION_BINDING_CONTRACT } from '../../playground-room-simulation-bridge.js'
import { HostSurfaceIcon } from '../HostSurfaceIcon.js'
import {
  type ComposerMentionRequest,
  ConversationContextMenu,
  type ConversationContextTarget,
  type ConversationInspector,
  HeaderMoreMenu,
  identityMentionAliases,
} from './AgentConversationInteractions.js'
import { Composer, RoomSettingsEditor, Timeline } from './AgentConversationEntries.js'

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
  readonly navigationActions?: readonly HostNavigationCollectionAction[]
  readonly identity?: {
    readonly resolve: (
      identity: { readonly agentId: string; readonly revision: string },
      ownerId?: string,
    ) => {
      readonly identity: { readonly agentId: string; readonly revision: string }
      readonly name: string
      readonly introduction: string
    } | undefined
    readonly resolveSettings?: (
      identity: { readonly agentId: string; readonly revision: string },
      ownerId?: string,
    ) => { readonly available: boolean; readonly reason?: string }
    readonly openDetail?: (
      ownerId: string,
      target: import('@cordisx/protocol/agents/v1').AgentDetailReference,
    ) => Promise<void>
    readonly navigator: HostAgentTaskDetailsNavigator
    readonly onSettings: (identity: { readonly agentId: string; readonly revision: string }) => void | Promise<void>
  }
  readonly roomSettings?: {
    readonly update: (
      patch: {
        readonly name?: string
        readonly description?: { readonly state: 'empty' } | { readonly state: 'present'; readonly text: string }
      },
    ) => Promise<void>
  }
}

export function AgentConversationRenderer(
  {
    model,
    commands,
    copy,
    debugFixture = false,
    navigationActions = [],
    identity,
    roomSettings,
  }: AgentConversationRendererProps,
) {
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
  const commandErrorTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const setCommandError = React.useCallback((value: string | undefined) => {
    if (commandErrorTimer.current !== undefined) {
      clearTimeout(commandErrorTimer.current)
      commandErrorTimer.current = undefined
    }
    setCommandErrorState(value)
    if (value !== undefined) {
      commandErrorTimer.current = setTimeout(() => {
        commandErrorTimer.current = undefined
        setCommandErrorState(undefined)
      }, 6_000)
    }
  }, [])
  React.useEffect(() => () => {
    if (commandErrorTimer.current !== undefined) clearTimeout(commandErrorTimer.current)
  }, [])
  React.useEffect(() => {
    setCommandError(undefined)
  }, [model.binding.bindingId, model.generation, setCommandError])
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
      const effective = identity.resolve(participant.agentIdentity, model.ownerId)
      if (effective === undefined) continue
      output.set(
        participant.id,
        createHostAgentIdentityPresentation({
          participant: {
            participantId: participant.id,
            role: 'agent',
            displayName: { key: 'host.agent.identity.name', fallback: participant.name },
            ...(participant.avatar === undefined ? {} : { avatar: participant.avatar }),
            agentIdentity: participant.agentIdentity,
          },
          name: effective.name,
          introduction: effective.introduction,
          associatedSessions: (roomSelection.associatedSessions ?? [])
            .filter(association => association.participantId === participant.id)
            .map(association => ({ association, roomLabel: roomTitle })),
          activeSessions: (roomSelection.activeRuns ?? [])
            .filter(run => run.participantId === participant.id)
            .map(run => ({
              run,
              roomLabel: roomTitle,
              taskLabel: `${
                copy.locale.toLowerCase().startsWith('zh') ? 'Agent 任务' : 'Agent task'
              } · ${run.lifecycle.phase}`,
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
        }),
      )
    }
    return output
  }, [copy.locale, identity, model.selection, model.ownerId])
  const mentionPresentations = React.useMemo(
    () => identityMentionAliases(model, identityPresentations),
    [identityPresentations, model],
  )
  React.useEffect(() => {
    if (inspector?.kind === 'identity' && !identityPresentations.has(inspector.participantId)) setInspector(undefined)
  }, [identityPresentations, inspector])
  const selectedIdentity = inspector?.kind === 'identity'
    ? identityPresentations.get(inspector.participantId)
    : undefined
  const chinese = copy.locale.toLowerCase().startsWith('zh')
  const identityCopy: HostAgentIdentityPanelCopy = {
    settings: chinese ? '设置' : 'Settings',
    close: chinese ? '关闭' : 'Close',
    members: chinese ? '群成员' : 'Members',
    backToMembers: chinese ? '返回群成员' : 'Back to members',
    hierarchyNavigation: chinese ? '详情栏层级导航' : 'Inspector hierarchy',
    introduction: chinese ? '介绍' : 'Introduction',
    activeSessions: chinese ? '当前已加载的会话' : 'Loaded sessions',
    associatedSessions: chinese ? '关联会话' : 'Associated sessions',
    unloadedSession: chinese ? '未加载 · 运行状态未知' : 'Not loaded · Running state unknown',
    noActiveSessions: chinese ? '当前没有已加载会话' : 'No loaded sessions',
    sessionCount: count => chinese ? `${count} 个激活会话` : `${count} active session${count === 1 ? '' : 's'}`,
    lifecycle: {
      active: chinese ? '激活' : 'Active',
      running: chinese ? '运行中' : 'Running',
      waiting: chinese ? '等待中' : 'Waiting',
      attention: chinese ? '需处理' : 'Attention',
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
  const lifecycleFor = (participantId: string):
    | Readonly<{
      phase: AgentConversationActiveRun['lifecycle']['phase']
      label: string
    }>
    | undefined =>
  {
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
    : memberAgents.filter(participant =>
      participant.name.toLocaleLowerCase().includes(normalizedMemberSearch)
      || memberRoleLabel.toLocaleLowerCase().includes(normalizedMemberSearch)
    )
  return (
    <section
      className="cxa-root"
      data-agent-conversation-renderer="production"
      data-agent-conversation-view={model.selection.kind}
      {...(model.selection.kind === 'room' ? { 'data-agent-conversation-room-id': model.selection.roomId } : {})}
      {...(debugFixture ? { 'data-agent-conversation-fixture': 'debug-only' } : {})}
      aria-labelledby={titleId}
    >
      <style data-agent-conversation-styles="production">
        {`${AGENT_CONVERSATION_STYLES}\n${HOST_ROOM_COMPOSITE_AVATAR_STYLES}`}
      </style>
      <header className="cxa-chrome" data-agent-conversation-chrome="true">
        <div className="cxa-chrome-inner">
          {model.selection.kind === 'room'
            ? (
              <HostRoomCompositeAvatar
                participants={participants}
                size="header"
                label={chinese ? '打开群成员' : 'Open room members'}
                moreLabel={count => chinese ? `查看其余 ${count} 位群成员` : `View ${count} more room members`}
                onOpen={openMembersInspector}
              />
            )
            : (
              <span className="cxa-room-avatar" data-count="zero">
                <span className="cxa-room-avatar-fallback">
                  <HostSurfaceIcon token="host:layers" />
                </span>
              </span>
            )}
          <div className="cxa-title-block">
            <h1 id={titleId} className="cxa-title">{title}</h1>
            {model.selection.kind !== 'room'
              ? null
              : (
                <button
                  type="button"
                  className="cxa-description-action"
                  onClick={() => setInspector({ kind: 'settings' })}
                >
                  {description ?? (chinese ? '添加群聊介绍' : 'Add a room description')}
                </button>
              )}
          </div>
          {model.selection.kind !== 'room' ? null : (
            <div className="cxa-header-actions">
              <button
                type="button"
                className="cxa-header-icon-action"
                aria-label={chinese ? '群成员' : 'Members'}
                onClick={openMembersInspector}
              >
                <HostSurfaceIcon token="host:layers" />
              </button>
              <button
                type="button"
                className="cxa-header-icon-action"
                aria-label={chinese ? '设置' : 'Settings'}
                onClick={() => setInspector({ kind: 'settings' })}
              >
                <HostSurfaceIcon token="host:settings" />
              </button>
              <span
                className="cxa-header-plugin-actions"
                data-host-conversation-header-action-slot="v1"
                data-host-conversation-header-action-inline-limit="2"
              >
                {inlineHeaderActions.map(action => (
                  <button
                    key={action.id}
                    type="button"
                    className="cxa-header-icon-action cxa-header-plugin-action"
                    aria-label={action.label}
                    disabled={action.disabled}
                    title={action.disabledReason}
                    data-host-conversation-header-action-id={action.id}
                    onClick={() => {
                      void commands.runHeader(model, action).catch(onCommandError)
                    }}
                  >
                    <HostSurfaceIcon token={action.icon!} />
                  </button>
                ))}
              </span>
              <HeaderMoreMenu
                actions={overflowHeaderActions}
                navigationActions={navigationActions}
                model={model}
                commands={commands}
                copy={copy}
                onCommandError={onCommandError}
              />
            </div>
          )}
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
          setCommandError={setCommandError}
          mentionRequest={mentionRequest}
        />
      </div>
      {contextMenuTarget === undefined ? null : (
        <ConversationContextMenu
          target={contextMenuTarget}
          chinese={chinese}
          onClose={() => setContextMenuTarget(undefined)}
          onMention={mentionParticipant}
          onOpenParticipant={openMentionInspector}
          onError={onCommandError}
        />
      )}
      {!memberInspectorOpen ? null : (
        <HostConversationRightInspector
          open={true}
          title={memberInspectorIdentity?.name ?? (chinese ? '群成员' : 'Members')}
          closeLabel={memberInspectorIdentity === undefined
            ? (chinese ? '关闭群成员' : 'Close members')
            : identityCopy.close}
          resizeLabel={chinese ? '调整详情栏宽度' : 'Resize inspector'}
          width={inspectorWidth}
          onWidthChange={setInspectorWidth}
          pageKey={memberInspectorIdentity === undefined
            ? 'members'
            : `identity:${memberInspectorIdentity.participant.participantId}`}
          {...(memberInspectorIdentity === undefined
            ? {
              leading: <HostSurfaceIcon token="host:layers" />,
            }
            : {
              breadcrumb: {
                parentLabel: identityCopy.members ?? (chinese ? '群成员' : 'Members'),
                backLabel: identityCopy.backToMembers ?? (chinese ? '返回群成员' : 'Back to members'),
                navigationLabel: identityCopy.hierarchyNavigation
                  ?? (chinese ? '详情栏层级导航' : 'Inspector hierarchy'),
                onBack: () => setInspector({ kind: 'members' }),
              },
              describedBy: `${identityContentId}-introduction`,
            })}
          onOpenChange={open => {
            if (!open) closeInspector()
          }}
        >
          {memberInspectorIdentity !== undefined && identity !== undefined
            ? (
              <HostAgentIdentityContent
                presentation={memberInspectorIdentity}
                copy={identityCopy}
                navigator={identity.navigator}
                {...(identity.openDetail === undefined ? {} : {
                  onOpenDetail: target => identity.openDetail!(model.ownerId, target),
                })}
                onClose={closeInspector}
                {...(identity.resolveSettings === undefined ? {} : { resolveSettings: identity.resolveSettings })}
                onSettings={identity.onSettings}
                onNavigationError={onCommandError}
                idPrefix={identityContentId}
              />
            )
            : (
              <div
                className="cxa-members-panel"
                {...(memberTargetParticipant === undefined ? {} : {
                  'data-mention-target-participant-id': memberTargetParticipant.id,
                  'aria-label': `${
                    chinese ? '消息提及目标' : 'Message mention target'
                  }: ${memberTargetParticipant.name}`,
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
                  {memberSearch === '' ? null : (
                    <button
                      type="button"
                      aria-label={chinese ? '清除成员搜索' : 'Clear member search'}
                      title={chinese ? '清除' : 'Clear'}
                      onClick={() => {
                        setMemberSearch('')
                        setMemberTargetParticipantId(undefined)
                        memberSearchRef.current?.focus()
                      }}
                    >
                      <HostSurfaceIcon token="host:close" />
                    </button>
                  )}
                </div>
                {memberTargetParticipant === undefined ? null : (
                  <p
                    className="cxa-inspector-note"
                    role="status"
                    data-mention-target-participant-id={memberTargetParticipant.id}
                  >
                    {chinese
                      ? `已定位到消息中提及的成员：${memberTargetParticipant.name}`
                      : `Showing the member mentioned in the message: ${memberTargetParticipant.name}`}
                  </p>
                )}
                {visibleMemberAgents.length === 0
                  ? (
                    <p className="cxa-members-empty" role="status">
                      {normalizedMemberSearch === ''
                        ? (chinese ? '暂无协作 Agent' : 'No collaborative agents')
                        : (chinese ? '未找到成员' : 'No members found')}
                    </p>
                  )
                  : (
                    <ul className="cxa-members-list">
                      {visibleMemberAgents.map(participant => {
                        const presentation = identityPresentations.get(participant.id)
                        const lifecycle = lifecycleFor(participant.id)
                        const mentionTarget = memberTargetParticipantId === participant.id
                        return (
                          <li key={participant.id}>
                            <button
                              type="button"
                              className="cxa-member-button"
                              disabled={presentation === undefined}
                              {...(mentionTarget
                                ? { 'data-mention-target': 'true', 'aria-current': 'true' as const }
                                : {})}
                              {...(lifecycle === undefined ? {} : { 'data-member-presence': lifecycle.phase })}
                              onClick={() => {
                                if (presentation !== undefined) {
                                  setInspector({ kind: 'identity', participantId: participant.id })
                                }
                              }}
                            >
                              <span className="cxa-member-avatar-seat">
                                <HostAgentAvatar participant={participant} />
                                {lifecycle === undefined ? null : (
                                  <span
                                    className="cxa-member-presence-dot"
                                    data-presence={lifecycle.phase}
                                    title={lifecycle.label}
                                    aria-hidden="true"
                                  />
                                )}
                              </span>
                              <span className="cxa-member-copy">
                                <span className="cxa-member-name">{participant.name}</span>
                                <span className="cxa-member-role">{memberRoleLabel}</span>
                              </span>
                              {lifecycle === undefined
                                ? null
                                : <span className="cxa-visually-hidden">{lifecycle.label}</span>}
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
              </div>
            )}
        </HostConversationRightInspector>
      )}
      {inspector?.kind !== 'settings' ? null : (
        <HostConversationRightInspector
          open={true}
          title={chinese ? '群聊设置' : 'Room settings'}
          closeLabel={chinese ? '关闭群聊设置' : 'Close room settings'}
          resizeLabel={chinese ? '调整详情栏宽度' : 'Resize inspector'}
          width={inspectorWidth}
          onWidthChange={setInspectorWidth}
          onOpenChange={open => {
            if (!open) closeInspector()
          }}
        >
          {roomSettings === undefined
            ? (
              <>
                <dl className="cxa-inspector-readonly">
                  <dt>{chinese ? '群聊名称' : 'Room name'}</dt>
                  <dd>{title}</dd>
                  <dt>{chinese ? '群聊介绍' : 'Description'}</dt>
                  <dd>{description ?? (chinese ? '尚未添加' : 'Not added')}</dd>
                </dl>
                <p className="cxa-inspector-note">
                  {chinese
                    ? '当前数据源未提供群聊设置更新。'
                    : 'The current source does not provide room settings updates.'}
                </p>
              </>
            )
            : (
              <RoomSettingsEditor
                title={title}
                description={description}
                chinese={chinese}
                settings={roomSettings}
                onError={onCommandError}
                onDone={closeInspector}
              />
            )}
        </HostConversationRightInspector>
      )}
      {commandError === undefined
        ? null
        : (
          <div className="cxa-command-notification" role="alert" aria-live="assertive">
            <span>{commandError}</span>
            <button
              type="button"
              aria-label={chinese ? '关闭通知' : 'Dismiss notification'}
              title={chinese ? '关闭通知' : 'Dismiss notification'}
              onClick={() => setCommandError(undefined)}
            >
              <HostSurfaceIcon token="host:close" />
            </button>
          </div>
        )}
    </section>
  )
}
