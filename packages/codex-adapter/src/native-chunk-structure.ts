import {
  literal,
  member,
  parseNativeSource,
  properties,
  type SyntaxNode,
  visitSyntax,
} from './native-source-structure.js'

/** Resolve a finite Rspack chunk filename table without evaluating application code. */
export function nativeChunkPaths(source: string): readonly string[] {
  if (!source.includes('assets/async/')) return []
  const paths = new Set<string>()
  visitSyntax(parseNativeSource(source), node => {
    if (node.type !== 'AssignmentExpression' || !member(node.left, 'u')) return
    const fn = node.right
    if (fn.type !== 'ArrowFunctionExpression' || fn.params.length !== 1 || fn.params[0].type !== 'Identifier') return
    const parameter = fn.params[0].name
    const keys = new Set<string>()
    const tables = new Map<SyntaxNode, Map<string, SyntaxNode>>()
    visitSyntax(fn.body, child => {
      if (
        child.type === 'MemberExpression' && child.computed && child.object.type === 'ObjectExpression'
        && child.property.type === 'Identifier' && child.property.name === parameter
      ) {
        const table = new Map([...properties(child.object)].map(([key, value]) => [String(key), value]))
        tables.set(child.object, table)
        for (const key of table.keys()) keys.add(key)
      }
    })
    const evaluate = (expression: SyntaxNode, key: string): string | number | undefined => {
      const value = literal(expression)
      if (typeof value === 'string' || typeof value === 'number') return value
      if (expression.type === 'Identifier' && expression.name === parameter) return key
      if (expression.type === 'BinaryExpression' && expression.operator === '+') {
        const left = evaluate(expression.left, key)
        const right = evaluate(expression.right, key)
        if (left !== undefined && right !== undefined) return String(left) + String(right)
      }
      if (
        expression.type === 'MemberExpression' && expression.computed
        && expression.object.type === 'ObjectExpression' && expression.property.name === parameter
      ) {
        const entry = tables.get(expression.object)?.get(key)
        if (entry) return evaluate(entry, key)
      }
      return undefined
    }
    for (const key of keys) {
      const value = evaluate(fn.body, key)
      if (typeof value === 'string' && /^assets\/async\/[A-Za-z0-9._-]+\.js$/u.test(value)) paths.add(value)
    }
  })
  return [...paths]
}

/** Only exported Rspack module registries establish a shared factory identity. */
export function nativeModuleFactories(ast: SyntaxNode): ReadonlyMap<SyntaxNode, string> {
  const result = new Map<SyntaxNode, string>()
  for (const statement of ast.body) {
    if (statement.type !== 'ExportNamedDeclaration' || statement.declaration?.type !== 'VariableDeclaration') continue
    for (const declaration of statement.declaration.declarations) {
      if (declaration.id.name !== '__webpack_modules__' || declaration.init?.type !== 'ObjectExpression') continue
      for (const [id, factory] of properties(declaration.init)) {
        if (factory.type !== 'FunctionExpression' || factory.params.length !== 3) continue
        if (result.has(factory)) throw new Error('Duplicate native module factory')
        result.set(factory, String(id))
      }
    }
  }
  return result
}
