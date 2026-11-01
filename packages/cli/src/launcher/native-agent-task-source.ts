import {
  applySourceEdits,
  literal,
  one,
  parseNativeSource,
  properties,
  type SourceEdit,
  type SyntaxNode,
  visitSyntax,
} from './native-source-structure.js'

export const taskMarker = '__cordisxNativeAgentTaskAdapter'
export const taskHandle = '__cordisxTask'
export const taskToken = 'cordisx.operation_token'
export const isFunction = (node: SyntaxNode): boolean =>
  /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/u.test(node.type)
export const hasKeys = (node: SyntaxNode | undefined, keys: readonly string[]): boolean =>
  keys.every(key => properties(node).has(key))

/** One syntax index per asset; native minified names remain lexical bindings. */
export class TaskSource {
  readonly ast: SyntaxNode
  readonly functions: SyntaxNode[] = []
  readonly edits: SourceEdit[] = []
  constructor(readonly source: string, ast?: SyntaxNode) {
    this.ast = ast ?? parseNativeSource(source)
    visitSyntax(this.ast, node => {
      if (isFunction(node)) this.functions.push(node)
    })
    if (
      this.nodes(
        this.ast,
        node =>
          node.type === 'Identifier'
          && [taskHandle, '__cxTaskCallId', '__cxTaskArguments', '__cxTaskSourceThread'].includes(node.name),
      ).length
    ) {
      throw new Error('Native task adapter binding collision')
    }
  }
  text(node: SyntaxNode): string {
    return this.source.slice(node.start, node.end)
  }
  nodes(root: SyntaxNode, predicate: (node: SyntaxNode, parents: readonly SyntaxNode[]) => boolean): SyntaxNode[] {
    const result: SyntaxNode[] = []
    visitSyntax(root, (node, parents) => {
      if (predicate(node, parents)) result.push(node)
    })
    return result
  }
  require(
    root: SyntaxNode,
    predicate: (node: SyntaxNode, parents: readonly SyntaxNode[]) => boolean,
    name: string,
  ): SyntaxNode {
    return one(this.nodes(root, predicate), `task-${name}`)
  }
  binding(pattern: SyntaxNode, key: string): string {
    const value = properties(pattern).get(key)
    const binding = value?.type === 'AssignmentPattern' ? value.left : value
    if (binding?.type !== 'Identifier') throw new Error(`Native task ${key} binding unavailable`)
    return binding.name
  }
  parameter(fn: SyntaxNode, keys: readonly string[]): SyntaxNode {
    return one(fn.params.filter((param: SyntaxNode) => hasKeys(param, keys)), 'task-input')
  }
  insert(position: number, text: string): void {
    this.edits.push({ start: position, end: position, text })
  }
  replace(node: SyntaxNode, text: string): void {
    this.edits.push({ start: node.start, end: node.end, text })
  }
  addProperty(object: SyntaxNode, text: string): void {
    this.insert(object.start + 1, text + ',')
  }
  addHandle(fn: SyntaxNode, pattern: SyntaxNode, model?: string): void {
    this.addProperty(pattern, `${taskHandle}:${taskHandle}`)
    this.insert(
      fn.body.start + 1,
      `if(${taskHandle}!==void 0&&!globalThis.${taskMarker}?.owns(${taskHandle}))throw Error('Invalid native task handle');${
        model === undefined ? '' : `if(${taskHandle}!==void 0)${model}=${taskHandle}.model;`
      }`,
    )
  }
  declaration(name: string): SyntaxNode {
    return one(
      this.functions.filter(fn => fn.type === 'FunctionDeclaration' && fn.id?.name === name),
      `task-helper-${name}`,
    )
  }
  result(): string {
    return applySourceEdits(this.source, this.edits)
  }
}

export function discoverTaskExecution(plan: TaskSource): SyntaxNode {
  return one(
    plan.functions.filter(fn =>
      fn.params.some((p: SyntaxNode) => hasKeys(p, ['argumentsValue', 'sourceThreadId', 'parentTurnId', 'rootTurnId']))
      && plan.nodes(fn.body, node =>
          node.type === 'CallExpression'
          && literal(properties(node.arguments[0]).get('turnTrigger')) === 'app_tool_create_thread').length === 1
    ),
    'task-dispatcher',
  )
}

export function discoverTaskInitial(plan: TaskSource): SyntaxNode {
  return one(
    plan.functions.filter(fn =>
      fn.params.some((p: SyntaxNode) =>
        hasKeys(p, ['config', 'sourceThreadId', 'startWithoutFirstTurn', 'onBeforeWorktreeCreate'])
      )
    ),
    'task-creation-helper',
  )
}
