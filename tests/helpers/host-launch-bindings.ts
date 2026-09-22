import { type Node, parse, type Property } from 'acorn'
import { expect } from 'vitest'
import { pathToFileURL } from 'node:url'

export async function configuredHostLaunchBinding(bootstrapSource: string, source: string, entry: string) {
  const origin = bootstrapSource.match(/http:\/\/127\.0\.0\.1:\d+\/cordisx-host-generation\/[a-f0-9]{64}/u)?.[0]
  if (origin === undefined) throw new Error('production Host graph origin is missing')
  const response = await fetch(`${origin}/launch.js`)
  expect(response.status).toBe(200)
  const launchSource = await response.text()
  expect(source).toContain(launchSource)
  const bindings = hostLaunchBindings(launchSource)
  expect(bindings).toHaveLength(1)
  const binding = bindings[0]!
  expect(binding).toMatchObject({ source: pathToFileURL(entry).href, pluginId: 'owner-documents-runtime' })
  expect(binding.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u)
  expect(bootstrapSource).not.toContain(binding.token)
  expect(JSON.parse(Buffer.from(binding.token.split('.')[0]!, 'base64url').toString('utf8'))).toMatchObject({
    moduleGeneration: binding.moduleGeneration,
  })
  return binding
}

/** Read the literal authority metadata from the served launch module, without executing plugins. */
export function hostLaunchBindings(source: string): readonly {
  source: string
  pluginId: string
  moduleGeneration: string
  token: string
}[] {
  const bindings: Property[] = []
  const visit = (node: Node): void => {
    if (node.type === 'Property') {
      const property = node as Property
      const key = property.key
      if (
        !property.computed && (key.type === 'Identifier' ? key.name : key.type === 'Literal' ? key.value : undefined)
          === 'ownerDocumentBindings'
      ) bindings.push(property)
    }
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === 'object' && typeof child.type === 'string') visit(child)
      }
    }
  }
  visit(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }))
  if (bindings.length !== 1 || bindings[0]!.value.type !== 'ArrayExpression') {
    throw new Error('Expected one literal owner-document binding array in the launch module')
  }
  const value = bindings[0]!.value
  return JSON.parse(source.slice(value.start, value.end))
}
