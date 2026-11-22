import { callChannelCli } from './channel-cli-transport.js'
import { parseChannelCliMedia } from './channel-cli-media.js'
import { type ChannelCliScope, requireCliValue } from './channel-cli-scope.js'
import { serveChannelCli } from './channel-cli-session.js'
import { runConfiguredChannelCommand } from './channel-configured-command.js'
import { channelCliHelp } from './channel-command-help.js'

const HELP =
  `cordisx channel connections|conversations|bind|unbind|bind-status|reply-mode|history|remote-history|message-get|listen|send|send-many|ask|question-cancel|receipt|policy|policy-set [--profile <id>] [--input <JSON>]
  Uses the existing configured Channel runtime. Bind/history support sessionId; operationId identifies a send.
Diagnostic-only:
cordisx channel serve --directory <new-absolute-directory> --adapter <feishu|lark> --account <id> --tenant <id> --conversation <id> --actor <id> --match <text> --duration <seconds>
  Reads one JSON line {"appSecret":"..."} from stdin. Starts an exact, short-lived connection.
cordisx channel listen --binding <binding.json> --timeout <seconds>
cordisx channel send --binding <binding.json> --operation <id> --text <text>
cordisx channel status|readback|stop --binding <binding.json>`

function parseOptions(args: readonly string[], allowed: readonly string[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (
      key === undefined || !allowed.includes(key) || value === undefined || value.startsWith('--')
      || result[key] !== undefined
    ) {
      throw new Error('invalid channel options')
    }
    result[key] = value
  }
  return result
}

function seconds(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (!/^[0-9]+$/u.test(value)) throw new Error('invalid duration')
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new Error('invalid duration')
  return result
}

async function readSecret(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('credential input requires a non-echoing pipe')
  let source = ''
  for await (const chunk of process.stdin) {
    source += String(chunk)
    if (Buffer.byteLength(source) > 20_000) throw new Error('credential input too large')
    if (source.includes('\n')) break
  }
  const line = source.split('\n', 1)[0] ?? ''
  source = ''
  const input = JSON.parse(line) as { appSecret?: unknown }
  if (
    input === null || typeof input !== 'object' || Object.keys(input).length !== 1
    || typeof input.appSecret !== 'string'
  ) {
    throw new Error('credential input invalid')
  }
  return requireCliValue(input.appSecret, 'credential', 16_384)
}

export async function runChannelCommand(
  args: readonly string[],
  stdout: (line: string) => void = console.log,
): Promise<void> {
  const action = args[0]
  if (action === undefined || action === '--help' || action === 'help') {
    return stdout(args[1] === 'diagnostic' ? HELP : channelCliHelp(args[1]))
  }
  if (args.includes('--help') && !args.includes('--binding')) return stdout(channelCliHelp(action))
  if (action !== 'serve' && !args.includes('--binding')) return runConfiguredChannelCommand(args, stdout)
  if (action === 'serve') {
    const values = parseOptions(args.slice(1), [
      '--directory',
      '--adapter',
      '--account',
      '--tenant',
      '--conversation',
      '--actor',
      '--match',
      '--duration',
    ])
    const adapter = requireCliValue(values['--adapter'], 'adapter')
    if (adapter !== 'feishu' && adapter !== 'lark') throw new Error('unsupported adapter')
    const scope: ChannelCliScope = {
      adapter,
      account: requireCliValue(values['--account'], 'account'),
      tenant: requireCliValue(values['--tenant'], 'tenant'),
      conversation: requireCliValue(values['--conversation'], 'conversation'),
      actor: requireCliValue(values['--actor'], 'actor'),
      match: requireCliValue(values['--match'], 'match', 8192),
    }
    const directory = requireCliValue(values['--directory'], 'directory')
    const durationSeconds = seconds(values['--duration'], 300, 900)
    const secret = await readSecret()
    await serveChannelCli({ directory, durationSeconds, scope, secret, stdout })
    return
  }
  if (!['listen', 'send', 'status', 'readback', 'stop'].includes(action)) throw new Error('unknown channel action')
  const allowed = action === 'listen'
    ? ['--binding', '--timeout']
    : action === 'send'
    ? ['--binding', '--operation', '--text', '--media']
    : ['--binding']
  const values = parseOptions(args.slice(1), allowed)
  const binding = requireCliValue(values['--binding'], 'binding')
  const timeout = action === 'listen' ? seconds(values['--timeout'], 300, 900) : 30
  if (values['--media'] !== undefined && values['--text'] !== undefined) throw new Error('MEDIA_TEXT_CONFLICT')
  const request = action === 'send'
    ? {
      action,
      operationId: requireCliValue(values['--operation'], 'operation', 128),
      ...(values['--media'] === undefined
        ? { text: requireCliValue(values['--text'], 'text', 8192) }
        : { media: parseChannelCliMedia(values['--media']) }),
    }
    : { action }
  let readbackMatches = true
  await callChannelCli(binding, request, line => {
    stdout(line)
    if (action === 'readback') {
      const value = JSON.parse(line) as { inboundMatches?: boolean; outboundMatches?: boolean }
      readbackMatches = value.inboundMatches === true && value.outboundMatches === true
    }
  }, timeout * 1000)
  if (!readbackMatches) throw new Error('channel readback mismatch')
}
