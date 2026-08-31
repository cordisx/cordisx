import { cloneAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import type {
  AgentConversationActiveRunDescriptor,
  AgentConversationParticipant,
  AgentConversationSelection,
} from '@cordisx/protocol/agent-conversation-shell/v2'
import type { AgentDefinitionIdentity } from '@cordisx/protocol/agent-loop/v2'
import * as React from 'react'
import { HostSurfaceIcon } from '../HostSurfaceIcon.js'
import {
  HostAgentTaskDetailsNavigator,
  validateAgentLoopTaskDetailsUrl,
} from '../AgentTaskDetailsNavigator.js'
import { HostAgentAvatar } from './AgentAvatar.js'
import { HostConversationRightInspector } from './RightInspector.js'

export type HostAgentIdentitySessionLifecycle = AgentConversationActiveRunDescriptor['lifecycle']['phase']
export type HostAgentDefinitionIdentityPresentation = Readonly<AgentDefinitionIdentity>

export interface HostAgentIdentitySessionPresentation {
  /** Exact descriptor from the room snapshot's top-level activeRuns array. */
  readonly run: AgentConversationActiveRunDescriptor
  readonly roomLabel: string
  readonly taskLabel: string
}

export interface HostAgentIdentityPresentation {
  /** Exact participant selected from the current formal Shell v2 snapshot. */
  readonly participant: AgentConversationParticipant
  /** Host-localized displayName projection. */
  readonly name: string
  /** Effective AgentDefinition introduction supplied by the Host projection. */
  readonly introduction: string
  /** Host presentation of the snapshot's atomic activeRuns filtered by exact participantId. */
  readonly activeSessions: readonly HostAgentIdentitySessionPresentation[]
}

export interface HostEffectiveAgentIdentityProjection {
  readonly identity: AgentDefinitionIdentity
  readonly name: string
  readonly introduction: string
}

export interface HostAgentIdentitySessionLabels {
  readonly roomLabel: string
  readonly taskLabel: string
}

export interface HostAgentIdentityPanelCopy {
  readonly settings: string
  readonly close: string
  readonly introduction: string
  readonly activeSessions: string
  readonly noActiveSessions: string
  readonly sessionCount: (count: number) => string
  readonly lifecycle: Readonly<Record<HostAgentIdentitySessionLifecycle, string>>
}

export interface HostAgentIdentityPanelProps {
  readonly open: boolean
  readonly presentation?: HostAgentIdentityPresentation
  readonly copy: HostAgentIdentityPanelCopy
  readonly navigator: HostAgentTaskDetailsNavigator
  readonly onOpenChange: (open: boolean) => void
  readonly onSettings: (identity: HostAgentDefinitionIdentityPresentation) => void | Promise<void>
  readonly onNavigationError?: (error: unknown) => void
}

export interface HostAgentIdentityAvatarButtonProps {
  readonly presentation: HostAgentIdentityPresentation
  readonly label: string
  readonly onOpen: () => void
}

const HANDLE_PATTERN = /^[^\u0000-\u001f\u007f]{1,512}$/u
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const PANEL_STYLES = `
.cx-agent-identity-avatar-seat{display:grid;width:44px;height:44px;overflow:hidden;place-items:center;border-radius:50%;background:var(--cx-hover)}
.cx-agent-identity-avatar-seat .cxa-avatar{display:inline-grid;width:44px;height:44px;overflow:hidden;place-items:center;border:1px solid color-mix(in srgb,var(--cx-primary) 30%,var(--cx-border));border-radius:50%;background:color-mix(in srgb,var(--cx-primary) 10%,var(--cx-surface));font:700 13px/1 inherit}
.cx-agent-identity-avatar-seat .cxa-avatar-initials{display:inline-grid;width:100%;height:100%;place-items:center}.cx-agent-identity-avatar-seat .cxa-avatar-renderer{width:100%;height:100%}
.cx-agent-identity-body{min-height:0}.cx-agent-identity-section+.cx-agent-identity-section{margin-top:24px}.cx-agent-identity-section h3{margin:0 0 10px;font-size:12px;line-height:18px;color:var(--cx-muted);letter-spacing:.02em}.cx-agent-identity-introduction{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55}
.cx-agent-identity-sessions{display:grid;gap:8px;margin:0;padding:0;list-style:none}.cx-agent-identity-session{display:grid;width:100%;min-width:0;grid-template-columns:minmax(0,1fr) auto;gap:5px 12px;padding:11px 12px;text-align:left;border:1px solid var(--cx-border);border-radius:11px;background:var(--cx-surface-raised,var(--cx-surface));color:var(--cx-text);cursor:pointer}.cx-agent-identity-session:hover,.cx-agent-identity-session:focus-visible{border-color:color-mix(in srgb,var(--cx-primary) 60%,var(--cx-border));background:var(--cx-hover);outline:none}.cx-agent-identity-session:focus-visible{box-shadow:0 0 0 2px var(--cx-primary)}.cx-agent-identity-session[disabled]{cursor:progress;opacity:.7}.cx-agent-identity-room,.cx-agent-identity-task{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cx-agent-identity-room{font-weight:650}.cx-agent-identity-task{grid-column:1;color:var(--cx-muted);font-size:11px}.cx-agent-identity-lifecycle{grid-column:2;grid-row:1/3;align-self:center;color:var(--cx-muted);font-size:11px}.cx-agent-identity-empty{margin:0;color:var(--cx-muted);font-size:12px}.cx-agent-identity-live{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}
.cx-agent-identity-avatar-button{appearance:none;display:inline-grid;width:27px;height:27px;flex:none;align-self:flex-start;margin:0;padding:0;border:0;border-radius:8px;outline:0;background:transparent;box-shadow:none;color:inherit;font:inherit;line-height:0;cursor:pointer}.cx-agent-identity-avatar-button:hover{filter:brightness(1.04)}.cx-agent-identity-avatar-button:focus:not(:focus-visible){outline:0;box-shadow:none}.cx-agent-identity-avatar-button:focus-visible{outline:2px solid var(--cx-focus,var(--cx-primary));outline-offset:2px;box-shadow:none}
.cx-agent-identity-avatar-button{border-radius:50%}
@media (prefers-reduced-motion:reduce){.cx-agent-identity-body,.cx-agent-identity-body *{animation:none!important;transition:none!important}}
`

function boundedText(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && value.trim() === '')) throw new TypeError(`${label} is invalid`)
  return value
}

