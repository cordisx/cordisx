import type { NativeAccountCapabilityDescriptor } from '../native-account-capability.js'
import type { NativeScriptResource } from './native-submission-structure.js'
import { member, one, parseNativeSource, type SyntaxNode, visitSyntax } from './native-source-structure.js'

/** Resolve the exported service actually used by the native account query. */
export function discoverNativeAccountCapabilityFromSyntax(
  resource: NativeScriptResource,
  ast: SyntaxNode,
): NativeAccountCapabilityDescriptor {
  const receivers = new Set<string>()
  visitSyntax(ast, (node, parents) => {
    if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier') return
    const value = node.init?.type === 'ChainExpression' ? node.init.expression : node.init
    if (!member(value, 'accessInputs') || value.object.type !== 'Identifier') return
    const fn = parents.findLast(parent => /Function/u.test(parent.type))
    if (!fn) return
    let readsAccount = false
    visitSyntax(fn.body, call => {
      if (
        call.type === 'CallExpression' && member(call.callee, 'readAccountInfo')
        && call.callee.object.name === node.id.name && call.arguments.length === 0
      ) readsAccount = true
    })
    if (readsAccount) receivers.add(value.object.name)
  })
  const exports: string[] = []
  for (const statement of ast.body) {
    if (statement.type !== 'ExportNamedDeclaration' || statement.source) continue
    for (const specifier of statement.specifiers) {
      if (receivers.has(specifier.local.name)) exports.push(specifier.exported.name)
    }
  }
  return { module: resource.url, exportName: one(exports, 'native-account-service') }
}

/** Resolve the exported service actually used by the native account query. */
export function discoverNativeAccountCapability(resource: NativeScriptResource): NativeAccountCapabilityDescriptor {
  return discoverNativeAccountCapabilityFromSyntax(resource, parseNativeSource(resource.source))
}
