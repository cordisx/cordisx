import { AgentConversationCommandController } from '../../../renderer/host-ui/conversation/commands.js'
import {
  createAgentConversationModel,
  type AgentConversationModel,
} from '../../../renderer/host-ui/conversation/model.js'
import type { AgentConversationRendererCopy } from '../../../renderer/host-ui/conversation/AgentConversationRenderer.js'
import type { PlaygroundFixtureMode } from '../components/HostSeats.js'

const unavailable = (en: boolean): string => en ? 'Connector unavailable in Playground' : 'Playground 中 Connector 不可用'

export function createPlaygroundConversationCommands(model: AgentConversationModel): AgentConversationCommandController {
  return new AgentConversationCommandController({
    async execute() {
      throw new Error('Playground debug fixtures do not execute product commands')
    },
  }, model)
}

export function playgroundConversationCopy(locale: 'zh-CN' | 'en'): AgentConversationRendererCopy {
  const en = locale === 'en'
  return Object.freeze(en ? {
    locale: 'en',
    newRoomTitle: 'New room',
    timelineLabel: 'Conversation timeline',
    composerLabel: 'Message draft',
    sendLabel: 'Send message',
    running: 'Running',
    stopped: 'Stopped',
    failed: 'Failed',
    pending: 'Pending',
    unavailable: 'Connector unavailable',
  } : {
    locale: 'zh-CN',
    newRoomTitle: '新建房间',
    timelineLabel: '会话时间线',
    composerLabel: '消息草稿',
    sendLabel: '发送消息',
    running: '运行中',
    stopped: '已停止',
    failed: '失败',
    pending: '待发送',
    unavailable: 'Connector 不可用',
  })
}

export function createPlaygroundConversationFixture(mode: PlaygroundFixtureMode, locale: 'zh-CN' | 'en'): AgentConversationModel {
  const en = locale === 'en'
  const unavailableReason = unavailable(en)
  const common = {
    ownerId: 'host-playground-fixture',
    shell: 'agent-desktop' as const,
    binding: {
      bindingId: mode === 'conversation' ? 'debug-room-binding' : 'debug-new-room-binding',
      ownerGeneration: 'playground-owner-debug-only',
    },
    generation: 'playground-snapshot-debug-only',
    snapshotSequence: 1,
    composer: {
      availability: 'unavailable' as const,
      placeholder: en ? 'Connector unavailable in this debug fixture' : '此调试 fixture 中 Connector 不可用',
      disabled: true,
      disabledReason: unavailableReason,
      submit: { id: 'room.send' },
    },
  }
  if (mode !== 'conversation') {
    return createAgentConversationModel({
      ...common,
      selection: { kind: 'no-room' },
      entries: [],
      composer: {
        availability: 'available',
        placeholder: en ? 'Start a room with your first message' : '输入第一条消息以新建房间',
        disabled: false,
        submit: { id: 'room.create-with-message' },
      },
      headerActions: [],
    })
  }
  return createAgentConversationModel({
    ...common,
    selection: {
      kind: 'room',
      roomId: 'debug-room',
      title: en ? 'Multi-agent release review' : '多 Agent 发布评审',
      multiParticipant: true,
      participantPresentation: 'host-initials',
      participants: [
        { id: 'human-reviewer', role: 'human', name: en ? 'You' : '你' },
        { id: 'agent-alpha', role: 'agent', name: 'Agent Alpha' },
        { id: 'agent-beta', role: 'agent', name: 'Agent Beta' },
      ],
    },
    entries: [
      {
        kind: 'message', itemId: 'entry-1', messageId: 'message-1', sequence: 1, authorId: 'human-reviewer',
        body: [en ? 'Review the Host-owned conversation shell at common window sizes.' : '请在常见窗口尺寸下评审 Host-owned 会话壳。'],
        timestamp: '2026-08-29T01:00:00.000Z', deliveryState: 'delivered', runState: 'idle', ariaLive: 'off', actions: [],
      },
      {
        kind: 'message', itemId: 'entry-2', messageId: 'message-2', sequence: 2, authorId: 'agent-alpha',
        body: [en ? 'The title and actions appear only in Host chrome.' : '标题与操作只出现在 Host 顶部 chrome。'],
        timestamp: '2026-08-29T01:00:02.000Z', deliveryState: 'delivered', runState: 'idle', ariaLive: 'off', actions: [],
      },
      {
        kind: 'status', itemId: 'entry-3', sequence: 3,
        label: en ? 'Agent Beta is checking responsive behavior…' : 'Agent Beta 正在检查响应式布局…',
        state: 'working', ariaLive: 'polite',
      },
      {
        kind: 'message', itemId: 'entry-4', messageId: 'message-4', sequence: 4, authorId: 'agent-beta',
        body: [en ? 'Timeline scrolling is separate from the fixed composer.' : '时间线滚动与固定 composer 相互独立。'],
        timestamp: '2026-08-29T01:00:05.000Z', deliveryState: 'sent', runState: 'running', ariaLive: 'polite', actions: [],
      },
      {
        kind: 'status', itemId: 'entry-5', sequence: 5,
        label: en ? 'One optional task was stopped.' : '一个可选任务已停止。', state: 'warning', ariaLive: 'off',
      },
      {
        kind: 'message', itemId: 'entry-6', messageId: 'message-6', sequence: 6, authorId: 'agent-alpha',
        body: [en ? 'A failed message remains visible with an explicit state.' : '失败消息会保留，并显示明确状态。'],
        timestamp: '2026-08-29T01:00:08.000Z', deliveryState: 'failed', runState: 'failed', ariaLive: 'polite', actions: [],
      },
      {
        kind: 'status', itemId: 'entry-7', sequence: 7,
        label: en ? 'Design fixture only · not connected to Connector' : '仅设计 fixture · 未连接 Connector',
        state: 'info', ariaLive: 'off',
      },
    ],
    headerActions: [
      { id: 'stop-room', label: en ? 'Stop' : '停止', icon: 'host:close', command: { id: 'room.stop' }, disabled: true, disabledReason: unavailableReason },
      { id: 'room-menu', label: en ? 'Room menu' : '房间菜单', icon: 'host:more', command: { id: 'room.menu' }, disabled: true, disabledReason: unavailableReason },
    ],
  })
}
