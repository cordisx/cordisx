import { one, type SyntaxNode, visitSyntax } from './native-source-structure.js'

const isFunction = (node: SyntaxNode): boolean =>
  /^(?:FunctionExpression|FunctionDeclaration|ArrowFunctionExpression)$/u.test(node.type)
const isScope = (node: SyntaxNode): boolean =>
  isFunction(node)
  || /^(?:Program|BlockStatement|StaticBlock|CatchClause|ForStatement|ForInStatement|ForOfStatement|SwitchStatement|ClassExpression|ClassDeclaration)$/u
    .test(node.type)

function binds(pattern: SyntaxNode | null | undefined, name: string): boolean {
  if (!pattern) return false
  switch (pattern.type) {
    case 'Identifier':
      return pattern.name === name
    case 'AssignmentPattern':
      return binds(pattern.left, name)
    case 'RestElement':
      return binds(pattern.argument, name)
    case 'ArrayPattern':
      return pattern.elements.some((entry: SyntaxNode | null) => binds(entry, name))
    case 'ObjectPattern':
      return pattern.properties.some((entry: SyntaxNode) =>
        binds(entry.type === 'RestElement' ? entry.argument : entry.value, name)
      )
    default:
      return false
  }
}

/** Resolve the nearest lexical binding, including unsupported bindings so they cannot fall through. */
export function resolveNativeVariable(root: SyntaxNode, reference: SyntaxNode, capability: string): SyntaxNode {
  const declarations = new Map<SyntaxNode, SyntaxNode[]>()
  let referenceScopes: readonly SyntaxNode[] = []
  const add = (scope: SyntaxNode | undefined, node: SyntaxNode): void => {
    if (!scope) return
    const entries = declarations.get(scope) ?? []
    entries.push(node)
    declarations.set(scope, entries)
  }
  visitSyntax(root, (node, parents) => {
    if (node === reference) referenceScopes = parents.filter(isScope)
    const scope = parents.findLast(isScope)
    if (node.type === 'VariableDeclarator' && binds(node.id, reference.name)) {
      const declaration = parents.at(-1)
      add(
        declaration?.kind === 'var'
          ? parents.findLast(parent => isFunction(parent) || parent.type === 'Program' || parent.type === 'StaticBlock')
          : scope,
        node,
      )
    }
    if (isFunction(node)) {
      for (const param of node.params) if (binds(param, reference.name)) add(node, param)
      if (binds(node.id, reference.name)) add(node.type === 'FunctionDeclaration' ? scope : node, node)
    }
    if (node.type === 'CatchClause' && binds(node.param, reference.name)) add(node, node.param)
    if ((node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && binds(node.id, reference.name)) {
      add(node.type === 'ClassDeclaration' ? scope : node, node)
    }
  })
  for (const scope of [...referenceScopes].reverse()) {
    const candidates = declarations.get(scope)
    if (!candidates?.length) continue
    const binding = one(candidates, capability)
    if (binding.type !== 'VariableDeclarator' || binding.id.type !== 'Identifier' || binding.init == null) {
      throw new Error(`Native capability ${capability}: expected initialized variable binding`)
    }
    return binding
  }
  throw new Error(`Native capability ${capability}: missing variable binding`)
}