function boundedHandle(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HANDLE_PATTERN.test(value)) throw new TypeError(`${label} is invalid`)
  return value
}

function cloneIdentity(value: HostAgentDefinitionIdentityPresentation | undefined): HostAgentDefinitionIdentityPresentation | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || !AGENT_ID_PATTERN.test(value.agentId) || !HANDLE_PATTERN.test(value.revision)) {
    throw new TypeError('Agent identity is invalid')
  }
  if (Object.keys(value).sort().join(',') !== 'agentId,revision') throw new TypeError('Agent identity contains unknown fields')
  return Object.freeze({ agentId: value.agentId, revision: value.revision })
}

export function createHostAgentIdentityPresentation(input: HostAgentIdentityPresentation): HostAgentIdentityPresentation {
  if (input === null || typeof input !== 'object') throw new TypeError('Agent identity presentation must be an object')
  if (input.participant === null || typeof input.participant !== 'object') throw new TypeError('Agent participant is invalid')
  const participantId = boundedHandle(input.participant.participantId, 'Participant id')
  if (!['agent', 'human', 'system'].includes(input.participant.role)) throw new TypeError('Participant role is invalid')
  const identity = cloneIdentity(input.participant.role === 'agent' ? input.participant.agentIdentity : undefined)
  const name = boundedText(input.name, 'Agent name', 256)
  const introduction = boundedText(input.introduction, 'Agent introduction', 32_768, true)
  if (!Array.isArray(input.activeSessions) || input.activeSessions.length > 256) throw new TypeError('Active sessions are invalid')
  const keys = new Set<string>()
  const activeSessions = input.activeSessions.map((session, index) => {
    if (session === null || typeof session !== 'object') throw new TypeError(`Active session ${index} is invalid`)
    if (session.run === null || typeof session.run !== 'object') throw new TypeError(`Active session ${index} run is invalid`)
    const sessionParticipantId = boundedHandle(session.run.participantId, `Active session ${index} participant id`)
    if (sessionParticipantId !== participantId) throw new TypeError(`Active session ${index} crosses participant identity`)
    const memberId = boundedHandle(session.run.memberId, `Active session ${index} member id`)
    const runId = boundedHandle(session.run.runId, `Active session ${index} run id`)
    const key = JSON.stringify([sessionParticipantId, memberId, runId])
    if (keys.has(key)) throw new TypeError('Active sessions contain a duplicate participant/member/run association')
    keys.add(key)
    if (!['active', 'running', 'waiting', 'attention'].includes(session.run.lifecycle.phase)) throw new TypeError(`Active session ${index} lifecycle is invalid`)
    return Object.freeze({
      run: Object.freeze({
        participantId: sessionParticipantId,
        memberId,
        runId,
        lifecycle: Object.freeze({
          phase: session.run.lifecycle.phase,
          ...(session.run.lifecycle.updatedAt === undefined ? {} : { updatedAt: boundedText(session.run.lifecycle.updatedAt, `Active session ${index} lifecycle time`, 64) }),
        }),
        detailsUrl: validateAgentLoopTaskDetailsUrl(session.run.detailsUrl),
      }),
      roomLabel: boundedText(session.roomLabel, `Active session ${index} room label`, 256),
      taskLabel: boundedText(session.taskLabel, `Active session ${index} task label`, 256),
    })
  })
  const participant = Object.freeze({
    participantId,
    role: input.participant.role,
    displayName: Object.freeze({ ...input.participant.displayName }),
    ...(input.participant.avatar === undefined ? {} : { avatar: cloneAgentAvatarRef(input.participant.avatar) }),
    ...(identity === undefined ? {} : { agentIdentity: identity }),
  }) as AgentConversationParticipant
  return Object.freeze({
    participant,
    name,
    introduction,
    activeSessions: Object.freeze(activeSessions),
  })
}

