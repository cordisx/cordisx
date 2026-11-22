import { createServer, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { startHeadlessCodexBackend } from '../packages/cli/src/launcher/headless-codex-backend.js'
import { ChannelNativeSessions } from '../packages/cli/src/launcher/channel-native-sessions.js'
import { ChannelConversationConsumer } from '../packages/cli/src/launcher/channel-conversation-consumer.js'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { ChannelInboundResources } from '../packages/cli/src/launcher/channel-inbound-resources.js'
import type { ChannelUserInput } from '@cordisx/channel-runtime'
import { Readable } from 'node:stream'

const executable = process.env.CORDISX_STEER_NATIVE_TEST_EXECUTABLE
it.skipIf(!executable)(
  'real native backend consumes one follow-up and image in the current turn without another final reply',
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cx-steer-native-'))
    const codexHome = path.join(root, 'native')
    const bodies: string[] = [], replies: string[] = [], reactions: string[] = []
    let held: ServerResponse | undefined
    const emit = (response: ServerResponse, event: { type: string; [key: string]: unknown }) => {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    }
    const finish = (response: ServerResponse, number: number, item: unknown) => {
      emit(response, { type: 'response.output_item.done', output_index: 0, item })
      emit(response, {
        type: 'response.completed',
        response: {
          id: `response-${number}`,
          object: 'response',
          status: 'completed',
          output: [item],
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            total_tokens: 12,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      })
      response.end()
    }
    const model = createServer(async (request, response) => {
      if (request.method !== 'POST') {
        response.end('{"data":[{"id":"fixture-model"}]}')
        return
      }
      let body = ''
      for await (const chunk of request) body += chunk
      bodies.push(body)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      emit(response, {
        type: 'response.created',
        response: { id: `response-${bodies.length}`, status: 'in_progress', output: [] },
      })
      if (bodies.length === 1) held = response
      else {finish(response, bodies.length, {
          id: `message-${bodies.length}`,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'SYNTHETIC_FINAL', annotations: [] }],
        })}
    })
    let backend: Awaited<ReturnType<typeof startHeadlessCodexBackend>> | undefined
    let consumer: ChannelConversationConsumer | undefined
    const resources = new ChannelInboundResources()
    try {
      await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
      const address = model.address()
      if (!address || typeof address === 'string') throw Error('MOCK_ADDRESS_UNAVAILABLE')
      await mkdir(codexHome)
      await writeFile(
        path.join(codexHome, 'config.toml'),
        `model_provider="fixture"\nmodel="fixture-model"\napproval_policy="never"\nsandbox_mode="workspace-write"\n[model_providers.fixture]\nname="fixture"\nbase_url="http://127.0.0.1:${address.port}/v1"\nenv_key="FIXTURE_KEY"\nwire_api="responses"\n`,
        { mode: 0o600 },
      )
      let native: ChannelNativeSessions
      backend = await startHeadlessCodexBackend({
        codexExecutable: executable!,
        codexHome,
        home: root,
        environment: {
          PATH: process.env.PATH,
          HOME: root,
          TMPDIR: process.env.TMPDIR,
          FIXTURE_KEY: 'synthetic',
          NO_PROXY: '127.0.0.1,localhost',
          HTTP_PROXY: 'http://127.0.0.1:9',
          HTTPS_PROXY: 'http://127.0.0.1:9',
          CORDISX_HEADLESS_PROVIDER_ID: 'fixture',
          CORDISX_HEADLESS_MODEL_ID: 'fixture-model',
        },
        onRequest: () => ({ decision: 'decline' }),
        onDispatch: (operation, session, turn) => native?.observedDispatch(operation, session, turn),
      })
      native = new ChannelNativeSessions({
        cwd: root,
        providerId: 'fixture',
        model: 'fixture-model',
        bridge: () => backend as never,
        nativeRequest: backend.nativeRequest,
        models: backend.models,
      })
      const account = { adapterId: 'feishu', accountId: 'fixture', tenantId: 'synthetic' }
      const source = {
        ...account,
        conversationId: 'oc_fixture',
        kind: 'direct' as const,
        threadId: 'oc_fixture',
        semantics: 'conversation' as const,
      }
      const message = (id: string, text: string): ChannelUserInput => ({
        contract: 'cordisx.channel-user-input/v1',
        schemaVersion: 1,
        role: 'user',
        receivedAt: new Date().toISOString(),
        source: {
          kind: 'channel',
          event: { ...source, eventId: id, messageId: id, actor: { ...account, userId: 'alice' } },
        },
        content: [{ type: 'text', text }],
      })
      consumer = await ChannelConversationConsumer.open({
        file: path.join(root, 'consumer.json'),
        profileId: 'test',
        native: () => native,
        access: () =>
          ({
            generation: 'test',
            accounts: () => [{ ref: account, state: 'ready' }],
            runtime: {
              inputsSince: async (_caller: unknown, _filters: unknown, cursor: string) => ({ cursor, messages: [] }),
              notifyOnce: async (value: { text: string }) => {
                replies.push(value.text)
                return { deliveryId: 'sent' }
              },
              deliverySnapshot: () => ({ state: 'sent' }),
            },
            feedbackReact: async (_event: unknown, emoji: string) => {
              reactions.push(emoji)
              return { reactionId: `reaction-${reactions.length}`, emojiType: emoji }
            },
            feedbackRemove: async () => ({ removed: true }),
            drain: async () => {},
          }) as never,
      })
      consumer.setNativeExtras(() => native)
      await consumer.policySet({ enabled: true, autoCreate: true, autoReply: true }, 0)
      await consumer.receive('initial', message('initial', 'Start synthetic work'))
      await vi.waitFor(async () => {
        await consumer!.pump()
        const jobs = (consumer as unknown as { store: ChannelConversationStore }).store.snapshot().jobs
        expect(Object.values(jobs).some(job => job.state === 'running')).toBe(true)
        expect(held).toBeDefined()
      }, { timeout: 20_000 })
      const followup = message('followup', 'SYNTHETIC_ADJUSTMENT')
      const image = await resources.ingest(
        followup.source.event,
        Readable.from([
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'base64',
          ),
        ]),
        'image',
      )
      const combined = { ...followup, content: [...followup.content, image] }
      await consumer.receive('followup', combined)
      await vi.waitFor(async () => {
        await consumer!.pump()
        const jobs = Object.values((consumer as unknown as { store: ChannelConversationStore }).store.snapshot().jobs)
        expect(jobs.find(job => job.recordId === 'followup')).toMatchObject({
          state: 'running',
          steeredInto: jobs.find(job => job.recordId === 'initial')?.turnId,
        })
      }, { timeout: 10_000 })
      await consumer.receive('followup', combined)
      finish(held!, 1, {
        type: 'function_call',
        id: 'call-item',
        call_id: 'synthetic-read',
        name: 'exec_command',
        arguments: '{"cmd":"pwd","yield_time_ms":1000}',
        status: 'completed',
      })
      await vi.waitFor(async () => {
        await consumer!.pump()
        expect(replies).toEqual(['SYNTHETIC_FINAL'])
      }, { timeout: 20_000 })
      await consumer.pump()
      const jobs = Object.values((consumer as unknown as { store: ChannelConversationStore }).store.snapshot().jobs)
      expect(new Set(jobs.map(job => job.turnId)).size).toBe(1)
      expect(jobs).toHaveLength(2)
      expect(bodies.at(-1)?.split('SYNTHETIC_ADJUSTMENT').length! - 1).toBe(1)
      expect(bodies.at(-1)).toContain('input_image')
      expect(reactions.filter(emoji => emoji === 'OnIt')).toHaveLength(2)
    } finally {
      held?.destroy()
      await consumer?.dispose()
      await backend?.close()
      await resources.dispose()
      model.closeAllConnections()
      await new Promise<void>(resolve => model.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  },
  60_000,
)
