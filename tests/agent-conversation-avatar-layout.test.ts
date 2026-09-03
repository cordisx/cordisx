import { describe, expect, it } from 'vitest'

import { AGENT_CONVERSATION_STYLES } from '../packages/cli/src/renderer/host-ui/conversation/styles.js'

describe('agent conversation avatar layout', () => {
  it('pins agent avatars to the bottom of a stretched message row without changing interaction affordances', () => {
    expect(AGENT_CONVERSATION_STYLES).toContain(
      '.cxa-message-bubble-row{display:flex;min-width:0;max-width:100%;align-items:stretch;gap:var(--cxa-message-avatar-gap)}',
    )
    expect(AGENT_CONVERSATION_STYLES).toContain(
      '.cxa-message-avatar-seat{display:grid;width:var(--cxa-message-avatar-size);min-height:var(--cxa-message-avatar-size);height:auto;flex:0 0 var(--cxa-message-avatar-size);align-self:stretch;place-items:end center}',
    )
    expect(AGENT_CONVERSATION_STYLES).toContain(
      '.cxa-message-avatar-seat>.cx-agent-identity-avatar-button,.cxa-message-avatar-seat .cxa-avatar{width:100%;height:var(--cxa-message-avatar-size);align-self:end}',
    )
    expect(AGENT_CONVERSATION_STYLES).toContain(
      '.cx-agent-identity-avatar-button:hover{filter:brightness(1.04)}',
    )
    expect(AGENT_CONVERSATION_STYLES).toContain(
      '.cx-agent-identity-avatar-button:focus-visible{outline:2px solid var(--cx-focus,var(--cx-primary));outline-offset:2px;box-shadow:none}',
    )
  })
})
