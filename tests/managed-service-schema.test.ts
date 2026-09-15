import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ManagedServiceSchemaRegistry } from '../packages/cli/src/launcher/managed-service-schema.js'

const SOURCE = 'https://github.com/example/managed-plugin' as const
const SCHEMA = 'https://raw.githubusercontent.com/example/managed-plugin/main/schemas/value.v1.schema.json'
const PRIVATE_SOURCE = 'https://code.example.test/team/managed-plugin' as const
const PRIVATE_SCHEMA = 'https://code.example.test/team/managed-plugin/schemas/value.v1.schema.json'

async function packageSchema(
  id: string = SCHEMA,
): Promise<{
  readonly root: string
  readonly resource: {
    readonly path: './schemas/value.v1.schema.json'
    readonly byteLength: number
    readonly digest: `sha256:${string}`
  }
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-managed-schema-'))
  await mkdir(path.join(root, 'schemas'))
  const bytes = Buffer.from(`${
    JSON.stringify({
      $id: id,
      type: 'object',
      required: ['value'],
      properties: { value: { type: 'boolean' } },
    })
  }\n`)
  await writeFile(path.join(root, 'schemas', 'value.v1.schema.json'), bytes)
  return {
    root,
    resource: {
      path: './schemas/value.v1.schema.json',
      byteLength: bytes.byteLength,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    },
  }
}

describe('managed service package schema registry', () => {
  it('loads an admitted package schema offline and enforces its $id', async () => {
    const fixture = await packageSchema()
    const registry = new ManagedServiceSchemaRegistry().forPackage({
      source: SOURCE,
      artifactDirectory: fixture.root,
      resources: [fixture.resource],
    })
    await expect(registry.validate(SCHEMA, { value: true })).resolves.toBeUndefined()
    await expect(registry.validate(SCHEMA, {})).rejects.toThrow('required property')
  })

  it('loads an admitted package schema from a same-origin HTTPS source', async () => {
    const fixture = await packageSchema(PRIVATE_SCHEMA)
    const registry = new ManagedServiceSchemaRegistry().forPackage({
      source: PRIVATE_SOURCE,
      artifactDirectory: fixture.root,
      resources: [fixture.resource],
    })
    await expect(registry.validate(PRIVATE_SCHEMA, { value: true })).resolves.toBeUndefined()
    await expect(registry.validate(PRIVATE_SCHEMA, {})).rejects.toThrow('required property')
    await expect(registry.validate(
      'https://code.example.test/team/other-plugin/schemas/value.v1.schema.json',
      {},
    )).rejects.toThrow('not available offline')
  })

  it('rejects missing, mismatched, and escaping package schema identities', async () => {
    const fixture = await packageSchema(
      'https://raw.githubusercontent.com/example/other/main/schemas/value.v1.schema.json',
    )
    const missing = new ManagedServiceSchemaRegistry().forPackage({
      source: SOURCE,
      artifactDirectory: fixture.root,
      resources: [],
    })
    await expect(missing.validate(SCHEMA, {})).rejects.toThrow('not available offline')

    const mismatched = new ManagedServiceSchemaRegistry().forPackage({
      source: SOURCE,
      artifactDirectory: fixture.root,
      resources: [fixture.resource],
    })
    await expect(mismatched.validate(SCHEMA, {})).rejects.toThrow('identity is missing or conflicting')
    await expect(mismatched.validate(
      'https://raw.githubusercontent.com/example/managed-plugin/main/schemas/../outside.json',
      {},
    )).rejects.toThrow('not available offline')

    const conflicting = new ManagedServiceSchemaRegistry({
      schemas: { [SCHEMA]: { $id: SCHEMA, type: 'null' } },
    }).forPackage({
      source: SOURCE,
      artifactDirectory: fixture.root,
      resources: [fixture.resource],
    })
    await expect(conflicting.validate(SCHEMA, {})).rejects.toThrow('conflicting')
  })
})
