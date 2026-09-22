import { createRequire } from 'node:module'
import path from 'node:path'
import type { ValidateFunction } from 'ajv'
import { type ScriptSourceConfig, ScriptSourceError } from './script-types.js'

const require = createRequire(import.meta.url)
const Ajv = require('ajv/dist/2020.js') as new(options: object) => { compile(schema: unknown): ValidateFunction }
const ajv = new Ajv({ strict: true, allErrors: false, ownProperties: true })
const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength })
const integer = (maximum: number) => ({ type: 'integer', minimum: 1, maximum })

export const SCRIPT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'complete', 'models'],
  properties: {
    schemaVersion: { const: 1 },
    complete: { const: true },
    models: {
      type: 'array',
      maxItems: 1000,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: { id: text(512), label: text(256) },
      },
    },
  },
} as const

const configSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'command', 'cwd'],
  properties: {
    schemaVersion: { const: 1 },
    cwd: text(4096),
    command: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'executable', 'args'],
          properties: {
            kind: { const: 'exec' },
            executable: text(4096),
            args: { type: 'array', maxItems: 128, items: { type: 'string', maxLength: 4096 } },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'command'],
          properties: { kind: { const: 'shell' }, command: text(65_536) },
        },
      ],
    },
    environment: {
      type: 'object',
      additionalProperties: false,
      required: ['inherit', 'refs', 'values'],
      properties: {
        inherit: { type: 'boolean' },
        refs: { type: 'object', maxProperties: 128, additionalProperties: text(256) },
        values: { type: 'object', maxProperties: 128, additionalProperties: { type: 'string', maxLength: 4096 } },
      },
    },
    timeoutMs: integer(60_000),
    maxStdoutBytes: integer(1_048_576),
    maxStderrBytes: integer(65_536),
    maxModels: integer(1000),
  },
}
const validateConfig = ajv.compile(configSchema)
export const validateScriptOutput = ajv.compile(SCRIPT_OUTPUT_SCHEMA)
export const safeScriptText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && value.trim().length > 0
  && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value)
const envName = (name: string) => /^[A-Za-z_][A-Za-z0-9_]{0,255}$/u.test(name)

/** Saving this structured configuration is the trust decision; there is no per-run grant. */
export function parseScriptSourceConfig(value: unknown): ScriptSourceConfig {
  if (!validateConfig(value)) throw new ScriptSourceError('script-command-invalid')
  const source = value as ScriptSourceConfig
  const command = source.command
  const environment = source.environment ?? { inherit: false, refs: {}, values: {} }
  if (
    !path.isAbsolute(source.cwd) || source.cwd.includes('\0')
    || (command.kind === 'exec' && (command.executable.includes('\0') || command.args.some(arg => arg.includes('\0'))
      || command.args.reduce((sum, arg) => sum + Buffer.byteLength(arg), 0) > 65_536))
    || (command.kind === 'shell' && command.command.includes('\0'))
    || [...Object.keys(environment.refs), ...Object.values(environment.refs), ...Object.keys(environment.values)].some(
      name => !envName(name),
    )
    || Object.values(environment.values).some(value => value.includes('\0'))
    || Object.keys(environment.refs).some(name => Object.hasOwn(environment.values, name))
    || Object.values(environment.values).reduce((sum, value) => sum + Buffer.byteLength(value), 0) > 65_536
  ) throw new ScriptSourceError('script-command-invalid')
  return Object.freeze({
    schemaVersion: 1,
    command: command.kind === 'exec'
      ? Object.freeze({ ...command, args: Object.freeze([...command.args]) })
      : Object.freeze({ ...command }),
    cwd: source.cwd,
    environment: Object.freeze({
      inherit: environment.inherit,
      refs: Object.freeze({ ...environment.refs }),
      values: Object.freeze({ ...environment.values }),
    }),
    timeoutMs: source.timeoutMs ?? 10_000,
    maxStdoutBytes: source.maxStdoutBytes ?? 1_048_576,
    maxStderrBytes: source.maxStderrBytes ?? 65_536,
    maxModels: source.maxModels ?? 1000,
  })
}

export function scriptEnvironment(
  config: ScriptSourceConfig,
  host: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const env: Record<string, string> = Object.create(null) as Record<string, string>
  if (config.environment.inherit) {
    for (const [key, value] of Object.entries(host)) if (value !== undefined) env[key] = value
  }
  for (const [key, ref] of Object.entries(config.environment.refs)) {
    const value = host[ref]
    if (value === undefined) throw new ScriptSourceError('script-environment-missing')
    env[key] = value
  }
  Object.assign(env, config.environment.values)
  if (
    Object.entries(env).reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value), 0)
      > 1_048_576
    || Object.entries(env).some(([key, value]) => key.includes('\0') || value.includes('\0'))
  ) throw new ScriptSourceError('script-budget-exceeded')
  return Object.freeze(env)
}
