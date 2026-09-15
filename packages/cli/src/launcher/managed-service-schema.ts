import type { ValidateFunction } from 'ajv'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { readManagedContainedFile } from './managed-service-runtime-support.js'

const PROTOCOL_SCHEMA_PREFIX = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/'
const DEFINITION_SCHEMA = `${PROTOCOL_SCHEMA_PREFIX}managed-service-definition.v1.schema.json`
const COMMON_SCHEMA = `${PROTOCOL_SCHEMA_PREFIX}managed-service-common.v1.schema.json`
const MAX_SCHEMA_BYTES = 512 * 1024
const require = createRequire(import.meta.url)
const MANAGED_SERVICE_ENVIRONMENT = {
  type: 'array',
  maxItems: 64,
  items: {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['variable', 'source', 'value'],
        properties: {
          variable: {
            type: 'string',
            pattern: '^[A-Z_][A-Z0-9_]{0,127}$',
          },
          source: {
            const: 'literal',
          },
          value: {
            type: 'string',
          },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['variable', 'source', 'path'],
        properties: {
          variable: {
            type: 'string',
            pattern: '^[A-Z_][A-Z0-9_]{0,127}$',
          },
          source: {
            const: 'service-home-relative-path',
          },
          path: {
            type: 'string',
            pattern: '^\./(?!.*(?:^|/)\.\.(?:/|$))[^\u0000]+$',
            maxLength: 512,
          },
        },
      },
    ],
  },
} as const

export interface ManagedServiceSchemaRegistryOptions {
  readonly schemas?: Readonly<Record<string, unknown>>
  readonly package?: ManagedServiceSchemaPackage
}

export interface ManagedServiceSchemaPackage {
  readonly source: `https://${string}`
  readonly artifactDirectory: string
  readonly resources: readonly {
    readonly path: `./${string}`
    readonly byteLength: number
    readonly digest: `sha256:${string}`
  }[]
}

function protocolRoot(): string {
  const declaration = require.resolve('@cordisx/protocol/managed-service/v1')
  return path.dirname(path.dirname(declaration))
}

