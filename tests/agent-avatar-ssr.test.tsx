import { createGeneratedAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HostAgentAvatar } from '../packages/cli/src/renderer/host-ui/conversation/AgentAvatar.js'

describe('Host Agent avatar server rendering', () => {
  it('keeps the real OneWorks renderer behind client readiness and emits initials', () => {
    const avatar = createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'Lead' })
    expect(() => renderToString(
      <HostAgentAvatar participant={{ id: 'lead', role: 'agent', name: 'Lead Agent', avatar }} />,
    )).not.toThrow()
    const markup = renderToString(
      <HostAgentAvatar participant={{ id: 'lead', role: 'agent', name: 'Lead Agent', avatar }} />,
    )
    expect(markup).toContain('data-avatar-state="fallback"')
    expect(markup).toContain('>LA<')
    expect(markup).not.toContain('oneworks-avatar')
  })
})