/**
 * Formal Shell v2 adapter. Dynamic runs are read only from selection.activeRuns;
 * historical message authors are never used as a task/session source.
 */
export function projectHostAgentIdentityFromShell(
  selection: AgentConversationSelection,
  participantId: string,
  effective: HostEffectiveAgentIdentityProjection,
  labelsFor: (run: AgentConversationActiveRunDescriptor) => HostAgentIdentitySessionLabels,
): HostAgentIdentityPresentation | undefined {
  boundedHandle(participantId, 'Participant id')
  if (selection.kind !== 'room') return undefined
  const matching = selection.participants.filter(participant => participant.participantId === participantId)
  if (matching.length > 1) throw new TypeError('Room selection contains a duplicate participant id')
  const participant = matching[0]
  if (participant?.role !== 'agent' || participant.agentIdentity === undefined) return undefined
  const identity = cloneIdentity(effective.identity)!
  if (participant.agentIdentity.agentId !== identity.agentId || participant.agentIdentity.revision !== identity.revision) {
    throw new TypeError('Effective Agent identity does not match the exact participant identity')
  }
  const activeSessions = (selection.activeRuns ?? [])
    .filter(run => run.participantId === participantId)
    .map(run => ({ run, ...labelsFor(run) }))
  return createHostAgentIdentityPresentation({
    participant,
    name: effective.name,
    introduction: effective.introduction,
    activeSessions,
  })
}

export function canOpenHostAgentIdentity(presentation: HostAgentIdentityPresentation | undefined): boolean {
  return presentation?.participant.role === 'agent' && presentation.participant.agentIdentity !== undefined
}

export function HostAgentIdentityAvatarButton({ presentation: input, label, onOpen }: HostAgentIdentityAvatarButtonProps) {
  const presentation = React.useMemo(() => createHostAgentIdentityPresentation(input), [input])
  const avatar = <HostAgentAvatar participant={{
    id: presentation.participant.participantId,
    role: presentation.participant.role,
    name: presentation.name,
    ...(presentation.participant.avatar === undefined ? {} : { avatar: presentation.participant.avatar }),
  }} />
  if (!canOpenHostAgentIdentity(presentation)) return avatar
  return <button type="button" className="cx-agent-identity-avatar-button" aria-label={label} onClick={onOpen}>{avatar}</button>
}