function normalizeProtocolSchema(schema: string, value: unknown): unknown {
  if (schema !== DEFINITION_SCHEMA || value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  if (record.properties === null || typeof record.properties !== 'object' || Array.isArray(record.properties)) {
    return value
  }
  const properties = record.properties as Record<string, unknown>
  if (properties.environment !== undefined) return value
  return {
    ...record,
    properties: {
      ...properties,
      environment: MANAGED_SERVICE_ENVIRONMENT,
    },
  }
}

async function readProtocolSchema(schema: string): Promise<unknown> {
  if (!schema.startsWith(PROTOCOL_SCHEMA_PREFIX)) throw new Error('managed service schema is not available offline')
  const name = schema.slice(PROTOCOL_SCHEMA_PREFIX.length)
  if (!/^[a-z0-9][a-z0-9.-]*\.json$/.test(name)) throw new Error('managed service schema URL is invalid')
  const bytes = await readFile(path.join(protocolRoot(), 'schemas', name))
  if (bytes.byteLength > MAX_SCHEMA_BYTES) throw new Error('managed service schema is too large')
  return normalizeProtocolSchema(schema, JSON.parse(bytes.toString('utf8')) as unknown)
}

function packageSchemaPath(source: string, schema: string): `./schemas/${string}` | undefined {
  const canonical = new URL(source)
  const raw = new URL(schema)
  if (
    canonical.protocol !== 'https:' || raw.protocol !== 'https:' || raw.search !== '' || raw.hash !== ''
    || raw.username !== '' || raw.password !== ''
  ) return undefined
  let schemaParts: string[]
  if (canonical.hostname === 'github.com' && raw.hostname === 'raw.githubusercontent.com') {
    const sourceParts = canonical.pathname.replace(/\/$/u, '').split('/').filter(Boolean)
    const rawParts = raw.pathname.split('/').filter(Boolean)
    if (sourceParts.length !== 2 || rawParts.length < 5) return undefined
    const repository = sourceParts[1]!.replace(/\.git$/u, '')
    if (rawParts[0] !== sourceParts[0] || rawParts[1] !== repository) return undefined
    const schemas = rawParts.indexOf('schemas', 3)
    if (schemas < 3 || schemas === rawParts.length - 1) return undefined
    schemaParts = rawParts.slice(schemas + 1)
  } else {
    if (canonical.origin !== raw.origin) return undefined
    const schemaRoot = `${canonical.pathname.replace(/\/$/u, '')}/schemas/`
    if (!raw.pathname.startsWith(schemaRoot)) return undefined
    schemaParts = raw.pathname.slice(schemaRoot.length).split('/').filter(Boolean)
    if (schemaParts.length === 0) return undefined
  }
  const relative = `./schemas/${schemaParts.join('/')}`
  if (!/^\.\/schemas\/[A-Za-z0-9._/-]+$/u.test(relative) || relative.includes('..') || relative.includes('//')) {
    return undefined
  }
  return relative as `./schemas/${string}`
}

export class ManagedServiceSchemaRegistry {
  private readonly ajv: {
    addSchema(schema: unknown, key: string): void
    compile(schema: unknown): ValidateFunction
    errorsText(errors: ValidateFunction['errors'], options: { dataVar: string }): string
    getSchema(key: string): ValidateFunction | undefined
  }
  private readonly provided: Readonly<Record<string, unknown>>
  private readonly package: ManagedServiceSchemaPackage | undefined
  private readonly validators = new Map<string, Promise<ValidateFunction>>()
  private packageSchemas: Promise<void> | undefined

  constructor(options: ManagedServiceSchemaRegistryOptions = {}) {
    this.provided = options.schemas ?? {}
    this.package = options.package
    const Ajv2020 = require('ajv/dist/2020.js') as new(options: object) => typeof this.ajv
    const addFormats = require('ajv-formats') as (ajv: typeof this.ajv) => typeof this.ajv
    this.ajv = addFormats(new Ajv2020({ allErrors: true, strict: true }))
  }

  forPackage(package_: ManagedServiceSchemaPackage): ManagedServiceSchemaRegistry {
    return new ManagedServiceSchemaRegistry({ schemas: this.provided, package: package_ })
  }

  async validateDefinition(value: unknown): Promise<void> {
    await this.validate(DEFINITION_SCHEMA, value, 'managed service definition')
  }

  async validate(schema: string, value: unknown, label = 'managed service value'): Promise<void> {
    const validator = await this.validator(schema)
    if (validator(value)) return
    const message = this.ajv.errorsText(validator.errors, { dataVar: label })
    throw new Error(message || `${label} does not match ${schema}`)
  }

  private async validator(schema: string): Promise<ValidateFunction> {
    const existing = this.validators.get(schema)
    if (existing !== undefined) return await existing
    const loading = this.loadValidator(schema)
    this.validators.set(schema, loading)
    try {
      return await loading
    } catch (error) {
      this.validators.delete(schema)
      throw error
    }
  }

  private async loadValidator(schema: string): Promise<ValidateFunction> {
    if (schema === DEFINITION_SCHEMA && this.ajv.getSchema(COMMON_SCHEMA) === undefined) {
      this.ajv.addSchema(this.provided[COMMON_SCHEMA] ?? await readProtocolSchema(COMMON_SCHEMA), COMMON_SCHEMA)
    }
    if (schema.startsWith(PROTOCOL_SCHEMA_PREFIX)) return this.ajv.compile(await readProtocolSchema(schema))
    if (this.package !== undefined && packageSchemaPath(this.package.source, schema) !== undefined) {
      if (this.provided[schema] !== undefined) throw new Error('managed service package schema source is conflicting')
      await (this.packageSchemas ??= this.loadPackageSchemas())
      const validator = this.ajv.getSchema(schema)
      if (validator !== undefined) return validator
    }
    const provided = this.provided[schema]
    if (provided !== undefined) return this.ajv.compile(provided)
    throw new Error('managed service schema is not available offline')
  }

  private async loadPackageSchemas(): Promise<void> {
    const package_ = this.package!
    const schemas = package_.resources.filter(resource => resource.path.startsWith('./schemas/'))
    const seen = new Set<string>()
    for (const resource of schemas) {
      const bytes = await readManagedContainedFile(package_.artifactDirectory, resource.path, MAX_SCHEMA_BYTES)
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
      if (bytes.byteLength !== resource.byteLength || digest !== resource.digest) {
        throw new Error('managed service package schema failed integrity readback')
      }
      const value = JSON.parse(bytes.toString('utf8')) as unknown
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('managed service package schema must be an object')
      }
      const id = (value as { readonly $id?: unknown }).$id
      if (typeof id !== 'string' || packageSchemaPath(package_.source, id) !== resource.path || seen.has(id)) {
        throw new Error('managed service package schema identity is missing or conflicting')
      }
      seen.add(id)
      this.ajv.addSchema(value, id)
    }
  }
}
