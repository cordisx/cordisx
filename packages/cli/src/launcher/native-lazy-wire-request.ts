import { resolveNativeVariable } from './native-source-bindings.js'
import { literal, member, one, type SyntaxNode, visitSyntax } from './native-source-structure.js'

/** A lazy normalizer is a local synchronous factory, not an arbitrary dispatch call. */
export function resolveNativeLazyWireRequest(root: SyntaxNode, call: SyntaxNode): {
  readonly statement: SyntaxNode
  readonly expression: SyntaxNode
  readonly factory: SyntaxNode
} {
  const capability = 'lazy-wire-normalizer'
  if (call.optional || call.arguments.length !== 0 || call.callee.type !== 'Identifier') {
    throw new Error(`Native capability ${capability}: expected local zero-argument factory`)
  }
  const binding = resolveNativeVariable(root, call.callee, capability)
  const factory = binding.init
  if (
    binding.end > call.start || factory.type !== 'ArrowFunctionExpression'
    || factory.async || factory.params.length !== 0 || factory.body.type !== 'BlockStatement'
  ) throw new Error(`Native capability ${capability}: expected synchronous block factory`)
  const returns: SyntaxNode[] = []
  visitSyntax(factory.body, (node, parents) => {
    if (
      node.type === 'ReturnStatement'
      && !parents.some(parent =>
        /^(?:FunctionExpression|FunctionDeclaration|ArrowFunctionExpression)$/u.test(parent.type)
      )
    ) returns.push(node)
  })
  const statement = one(returns, capability)
  if (!factory.body.body.includes(statement) || !statement.argument) {
    throw new Error(`Native capability ${capability}: expected one top-level return`)
  }
  return { statement, expression: statement.argument, factory }
}

/** Confirm the local request is initialized from the prepared request, before native edits. */
export function nativeLazyRequestSource(
  factory: SyntaxNode,
  factoryReturn: SyntaxNode,
  reference: SyntaxNode,
): SyntaxNode {
  const binding = resolveNativeVariable(factory, reference, 'lazy-wire-request')
  if (binding.end > factoryReturn.start || !member(binding.init, 'request')) {
    throw new Error('Native capability lazy-wire-request: expected prepared request binding')
  }
  visitSyntax(factory.body, node => {
    if (node.type !== 'AssignmentExpression' || node.left.type !== 'Identifier' || node.left.name !== reference.name) {
      return
    }
    const replacement = node.right
    if (
      node.operator !== '=' || replacement.type !== 'ObjectExpression'
      || replacement.properties[0]?.type !== 'SpreadElement'
      || replacement.properties[0].argument.type !== 'Identifier'
      || replacement.properties[0].argument.name !== reference.name
      || !replacement.properties.slice(1).every((property: SyntaxNode) =>
        property.type === 'Property' && !property.computed && property.kind === 'init'
        && ['sandboxPolicy', 'runtimeWorkspaceRoots'].includes(property.key.name)
        && literal(property.value) === null
      )
    ) throw new Error('Native capability lazy-wire-request: unsupported request replacement')
  })
  return binding.init
}