export function HostAgentIdentityPanel({
  open,
  presentation: input,
  copy,
  navigator,
  onOpenChange,
  onSettings,
  onNavigationError,
}: HostAgentIdentityPanelProps) {
  const presentation = React.useMemo(() => input === undefined ? undefined : createHostAgentIdentityPresentation(input), [input])
  const interactive = canOpenHostAgentIdentity(presentation)
  const [pendingSession, setPendingSession] = React.useState<string | undefined>()
  const introductionId = React.useId()

  React.useEffect(() => {
    if (open && !interactive) onOpenChange(false)
  }, [interactive, onOpenChange, open])

  if (!open || !interactive || presentation === undefined) return null
  const run = async (key: string, detailsUrl: AgentConversationActiveRunDescriptor['detailsUrl']): Promise<void> => {
    if (pendingSession !== undefined) return
    setPendingSession(key)
    try {
      await navigator.navigate(detailsUrl)
      onOpenChange(false)
    } catch (error) {
      onNavigationError?.(error)
    } finally {
      setPendingSession(undefined)
    }
  }
  const participant = {
    id: presentation.participant.participantId,
    role: presentation.participant.role,
    name: presentation.name,
    ...(presentation.participant.avatar === undefined ? {} : { avatar: presentation.participant.avatar }),
  } as const
  return <>
    <style data-host-agent-identity-styles="true">{PANEL_STYLES}</style>
    <HostConversationRightInspector
      open={open}
      title={presentation.name}
      closeLabel={copy.close}
      describedBy={introductionId}
      onOpenChange={onOpenChange}
      leading={<span className="cx-agent-identity-avatar-seat"><HostAgentAvatar participant={participant} /></span>}
      actions={<button type="button" className="cx-conversation-inspector-icon-action" aria-label={copy.settings} onClick={() => {
        void Promise.resolve()
          .then(() => onSettings(presentation.participant.agentIdentity!))
          .then(() => onOpenChange(false))
          .catch(error => onNavigationError?.(error))
      }}><HostSurfaceIcon token="host:settings" /></button>}
    >
      <div className="cx-agent-identity-body">
        <section className="cx-agent-identity-section" aria-labelledby={`${introductionId}-heading`}>
          <h3 id={`${introductionId}-heading`}>{copy.introduction}</h3>
          <p id={introductionId} className="cx-agent-identity-introduction">{presentation.introduction}</p>
        </section>
        <section className="cx-agent-identity-section" aria-labelledby={`${introductionId}-sessions`}>
          <h3 id={`${introductionId}-sessions`}>{copy.activeSessions}</h3>
          <span className="cx-agent-identity-live" role="status" aria-live="polite">{copy.sessionCount(presentation.activeSessions.length)}</span>
          {presentation.activeSessions.length === 0
            ? <p className="cx-agent-identity-empty">{copy.noActiveSessions}</p>
            : <ul className="cx-agent-identity-sessions">{presentation.activeSessions.map(session => {
              const key = JSON.stringify([session.run.participantId, session.run.memberId, session.run.runId])
              const lifecycle = copy.lifecycle[session.run.lifecycle.phase]
              return <li key={key}><button
                type="button"
                className="cx-agent-identity-session"
                disabled={pendingSession !== undefined}
                aria-label={`${session.roomLabel} · ${session.taskLabel} · ${lifecycle}`}
                onClick={() => { void run(key, session.run.detailsUrl) }}
              >
                <span className="cx-agent-identity-room">{session.roomLabel}</span>
                <span className="cx-agent-identity-task">{session.taskLabel}</span>
                <span className="cx-agent-identity-lifecycle">{lifecycle}</span>
              </button></li>
            })}</ul>}
        </section>
      </div>
    </HostConversationRightInspector>
  </>
}
