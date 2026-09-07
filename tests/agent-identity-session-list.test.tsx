import React from 'react'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import {
  HostAgentIdentityContent,
  type HostAgentIdentityPresentation,
} from '../packages/cli/src/renderer/host-ui/conversation/AgentIdentityPanel.js'
import { HostAgentTaskDetailsNavigator } from '../packages/cli/src/renderer/host-ui/AgentTaskDetailsNavigator.js'

const association = {
  association: {
    participantId: 'leader',
    memberId: 'leader',
    runId: 'run-1',
    sessionId: 'cx-session.original',
    state: 'unloaded' as const,
    details: { kind: 'host' as const, ref: 'opaque-original' },
  },
  roomLabel: '产品设计',
}
const presentation: HostAgentIdentityPresentation = {
  participant: {
    participantId: 'leader',
    role: 'agent',
    displayName: { key: 'leader', fallback: '规划助手' },
    agentIdentity: { agentId: 'leader', revision: 'original' },
  },
  name: '规划助手',
  introduction: '帮助制定计划',
  activeSessions: [],
}
function html(value: HostAgentIdentityPresentation) {
  return renderToString(
    <HostAgentIdentityContent
      presentation={value}
      copy={{
        settings: '设置',
        close: '关闭',
        introduction: '介绍',
        activeSessions: '会话',
        noActiveSessions: '暂无会话',
        sessionCount: count => `${count} 个会话`,
        lifecycle: { active: '激活', running: '工作中', waiting: '等待中', attention: '需处理' },
      }}
      navigator={new HostAgentTaskDetailsNavigator({ navigateHost() {}, navigateExternal() {} })}
      onClose={() => {}}
      onSettings={() => {}}
      onOpenDetail={async () => {}}
    />,
  )
}

test('one merged list deduplicates exact Session identity and shows only reliable live state', () => {
  const active = {
    run: {
      participantId: 'leader',
      memberId: 'leader',
      runId: 'run-1',
      sessionId: 'cx-session.original',
      lifecycle: { phase: 'running' as const },
      details: { kind: 'host' as const, ref: 'live-original' },
    },
    roomLabel: '产品设计',
    taskLabel: '规划助手',
  }
  const input = { ...presentation, activeSessions: [active], associatedSessions: [association] }
  const before = JSON.stringify(input)
  const markup = html(input)
  expect(markup.match(/class="cx-agent-identity-session"/g)).toHaveLength(1)
  expect(markup.match(/>会话<\/h3>/g)).toHaveLength(1)
  expect(markup).toContain('产品设计')
  expect(markup).toContain('工作中')
  expect(markup).not.toContain('暂无会话')
  expect(markup).not.toContain('cx-session.original')
  expect(JSON.stringify(input)).toBe(before)
  const unobserved = html({
    ...input,
    activeSessions: [{ ...active, run: { ...active.run, lifecycle: { phase: 'active' } } }],
  })
  expect(unobserved).not.toContain('>激活<')
})

test('persisted-only list hides diagnostics and internal IDs; only an empty merged list has an empty state', () => {
  const markup = html({ ...presentation, associatedSessions: [association] })
  expect(markup.match(/class="cx-agent-identity-session"/g)).toHaveLength(1)
  for (const hidden of ['cx-session.original', '未加载', '未知', '激活', '暂无会话']) {
    expect(markup).not.toContain(hidden)
  }
  expect(markup).toContain('产品设计')
  const empty = html(presentation)
  expect(empty.match(/>暂无会话</g)).toHaveLength(1)
  expect(empty).not.toContain('class="cx-agent-identity-session"')
})
