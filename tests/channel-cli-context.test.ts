import { describe, expect, it } from 'vitest'
import { channelCliSendInstructions } from '../packages/cli/src/launcher/channel-cli-context.js'

const cli = { node: '/node', entry: '/cli.js', home: '/home', profile: 'fixture' }

describe('Channel route selection guidance', () => {
  it('prefers richtext only for explicit CLI sends and retains text and safety boundaries', () => {
    const prompt = channelCliSendInstructions(cli).join('\n')
    expect(prompt).toContain('prefer richtext for ordinary prose, progress and results')
    expect(prompt).toContain('including a single plain block')
    expect(prompt).toContain('verbatim original text, an explicit plain-text request, or compatibility')
    expect(prompt).toContain('retain their plain-text wire semantics')
    expect(prompt).toContain('not Markdown parsing')
    expect(prompt).toContain('Image, audio, file, video and card remain distinct types')
    expect(prompt).toContain('never permission or send failures')
    expect(prompt).toContain('Host capabilities and authorization')
    expect(prompt).toContain('Only receipt.state=sent proves delivery')
    expect(prompt).toContain('never blindly resend')
    expect(prompt).toContain('not a change to automatic final-response runtime defaults')
  })

  it.each([undefined, cli])('guides progress and final without persistent routing state, cli=%j', context => {
    const prompt = channelCliSendInstructions(context, 'scope-token').join('\n')
    expect(prompt).toContain('not a persistent current-chat-location rule')
    expect(prompt).toContain('progress sends and terminal results, including automatic final delivery')
    expect(prompt).toContain('has not explicitly asked to return to the main conversation')
    expect(prompt).toContain('continue synchronizing in that original topic')
    expect(prompt).toContain('unless the user asks to change destination')
    expect(prompt).toContain('target.replyMode conversation for explicit sends')
    expect(prompt).toContain('channel_reply_mode conversation for an enabled automatic final')
    expect(prompt).toContain('target.replyMode thread with its verified anchor as replyTo')
    expect(prompt).toContain('prefer source.threadId as the topic anchor')
    expect(prompt).toContain('Never guess replyTo or a topic ID')
    expect(prompt).toContain('subject to existing permissions')
    expect(prompt).toContain('cannot accept a custom replyTo')
    expect(prompt).toContain('only after confirmed terminal delivery')
    expect(prompt).toContain('Do not change global settings or bindings to track routing location')
    expect(prompt).not.toContain('require the source messageId as replyTo')
  })

  it('retains scoped CLI commands and unavailable-runtime boundaries', () => {
    const configured = channelCliSendInstructions(cli, 'scope-token').join('\n')
    expect(configured).toContain("--profile 'fixture' --context 'scope-token'")
    expect(configured).toContain('Choose target.replyMode per send')
    expect(configured).toContain('verified message or topic anchor as replyTo')
    expect(configured).toContain('help media-prepare')
    expect(configured).toContain('begin, chunk and commit')
    expect(configured).toContain('Unsupported types reject')
    expect(configured).toContain('Never pass arbitrary paths or URLs')
    expect(channelCliSendInstructions(undefined).join('\n'))
      .toContain('If its runtime scope is unavailable, report that locally; do not forward your final answer')
  })
})
