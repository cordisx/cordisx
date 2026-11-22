import type { NativeAccountCapabilityDescriptor, NativeScriptResource } from './contracts.js'
import {
  literal,
  member,
  parseNativeSource,
  properties,
  type SyntaxNode,
  visitSyntax,
} from './native-source-structure.js'

function factories(ast: SyntaxNode): Map<string, SyntaxNode> {
  const result = new Map<string, SyntaxNode>()
  for (const statement of ast.body) {
    if (statement.type !== 'ExportNamedDeclaration' || statement.declaration?.type !== 'VariableDeclaration') continue
    for (const declaration of statement.declaration.declarations) {
      if (declaration.id?.name !== '__webpack_modules__' || declaration.init?.type !== 'ObjectExpression') continue
      for (const [id, factory] of properties(declaration.init)) {
        if (factory.type === 'FunctionExpression' && factory.params.length >= 3) result.set(id, factory)
      }
    }
  }
  return result
}

function queryModules(resource: NativeScriptResource, ast: SyntaxNode): Set<string> {
  const found = new Set<string>()
  for (const factory of factories(ast).values()) {
    const source = resource.source.slice(factory.start, factory.end)
    const requireName = factory.params[2]?.name
    if (!requireName || !source.includes('appServices') || !source.includes('readAccountInfo')) continue
    const bindings = factory.body.body.flatMap((statement: SyntaxNode) =>
      statement.type === 'VariableDeclaration' ? statement.declarations : []
    )
    visitSyntax(factory.body, (node, parents) => {
      if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier') return
      const value = node.init?.type === 'ChainExpression' ? node.init.expression : node.init
      if (!member(value, 'accountInfo') || !member(value.object, 'appServices')) return
      const service = value.object.object
      if (service.type !== 'Identifier') return
      const query = parents.findLast(parent => /Function/u.test(parent.type))
      if (!query) return
      let readsAccount = false
      visitSyntax(query.body, call => {
        if (
          call.type === 'CallExpression' && member(call.callee, 'readAccountInfo')
          && call.callee.object.name === node.id.name && call.arguments.length === 0
        ) readsAccount = true
      })
      if (!readsAccount) return
      const matching = bindings.filter((binding: SyntaxNode) =>
        binding.id?.name === service.name && binding.init?.type === 'CallExpression'
        && binding.init.callee?.type === 'Identifier' && binding.init.callee.name === requireName
        && binding.init.arguments.length === 1 && typeof literal(binding.init.arguments[0]) === 'string'
      )
      if (matching.length === 1) found.add(String(literal(matching[0].init.arguments[0])))
    })
  }
  return found
}

function serviceDefinition(resource: NativeScriptResource, moduleId: string): boolean | undefined {
  if (!resource.source.includes('appServices') || !resource.source.includes('setAppServices')) return undefined
  const id = moduleId.replaceAll('$', '\$')
  if (!new RegExp('(?:^|[,{])\s*(?:' + id + '|["\x27]' + id + '["\x27])\s*[:(]', 'u').test(resource.source)) {
    return undefined
  }
  const factory = factories(parseNativeSource(resource.source)).get(moduleId)
  const requireName = factory?.params[2]?.name
  if (!factory || !requireName) return undefined
  const exported = new Map<string, SyntaxNode[]>()
  visitSyntax(factory.body, node => {
    if (node.type !== 'CallExpression' || !member(node.callee, 'd') || node.callee.object.name !== requireName) {
      return
    }
    for (const argument of node.arguments.slice(1)) {
      if (argument.type === 'ObjectExpression') {
        for (const [name, value] of properties(argument)) exported.set(name, [...(exported.get(name) ?? []), value])
      }
    }
  })
  const getter = exported.get('appServices'), setter = exported.get('setAppServices')
  if (getter?.length !== 1 || setter?.length !== 1) return false
  const get = getter[0]!, set = setter[0]!
  if (
    get.type !== 'ArrowFunctionExpression' || get.params.length !== 0 || get.body.type !== 'Identifier'
    || set.type !== 'FunctionExpression' || set.params.length !== 1 || set.params[0].type !== 'Identifier'
    || set.body.body.length !== 1 || set.body.body[0].type !== 'ExpressionStatement'
  ) return false
  const assignment = set.body.body[0].expression
  if (
    assignment.type !== 'AssignmentExpression' || assignment.operator !== '='
    || assignment.left?.type !== 'Identifier' || assignment.left.name !== get.body.name
    || assignment.right?.type !== 'Identifier' || assignment.right.name !== set.params[0].name
  ) return false
  const declarations = factory.body.body.flatMap((statement: SyntaxNode) =>
    statement.type === 'VariableDeclaration' ? statement.declarations : []
  )
  return declarations.some((declaration: SyntaxNode) =>
    declaration.id?.type === 'Identifier' && declaration.id.name === get.body.name && declaration.init === null
  )
}

function exportsRuntime(resource: NativeScriptResource): boolean {
  if (!resource.source.includes('__webpack_require__')) return false
  return parseNativeSource(resource.source).body.some((statement: SyntaxNode) =>
    statement.type === 'ExportNamedDeclaration'
    && statement.specifiers?.some((specifier: SyntaxNode) => specifier.exported?.name === '__webpack_require__')
  )
}

/** Resolve a query-owned account service from a loaded Rspack runtime, never from a guessed module ID. */
export function discoverRspackAccountCapabilities(
  resource: NativeScriptResource,
  ast: SyntaxNode,
  resources: readonly NativeScriptResource[],
): NativeAccountCapabilityDescriptor[] {
  if (!resource.source.includes('__webpack_modules__') || !resource.source.includes('readAccountInfo')) return []
  const ids = [...queryModules(resource, ast)].filter(id => /^[A-Za-z0-9_$-]{1,64}$/u.test(id))
  if (ids.length === 0) return []
  const runtimes = resources.filter(exportsRuntime)
  if (runtimes.length !== 1) return []
  return ids.flatMap(moduleId => {
    const definitions = resources.flatMap(candidate => {
      const valid = serviceDefinition(candidate, moduleId)
      return valid === undefined ? [] : [{ candidate, valid }]
    })
    if (definitions.length === 0 || definitions.some(definition => !definition.valid)) return []
    definitions.sort((left, right) => left.candidate.url.localeCompare(right.candidate.url))
    return [{
      module: runtimes[0]!.url,
      exportName: '__webpack_require__',
      readerProperty: 'accountInfo' as const,
      rspack: { moduleId, definitionModule: definitions[0]!.candidate.url },
    }]
  })
}
