import { Component, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ConfigProvider, Select } from 'tdesign-react'
import type { PlaygroundMockTaskTrace } from '../../../renderer/playground-mock-agent-loop.js'
import { HostIcon } from '../../../renderer/host-ui/HostIcon.js'
import { IconButton } from '../../../renderer/host-ui/IconButton.js'
import {
  PlaygroundScenarioLabController,
  type PlaygroundScenarioLabSnapshot,
  type PlaygroundTaskTraceDirection,
  type PlaygroundTaskTraceEntry,
  type PlaygroundTaskTracePresentation,
} from '../../scenario-lab.js'

export interface SimulatorTaskScenarioWorkbenchProps {
  readonly locale: 'zh-CN' | 'en'
  readonly task: PlaygroundMockTaskTrace
  readonly controller: PlaygroundScenarioLabController
}

interface ScenarioWorkbenchErrorBoundaryState {
  readonly error: string | undefined
}

interface TDesignSelectHandle extends HTMLDivElement {
  readonly inputElement?: HTMLInputElement
}

class ScenarioWorkbenchErrorBoundary extends Component<
  SimulatorTaskScenarioWorkbenchProps & { readonly children: ReactNode },
  ScenarioWorkbenchErrorBoundaryState
> {
  state: ScenarioWorkbenchErrorBoundaryState = { error: undefined }

  static getDerivedStateFromError(error: unknown): ScenarioWorkbenchErrorBoundaryState {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  render() {
    if (this.state.error === undefined) return this.props.children
    const en = this.props.locale === 'en'
    return (
      <section
        className="pg-scenario-workbench pg-scenario-workbench-failed"
        data-playground-scenario-workbench-error="true"
        aria-labelledby="pg-scenario-workbench-error-title"
      >
        <h2 id="pg-scenario-workbench-error-title">{en ? 'Event debugger unavailable' : '事件调试暂不可用'}</h2>
        <p>{en ? 'The task snapshot is still intact.' : '原 task 快照仍保持完整。'}</p>
        <p className="pg-scenario-error" role="alert">{this.state.error}</p>
        <button
          type="button"
          onClick={() => {
            this.props.controller.reset()
            this.setState({ error: undefined })
          }}
        >
          {en ? 'Retry debugger' : '重试调试台'}
        </button>
      </section>
    )
  }
}

const directionLabels: Readonly<
  Record<PlaygroundTaskTraceDirection, { readonly 'zh-CN': string; readonly en: string }>
> = {
  'chatroom-to-agent-host': { 'zh-CN': '用户 / Chatroom → Agent', en: 'User / Chatroom → Agent' },
  'agent-host-to-chatroom': { 'zh-CN': 'Agent → Chatroom', en: 'Agent → Chatroom' },
  'agent-execution': { 'zh-CN': 'Agent 内部执行', en: 'Agent execution' },
  'agent-to-tool': { 'zh-CN': 'Agent → 工具', en: 'Agent → Tool' },
  'tool-to-agent': { 'zh-CN': '工具 → Agent', en: 'Tool → Agent' },
  'injector-to-agent-host': { 'zh-CN': 'Simulator → Agent / Host', en: 'Simulator → Agent / Host' },
  'simulator-to-chatroom': { 'zh-CN': 'Simulator → Chatroom', en: 'Simulator → Chatroom' },
  'host-lifecycle': { 'zh-CN': 'Host lifecycle', en: 'Host lifecycle' },
}

type ComposerEventType =
  | 'agent-reply'
  | 'permission-request'
  | 'task-delegation'
  | 'member-self-introduction'
  | 'typed-failure'

const COMPOSER_EVENT_TYPES: readonly ComposerEventType[] = Object.freeze([
  'agent-reply',
  'permission-request',
  'task-delegation',
  'member-self-introduction',
  'typed-failure',
])

function isComposerEventType(value: unknown): value is ComposerEventType {
  return typeof value === 'string' && COMPOSER_EVENT_TYPES.some(candidate => candidate === value)
}

function timelineAlignment(direction: PlaygroundTaskTraceDirection): 'left' | 'right' | 'center' {
  if (
    direction === 'host-lifecycle' || direction === 'agent-execution'
    || direction === 'agent-to-tool' || direction === 'tool-to-agent'
  ) return 'center'
  return direction === 'chatroom-to-agent-host' || direction === 'injector-to-agent-host' ? 'left' : 'right'
}

function tracePresentationLabel(
  presentation: PlaygroundTaskTracePresentation | undefined,
  locale: 'zh-CN' | 'en',
  fallback: string,
): string {
  if (presentation === undefined || presentation === 'legacy') return fallback
  const labels: Readonly<
    Record<Exclude<PlaygroundTaskTracePresentation, 'legacy'>, { readonly 'zh-CN': string; readonly en: string }>
  > = {
    'user-input': { 'zh-CN': '用户消息', en: 'User message' },
    'assistant-response': { 'zh-CN': 'Agent 回复', en: 'Agent response' },
    'agent-execution': { 'zh-CN': 'Agent 执行', en: 'Agent execution' },
    'tool-use': { 'zh-CN': '工具调用', en: 'Tool use' },
    'tool-result': { 'zh-CN': '工具结果', en: 'Tool result' },
    approval: { 'zh-CN': '批准流程', en: 'Approval flow' },
    lifecycle: { 'zh-CN': '会话生命周期', en: 'Session lifecycle' },
  }
  return labels[presentation][locale]
}

function traceFactKind(
  presentation: PlaygroundTaskTracePresentation | undefined,
): 'semantic' | 'tool' | 'raw' | 'legacy' {
  if (presentation === 'user-input' || presentation === 'assistant-response') return 'semantic'
  if (presentation === 'tool-use' || presentation === 'tool-result') return 'tool'
  if (presentation === undefined || presentation === 'legacy') return 'legacy'
  return 'raw'
}

function correlationSummary(entry: PlaygroundTaskTraceEntry): string {
  const correlations = [
    entry.correlations.operationId,
    entry.correlations.turn,
    entry.correlations.runId,
  ].filter((value): value is string => value !== undefined)
  return correlations.slice(0, 2).join(' · ')
}

function traceDetails(entry: PlaygroundTaskTraceEntry): unknown {
  return {
    source: entry.source,
    generation: entry.generation,
    direction: entry.direction,
    type: entry.type,
    timestamp: entry.timestamp ?? null,
    correlations: {
      operationId: entry.correlations.operationId ?? null,
      turnId: entry.correlations.turn ?? null,
      messageId: entry.correlations.messageId ?? null,
      participantId: entry.correlations.participantId ?? null,
      memberId: entry.correlations.memberId ?? null,
      runId: entry.correlations.runId ?? null,
    },
    payload: entry.payload,
    rawSessionEvents: entry.rawSessionEvents ?? [],
  }
}

function SimulatorTaskScenarioWorkbenchContent({ locale, task, controller }: SimulatorTaskScenarioWorkbenchProps) {
  const [snapshot, setSnapshot] = useState<PlaygroundScenarioLabSnapshot>(() => controller.getSnapshot())
  const [selectedEventId, setSelectedEventId] = useState<string>()
  const [eventType, setEventType] = useState<ComposerEventType>('agent-reply')
  const [message, setMessage] = useState('这是 Agent 对 Chatroom 的调试回复。')
  const [permissionRationale, setPermissionRationale] = useState('请求执行受保护的模拟操作。')
  const [delegationTask, setDelegationTask] = useState('最终链路验证')
  const [delegationMemberId, setDelegationMemberId] = useState('')
  const [failureMessage, setFailureMessage] = useState('模拟 Agent 执行失败。')
  const [participantId, setParticipantId] = useState('scenario-agent-a')
  const [memberId, setMemberId] = useState('scenario-member-a')
  const [runId, setRunId] = useState('scenario-run-a')
  const timelineRef = useRef<HTMLOListElement>(null)
  const tDesignHostRef = useRef<HTMLDivElement>(null)
  const drawerCloseRef = useRef<HTMLElement>(null)
  const drawerTriggerRef = useRef<HTMLButtonElement | null>(null)
  const composerTypeRef = useRef<TDesignSelectHandle>(null)
  const delegationTargetRef = useRef<TDesignSelectHandle>(null)
  const en = locale === 'en'
  const attachTDesignPopup = useMemo(() => () => tDesignHostRef.current ?? document.body, [])
  const eventTypeOptions = useMemo(() => [
    { value: 'agent-reply', label: en ? 'Agent reply' : 'Agent 回复' },
    { value: 'permission-request', label: en ? 'Agent approval request' : 'Agent 请求批准' },
    { value: 'task-delegation', label: en ? 'Delegate task to entity' : '下发任务给其他实体' },
    { value: 'member-self-introduction', label: en ? 'Agent introduction (local)' : 'Agent 自我介绍（本地）' },
    { value: 'typed-failure', label: en ? 'Agent failure (local)' : 'Agent 模拟失败（本地）' },
  ], [en])
  const originalCount = snapshot.trace.filter(entry => entry.source === 'original').length
  const selectedEvent = useMemo(
    () => snapshot.trace.find(entry => entry.id === selectedEventId),
    [selectedEventId, snapshot.trace],
  )

  useEffect(() => {
    const update = () => setSnapshot(controller.getSnapshot())
    update()
    return controller.subscribe(update)
  }, [controller])

  useEffect(() => {
    const targets = snapshot.injector.roomBridge.delegationTargets
    if (targets.some(target => target.memberId === delegationMemberId)) return
    setDelegationMemberId(targets[0]?.memberId ?? '')
  }, [delegationMemberId, snapshot.injector.roomBridge.delegationTargets])

  useLayoutEffect(() => {
    const timeline = timelineRef.current
    if (timeline !== null) timeline.scrollTop = timeline.scrollHeight
  }, [snapshot.trace.length, snapshot.disposableGeneration])

  useLayoutEffect(() => {
    composerTypeRef.current?.inputElement?.setAttribute('aria-label', en ? 'Event type' : '事件类型')
    delegationTargetRef.current?.inputElement?.setAttribute('aria-label', en ? 'Target entity' : '目标实体')
  }, [en, eventType])

  const closeDrawer = () => {
    setSelectedEventId(undefined)
    queueMicrotask(() => {
      const trigger = drawerTriggerRef.current
      if (trigger?.isConnected === true) trigger.focus({ preventScroll: true })
      else composerTypeRef.current?.focus({ preventScroll: true })
    })
  }

  useLayoutEffect(() => {
    if (selectedEvent !== undefined) drawerCloseRef.current?.focus({ preventScroll: true })
  }, [selectedEvent?.id])

  useEffect(() => {
    if (selectedEvent === undefined) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeDrawer()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [selectedEvent])

  useEffect(() => {
    if (selectedEventId !== undefined && selectedEvent === undefined) closeDrawer()
  }, [selectedEvent, selectedEventId])

  const submit = () => {
    if (snapshot.injector.phase === 'injecting') return
    if (eventType === 'agent-reply') void controller.injectAgentReply(message)
    else if (eventType === 'permission-request') void controller.injectAgentApprovalRequest(permissionRationale)
    else if (eventType === 'task-delegation') void controller.injectTaskDelegation(delegationMemberId, delegationTask)
    else if (eventType === 'typed-failure') void controller.injectFailure(failureMessage)
    else void controller.injectMemberSelfIntroduction({ participantId, memberId, runId })
  }

  const inputInvalid = eventType === 'agent-reply'
    ? message.trim() === ''
    : eventType === 'permission-request'
    ? permissionRationale.trim() === ''
    : eventType === 'task-delegation'
    ? delegationMemberId === '' || delegationTask.trim() === ''
    : eventType === 'typed-failure'
    ? failureMessage.trim() === ''
    : participantId.trim() === '' || memberId.trim() === '' || runId.trim() === ''
  const writesToRoom = eventType === 'agent-reply' || eventType === 'permission-request'
    || eventType === 'task-delegation'
  const isolatedAgentProbe = eventType === 'member-self-introduction' || eventType === 'typed-failure'
  const roomBridgeUnavailable = writesToRoom && snapshot.injector.roomBridge.state !== 'available'

  return (
    <ConfigProvider globalConfig={{ attach: attachTDesignPopup }}>
      <div
        ref={tDesignHostRef}
        className="pg-scenario-workbench pg-task-debugger"
        data-playground-scenario-workbench
        data-scenario-owner={snapshot.owner}
        data-source-task-id={snapshot.sourceTask.debugTaskId}
        data-disposable-generation={snapshot.disposableGeneration}
      >
        <ol
          ref={timelineRef}
          className="pg-event-timeline"
          aria-label={en ? `${task.debugTaskId} event timeline` : `${task.debugTaskId} 事件时间线`}
        >
          {snapshot.trace.length === 0
            ? <li className="pg-event-timeline-empty">{en ? 'No task events yet.' : '此 task 尚无事件。'}</li>
            : snapshot.trace.map((entry, index) => {
              const alignment = timelineAlignment(entry.direction)
              const presentation = entry.presentation ?? 'legacy'
              const toolEvent = presentation === 'tool-use' || presentation === 'tool-result'
              const compactEvent = alignment === 'center' && !toolEvent
              const presentationLabel = tracePresentationLabel(entry.presentation, locale, entry.type)
              const factKind = traceFactKind(entry.presentation)
              const pendingApproval = (entry.type === 'approval.required' || entry.type === 'room.permission.pending'
                || entry.type === 'room.agent-approval.pending')
                && entry.source === 'simulated'
                && snapshot.injector.pendingApproval !== undefined
                && (entry.correlations.turn === undefined
                  || entry.correlations.turn === snapshot.injector.pendingApproval.turn)
              return (
                <li
                  key={entry.id}
                  className="pg-event-timeline-item"
                  data-trace-source={entry.source}
                  data-trace-direction={entry.direction}
                  data-trace-presentation={presentation}
                  data-timeline-alignment={alignment}
                >
                  {index === originalCount && index > 0
                    ? (
                      <div className="pg-event-generation-divider" role="separator">
                        <span>
                          {en
                            ? `Simulated session · ${snapshot.disposableGeneration.split(':').slice(-2).join(':')}`
                            : `模拟会话 · ${snapshot.disposableGeneration.split(':').slice(-2).join(':')}`}
                        </span>
                      </div>
                    )
                    : null}
                  {compactEvent
                    ? (
                      <button
                        type="button"
                        className="pg-event-system-row"
                        onClick={event => {
                          drawerTriggerRef.current = event.currentTarget
                          setSelectedEventId(entry.id)
                        }}
                        aria-haspopup="dialog"
                        aria-label={`${
                          directionLabels[entry.direction][locale]
                        } · ${presentationLabel} · ${entry.summary}`}
                      >
                        <span>{presentationLabel}</span>
                        <span>{entry.summary}</span>
                      </button>
                    )
                    : (
                      <article className={`pg-event-message${toolEvent ? ' pg-event-tool-message' : ''}`}>
                        <button
                          type="button"
                          className="pg-event-bubble"
                          onClick={event => {
                            drawerTriggerRef.current = event.currentTarget
                            setSelectedEventId(entry.id)
                          }}
                          aria-haspopup="dialog"
                          aria-label={`${
                            directionLabels[entry.direction][locale]
                          } · ${presentationLabel} · ${entry.summary}`}
                        >
                          <span className="pg-event-bubble-meta">
                            <span>{directionLabels[entry.direction][locale]}</span>
                            <span data-event-fact={factKind}>
                              {factKind === 'semantic'
                                ? (en ? 'semantic' : '语义')
                                : factKind === 'tool'
                                ? (en ? 'tool fact' : '工具事实')
                                : factKind === 'raw'
                                ? (en ? 'raw event' : '原始事件')
                                : (en ? 'legacy' : '旧路径')}
                            </span>
                            <span data-trace-source-label>
                              {entry.source === 'original' ? (en ? 'authority' : '权威') : (en ? 'simulated' : '模拟')}
                            </span>
                            {entry.timestamp === undefined
                              ? null
                              : (
                                <time dateTime={entry.timestamp}>
                                  {new Date(entry.timestamp).toLocaleTimeString(locale, {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    second: '2-digit',
                                  })}
                                </time>
                              )}
                          </span>
                          <strong>{presentationLabel}</strong>
                          <span className="pg-event-bubble-summary">{entry.summary}</span>
                          {correlationSummary(entry) === '' ? null : <code>{correlationSummary(entry)}</code>}
                        </button>
                        {pendingApproval
                          ? (
                            <div
                              className="pg-event-inline-actions"
                              role="group"
                              aria-label={en ? 'Permission decision' : '权限决定'}
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  void controller.resolvePendingApproval('approved')
                                }}
                              >
                                {en ? 'Approve' : '允许'}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  void controller.resolvePendingApproval('denied')
                                }}
                              >
                                {en ? 'Deny' : '拒绝'}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  void controller.resolvePendingApproval('cancelled')
                                }}
                              >
                                {en ? 'Cancel' : '取消'}
                              </button>
                            </div>
                          )
                          : null}
                      </article>
                    )}
                </li>
              )
            })}
        </ol>

        {snapshot.error === undefined
          ? null
          : <p className="pg-scenario-error pg-event-runtime-error" role="alert">{snapshot.error}</p>}

        <form
          className="pg-event-composer"
          data-composer-event-type={eventType}
          onSubmit={event => {
            event.preventDefault()
            submit()
          }}
        >
          <div className="pg-event-composer-type">
            <span className="pg-visually-hidden">{en ? 'Event type' : '事件类型'}</span>
            <Select
              ref={composerTypeRef}
              className="pg-event-composer-select pg-event-composer-event-type"
              size="large"
              value={eventType}
              options={eventTypeOptions}
              aria-label={en ? 'Event type' : '事件类型'}
              onChange={value => {
                if (isComposerEventType(value)) setEventType(value)
              }}
            />
          </div>
          <div className="pg-event-composer-input">
            {eventType === 'agent-reply'
              ? (
                <textarea
                  rows={1}
                  value={message}
                  onChange={event => setMessage(event.currentTarget.value)}
                  placeholder={en ? 'Reply from the bound Agent to Chatroom' : '绑定 Agent 回复 Chatroom 的消息'}
                  aria-label={en ? 'Agent reply' : 'Agent 回复内容'}
                />
              )
              : null}
            {eventType === 'permission-request'
              ? (
                <textarea
                  rows={1}
                  value={permissionRationale}
                  onChange={event => setPermissionRationale(event.currentTarget.value)}
                  placeholder={en ? 'Why is the bound Agent requesting approval?' : '说明绑定 Agent 请求批准的原因'}
                  aria-label={en ? 'Agent approval reason' : 'Agent 请求批准原因'}
                />
              )
              : null}
            {eventType === 'task-delegation'
              ? (
                <div className="pg-event-composer-delegation">
                  <Select
                    ref={delegationTargetRef}
                    className="pg-event-composer-select pg-event-composer-delegation-target"
                    size="large"
                    value={delegationMemberId}
                    options={snapshot.injector.roomBridge.delegationTargets.map(target => ({
                      value: target.memberId,
                      label: target.label,
                    }))}
                    disabled={snapshot.injector.roomBridge.delegationTargets.length === 0}
                    placeholder={en ? 'No other entity available' : '没有可用的其他实体'}
                    empty={en ? 'No other entity available' : '没有可用的其他实体'}
                    aria-label={en ? 'Target entity' : '目标实体'}
                    onChange={value => {
                      if (typeof value !== 'string') return
                      if (snapshot.injector.roomBridge.delegationTargets.some(target => target.memberId === value)) {
                        setDelegationMemberId(value)
                      }
                    }}
                  />
                  <textarea
                    rows={1}
                    value={delegationTask}
                    onChange={event => setDelegationTask(event.currentTarget.value)}
                    placeholder={en ? 'Work for the new entity session' : '输入要交给新实体完成的工作'}
                    aria-label={en ? 'Delegated task' : '下发任务内容'}
                  />
                </div>
              )
              : null}
            {eventType === 'typed-failure'
              ? (
                <textarea
                  rows={1}
                  value={failureMessage}
                  onChange={event => setFailureMessage(event.currentTarget.value)}
                  placeholder={en ? 'Failure input' : '模拟失败输入'}
                  aria-label={en ? 'Failure input' : '模拟失败输入'}
                />
              )
              : null}
            {eventType === 'member-self-introduction'
              ? (
                <div className="pg-event-composer-identifiers">
                  <input
                    value={participantId}
                    onChange={event => setParticipantId(event.currentTarget.value)}
                    placeholder="participantId"
                    aria-label="participantId"
                  />
                  <input
                    value={memberId}
                    onChange={event => setMemberId(event.currentTarget.value)}
                    placeholder="memberId"
                    aria-label="memberId"
                  />
                  <input
                    value={runId}
                    onChange={event => setRunId(event.currentTarget.value)}
                    placeholder="runId"
                    aria-label="runId"
                  />
                </div>
              )
              : null}
            {isolatedAgentProbe
              ? (
                <span className="pg-event-composer-scope">
                  {en
                    ? 'Runs only in the disposable local Agent generation; it is not projected into the Room.'
                    : '仅在可丢弃的本地 Agent generation 中模拟，不会写入 Room。'}
                </span>
              )
              : null}
          </div>
          <button
            className="pg-event-composer-submit"
            type="submit"
            disabled={snapshot.injector.phase === 'injecting' || inputInvalid || roomBridgeUnavailable}
            title={roomBridgeUnavailable ? snapshot.injector.roomBridge.message : undefined}
            aria-label={eventType === 'agent-reply'
              ? (en ? 'Emit Agent reply' : '发送 Agent 回复')
              : eventType === 'permission-request'
              ? (en ? 'Emit Agent approval request' : '发送 Agent 批准请求')
              : eventType === 'task-delegation'
              ? (en ? 'Delegate task' : '下发任务')
              : (en ? 'Trigger event' : '触发事件')}
          >
            <HostIcon token="turns-submit" />
            <span>
              {eventType === 'agent-reply'
                ? (en ? 'Reply' : '回复')
                : eventType === 'permission-request'
                ? (en ? 'Request approval' : '请求批准')
                : eventType === 'task-delegation'
                ? (en ? 'Delegate' : '下发')
                : (en ? 'Trigger' : '触发')}
            </span>
          </button>
        </form>

        {selectedEvent === undefined
          ? null
          : (
            <aside
              className="pg-event-drawer"
              role="dialog"
              aria-modal="false"
              aria-labelledby="pg-event-drawer-title"
              data-event-details-drawer="true"
            >
              <header>
                <div>
                  <span>{directionLabels[selectedEvent.direction][locale]}</span>
                  <h2 id="pg-event-drawer-title">{selectedEvent.type}</h2>
                </div>
                <IconButton
                  ref={drawerCloseRef}
                  icon="close"
                  label={en ? 'Close event details' : '关闭事件详情'}
                  onClick={closeDrawer}
                />
              </header>
              <div className="pg-event-drawer-body">
                <p>{selectedEvent.summary}</p>
                <dl>
                  <div>
                    <dt>{en ? 'Source' : '来源'}</dt>
                    <dd>{selectedEvent.source}</dd>
                  </div>
                  <div>
                    <dt>{en ? 'Generation' : 'Generation'}</dt>
                    <dd>{selectedEvent.generation}</dd>
                  </div>
                  <div>
                    <dt>{en ? 'Time' : '时间'}</dt>
                    <dd>
                      {selectedEvent.timestamp === undefined
                        ? (en ? 'Not provided by original trace' : '原始 trace 未提供')
                        : new Date(selectedEvent.timestamp).toLocaleString(locale)}
                    </dd>
                  </div>
                </dl>
                <details className="pg-event-raw-details">
                  <summary>
                    {en
                      ? `Raw event details${
                        selectedEvent.rawSessionEvents === undefined
                          ? ''
                          : ` · ${selectedEvent.rawSessionEvents.length} SessionEvent${
                            selectedEvent.rawSessionEvents.length === 1 ? '' : 's'
                          }`
                      }`
                      : `原始事件详情${
                        selectedEvent.rawSessionEvents === undefined
                          ? ''
                          : ` · ${selectedEvent.rawSessionEvents.length} 个 SessionEvent`
                      }`}
                  </summary>
                  <section aria-label={en ? 'Structured event details' : '结构化事件详情'}>
                    <h3>{en ? 'Structured details' : '结构化详情'}</h3>
                    <pre>{JSON.stringify(traceDetails(selectedEvent), null, 2)}</pre>
                  </section>
                </details>
              </div>
            </aside>
          )}
      </div>
    </ConfigProvider>
  )
}

export function SimulatorTaskScenarioWorkbench(props: SimulatorTaskScenarioWorkbenchProps) {
  return (
    <ScenarioWorkbenchErrorBoundary key={props.task.taskRef} {...props}>
      <SimulatorTaskScenarioWorkbenchContent {...props} />
    </ScenarioWorkbenchErrorBoundary>
  )
}
