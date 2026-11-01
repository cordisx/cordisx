import type { NativeAccountCapabilityDescriptor } from './contracts.js'
import type { NativeScriptResource } from './native-submission-structure.js'
import { member, one, parseNativeSource, type SyntaxNode, visitSyntax } from './native-source-structure.js'

/** Resolve the exported service actually used by the native account query. */
export function discoverNativeAccountCapabilityFromSyntax(
  resource: NativeScriptResource,
  ast: SyntaxNode,
  resources: readonly NativeScriptResource[] = [resource],
): NativeAccountCapabilityDescriptor {
  const receivers = new Map<string, Set<'accessInputs' | 'accountInfo'>>()
  visitSyntax(ast, (node, parents) => {
    if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier') return
    const value = node.init?.type === 'ChainExpression' ? node.init.expression : node.init
    if ((!member(value, 'accessInputs') && !member(value, 'accountInfo')) || value.object.type !== 'Identifier') return
    const fn = parents.findLast(parent => /Function/u.test(parent.type))
    if (!fn) return
    let readsAccount = false
    visitSyntax(fn.body, call => {
      if (
        call.type === 'CallExpression' && member(call.callee, 'readAccountInfo')
        && call.callee.object.name === node.id.name && call.arguments.length === 0
      ) readsAccount = true
    })
    if (readsAccount) {
      const readers = receivers.get(value.object.name) ?? new Set<'accessInputs' | 'accountInfo'>()
      readers.add(value.property.name)
      receivers.set(value.object.name, readers)
    }
  })
  const candidates: NativeAccountCapabilityDescriptor[] = []
  for (const statement of ast.body) {
    if (statement.type !== 'ExportNamedDeclaration' || statement.source) continue
    for (const specifier of statement.specifiers) {
      for (const reader of receivers.get(specifier.local.name) ?? []) {
        candidates.push({
          module: resource.url,
          exportName: specifier.exported.name,
          ...(reader === 'accountInfo' ? { readerProperty: reader } : {}),
        })
      }
    }
  }
  for (const statement of ast.body) {
    if (statement.type !== 'ImportDeclaration' || !statement.source.value.startsWith('./')) continue
    const imports = statement.specifiers.filter((specifier: SyntaxNode) =>
      specifier.type === 'ImportSpecifier' && receivers.has(specifier.local.name)
    )
    if (imports.length === 0) continue
    const module = new URL(statement.source.value, resource.url).href
    const target = resources.find(resource => resource.url === module)
    if (!target) continue
    const targetSyntax = parseNativeSource(target.source)
    for (const specifier of imports) {
      const exported = targetSyntax.body.some((statement: SyntaxNode) =>
        statement.type === 'ExportNamedDeclaration'
        && !statement.source && statement.specifiers.some((entry: SyntaxNode) =>
          entry.exported.name === specifier.imported.name
        )
      )
      if (!exported) continue
      for (const reader of receivers.get(specifier.local.name) ?? []) {
        candidates.push({
          module,
          exportName: specifier.imported.name,
          ...(reader === 'accountInfo' ? { readerProperty: reader } : {}),
        })
      }
    }
  }
  return one(candidates, 'native-account-service')
}

/** Resolve the exported service actually used by the native account query. */
export function discoverNativeAccountCapability(resource: NativeScriptResource): NativeAccountCapabilityDescriptor {
  return discoverNativeAccountCapabilityFromSyntax(resource, parseNativeSource(resource.source))
}
