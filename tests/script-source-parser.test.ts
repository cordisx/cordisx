import { describe, expect, it } from 'vitest'
import { parseScriptSourceConfig, scriptEnvironment } from '../packages/cli/src/launcher/model-catalog/script-schema.js'
import { parseScriptOutput } from '../packages/cli/src/launcher/model-catalog/script-output-parser.js'

const bytes = (text: string) => Buffer.from(text)
const catalog = (models: unknown[]) => bytes(JSON.stringify({ schemaVersion: 1, complete: true, models }))

describe('strict script output boundary', () => {
  it('accepts complete-empty and preserves exact IDs, safe labels and first duplicate', () => {
    expect(parseScriptOutput(catalog([]), 'replace')).toEqual([])
    const result = parseScriptOutput(
      catalog([{ id: ' X ', label: 'First' }, { id: ' X ', label: 'Second' }, { id: 'x' }]),
      'supplement',
    )
    expect(result.map(model => [model.id, model.label])).toEqual([[' X ', 'First'], ['x', 'x']])
    expect(result[0]?.provenance).toEqual(['script-supplement'])
    expect(Object.isFrozen(result[0])).toBe(true)
  })

  it.each([
    '',
    '```json\n{}\n```',
    '{}\n{}',
    '{"schemaVersion":1,"complete":false,"models":[]}',
    '{"schemaVersion":1,"complete":true,"models":[],"endpoint":"https://fixture.invalid"}',
    '{"schemaVersion":1,"complete":false,"complete":true,"models":[]}',
    '{"schemaVersion":1,"complete":true,"models":[{"id":"bad","\\u0069d":"hidden"}]}',
    '{"schemaVersion":1,"complete":true,"models":[],"__proto__":{}}',
  ])('rejects invalid or ambiguous document without echoing data: %s', value => {
    expect(() => parseScriptOutput(bytes(value), 'replace')).toThrow('script-output-invalid')
  })

  it.each(['capabilities', 'tokens', 'endpoint', 'scope', 'auth', 'commands', 'aliases', 'provenance'])(
    'rejects %s authority fields',
    key => {
      expect(() => parseScriptOutput(catalog([{ id: 'one', [key]: true }]), 'replace')).toThrow('script-output-invalid')
    },
  )

  it.each(['', ' ', '\u0000', '\u0085', '\ud800'])('rejects unsafe exact ID %j', id => {
    expect(() => parseScriptOutput(catalog([{ id }]), 'replace')).toThrow('script-output-invalid')
  })

  it('rejects invalid UTF-8, BOM, limits and JSONL rather than replacing bytes', () => {
    expect(() => parseScriptOutput(Buffer.from([0xc3, 0x28]), 'replace')).toThrow('script-output-invalid')
    expect(() => parseScriptOutput(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), catalog([])]), 'replace')).toThrow(
      'script-output-invalid',
    )
    expect(() => parseScriptOutput(Buffer.alloc(1_048_577), 'replace')).toThrow('script-budget-exceeded')
    expect(() => parseScriptOutput(catalog([{ id: 'a' }, { id: 'b' }]), 'replace', 1)).toThrow('script-budget-exceeded')
    expect(() => parseScriptOutput(catalog([{ id: 'x'.repeat(513) }]), 'replace')).toThrow('script-output-invalid')
  })
})

const command = {
  schemaVersion: 1,
  command: { kind: 'exec', executable: 'node', args: [] },
  cwd: '/tmp',
}

describe('strict structured command schema', () => {
  it('has bounded defaults and requires explicit shell mode', () => {
    expect(parseScriptSourceConfig(command)).toMatchObject({
      timeoutMs: 10_000,
      maxModels: 1000,
      maxStderrBytes: 65_536,
      environment: { inherit: false },
    })
    expect(
      parseScriptSourceConfig({ ...command, command: { kind: 'shell', command: 'node ./models.cjs' } }).command.kind,
    ).toBe('shell')
    expect(() => parseScriptSourceConfig({ ...command, shell: true })).toThrow('script-command-invalid')
  })
  it('defaults to no environment and allows explicit credential references or inheritance', () => {
    const host = { DEEPSEEK_API_KEY: 'fixture-secret', OTHER: 'value' }
    expect(scriptEnvironment(parseScriptSourceConfig(command), host)).toEqual({})
    const refs = parseScriptSourceConfig({
      ...command,
      environment: { inherit: false, refs: { API_KEY: 'DEEPSEEK_API_KEY' }, values: { LABEL: 'fixture' } },
    })
    expect(scriptEnvironment(refs, host)).toEqual({ API_KEY: 'fixture-secret', LABEL: 'fixture' })
    expect(() => scriptEnvironment(refs, {})).toThrow('script-environment-missing')
    const inherited = parseScriptSourceConfig({ ...command, environment: { inherit: true, refs: {}, values: {} } })
    expect(scriptEnvironment(inherited, host)).toEqual(host)
  })
  it('rejects extra fields, implicit triggers, budgets and ambiguous environment', () => {
    for (
      const patch of [
        { shell: true },
        { triggers: { interval: true } },
        { credentials: { mode: 'provider' } },
        { timeoutMs: 60_001 },
        { maxModels: 1001 },
        { cwd: 'relative' },
        { command: { kind: 'exec', executable: 'node', args: ['x'.repeat(4097)] } },
        { environment: { inherit: false, refs: { LANG: 'LANG' }, values: { LANG: 'C' } } },
      ]
    ) expect(() => parseScriptSourceConfig({ ...command, ...patch })).toThrow('script-command-invalid')
  })
})
