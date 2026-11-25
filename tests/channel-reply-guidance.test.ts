import { describe, expect, it } from 'vitest'
import { channelReplyGuidance } from '../packages/cli/src/launcher/channel-reply-guidance.js'

describe('Channel proactive reply guidance', () => {
  it.each([false, true])('allows selected multiple sends without exporting local reasoning, auto=%s', enabled => {
    const prompt = channelReplyGuidance(enabled).join('\n')
    expect(prompt).toContain('send the useful answer naturally through the configured Channel CLI')
    expect(prompt).toContain('Do not rely on the local final answer')
    expect(prompt).toContain('do not append routine reliability disclaimers')
    expect(prompt).toContain('Multiple sends in one turn are allowed')
    expect(prompt).toContain('Never forward private reasoning, analysis, tool arguments/results')
    expect(prompt).toContain('distinct stable operationId')
    expect(prompt).toContain('never blindly retry')
    expect(prompt).toContain('does not schedule a wakeup')
  })

  it('preserves opt-in defaults and limits none to the exact eligible turn', () => {
    expect(channelReplyGuidance(false).join('\n')).toContain('Automatic final-response delivery is disabled')
    const prompt = channelReplyGuidance(true).join('\n')
    expect(prompt).toContain('as a fallback')
    expect(prompt).toContain('A progress message must NOT select none')
    expect(prompt).toContain('For a terminal-intent send the Host reconciles the exact receipt')
    expect(prompt).toContain('uncertain legacy terminal send can still duplicate')
    expect(prompt).toContain('silence or manual-only')
    expect(prompt).toContain('applies only to this turn')
    expect(prompt).toContain('Do not change global forwarding settings')
  })
})
