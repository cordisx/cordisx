import { createHash } from 'node:crypto'
import type { NativeResourceTransform } from './native-predispatch-interception.js'
import { modelReasoningEfforts } from '../model-reasoning-capabilities.js'
import { resolveNativeVariable } from './native-source-bindings.js'
import { nativeLazyRequestSource, resolveNativeLazyWireRequest } from './native-lazy-wire-request.js'
import {
  applySourceEdits,
  literal,
  member,
  one,
  parseNativeSource,
  properties,
  type SourceEdit,
  type SyntaxNode,
  visitSyntax,
} from './native-source-structure.js'

export interface NativeScriptResource {
  readonly url: string
  readonly source: string
}
export interface NativeSubmissionTransformAnalysis {
  readonly transforms: readonly NativeResourceTransform[]
  readonly syntaxByResource: ReadonlyMap<NativeScriptResource, SyntaxNode>
}
const TOKEN = 'cordisx.operation_token'
const carrier = '__cordisxOperationToken'
const reasoningCarrier = '__cordisxReasoningEffort'
const decision = '__cordisxAdmissionDecision'
const tier = 'globalThis.__cordisxNativeServiceTierOverride'
const hash = (source: string): string => createHash('sha256').update(source).digest('hex')
const valid = (value: string): string =>
  `(typeof ${value}==='string'&&${value}.length>=16&&${value}.length<=256&&!/[\\0\\r\\n]/u.test(${value})?${value}:void 0)`
const config = (value: string, base = 'void 0'): string =>
  `(${value}===void 0?${base}:{...${base},${JSON.stringify(TOKEN)}:${value}})`
const isFunction = (node: SyntaxNode | undefined | null): boolean =>
  /^(?:FunctionExpression|FunctionDeclaration|ArrowFunctionExpression)$/u.test(node?.type ?? '')
const has = (node: SyntaxNode | undefined, keys: readonly string[]): boolean =>
  keys.every(key => properties(node).has(key))
const uniqueBinding = (plan: ResourcePlan, root: SyntaxNode, base: string): string => {
  const names = new Set(plan.nodes(root, node => node.type === 'Identifier').map(node => node.name))
  let binding = base
  for (let suffix = 2; names.has(binding); suffix++) binding = `${base}${suffix}`
  return binding
}

/** Parameter destructuring and a local destructuring of that parameter have the same authority. */
function inputPattern(plan: ResourcePlan, fn: SyntaxNode, keys: readonly string[]): SyntaxNode | undefined {
  const parameter = fn.params[0]?.type === 'AssignmentPattern' ? fn.params[0].left : fn.params[0]
  if (has(parameter, keys)) return parameter
  if (parameter?.type !== 'Identifier') return undefined
  const patterns = (plan.declarations.get(fn) ?? []).filter(declaration =>
    declaration.init?.type === 'Identifier' && declaration.init.name === parameter.name && has(declaration.id, keys)
  )
  if (patterns.length === 0) return undefined
  return one(patterns, 'submission-input').id
}

class ResourcePlan {
  readonly ast: SyntaxNode
  readonly edits: SourceEdit[] = []
  readonly capabilities: string[] = []
  readonly functions: SyntaxNode[] = []
  readonly declarations = new Map<SyntaxNode, SyntaxNode[]>()
  constructor(readonly resource: NativeScriptResource) {
    this.ast = parseNativeSource(resource.source)
    visitSyntax(this.ast, (node, parents) => {
      if (isFunction(node)) this.functions.push(node)
      if (node.type !== 'VariableDeclarator') return
      const fn = parents.findLast(isFunction)
      if (!fn) return
      const entries = this.declarations.get(fn) ?? []
      entries.push(node)
      this.declarations.set(fn, entries)
    })
  }
  text(node: SyntaxNode): string {
    return this.resource.source.slice(node.start, node.end)
  }
  replace(node: SyntaxNode, text: string): void {
    this.edits.push({ start: node.start, end: node.end, text })
  }
  insert(at: number, text: string): void {
    this.edits.push({ start: at, end: at, text })
  }
  nodes(root: SyntaxNode, predicate: (node: SyntaxNode, parents: readonly SyntaxNode[]) => boolean): SyntaxNode[] {
    const result: SyntaxNode[] = []
    visitSyntax(root, (node, parents) => {
      if (predicate(node, parents)) result.push(node)
    })
    return result
  }
  require(root: SyntaxNode, predicate: (node: SyntaxNode) => boolean, name: string): SyntaxNode {
    return one(this.nodes(root, predicate), name)
  }
  binding(pattern: SyntaxNode, name: string): string {
    let node = properties(pattern).get(name)
    if (node?.type === 'AssignmentPattern') node = node.left
    if (node?.type !== 'Identifier') throw new Error(`Native capability ${name}: missing local binding`)
    return node.name
  }
  serviceTier(object: SyntaxNode): void {
    const value = properties(object).get('serviceTier')
    if (!value) throw new Error('Native capability serviceTier: missing request field')
    this.replace(value, `(${tier}==='priority'?'priority':${tier}==='default'?null:${this.text(value)})`)
  }
  addConfig(object: SyntaxNode, token: string): void {
    const value = properties(object).get('config')
    if (value) this.replace(value, config(token, this.text(value)))
    else this.insert(object.end - 1, `,...(${token}===void 0?{}:{config:${config(token)}})`)
  }
}

function submitGuard(plan: ResourcePlan, fn: SyntaxNode): void {
  const input = inputPattern(plan, fn, ['submitTarget', 'isResponseInProgress', 'options'])!
  const bind = (name: string): string => plan.binding(input, name)
  const options = bind('options')
  const declaration = plan.require(fn.body, n =>
    n.type === 'VariableDeclarator'
    && has(n.id, ['promptRawOverride', 'persistedPromptRawOverride'])
    && n.init?.type === 'Identifier' && n.init.name === options, 'submit-options')
  // Bind admission to normalized options, not adjacency to a later native effect.
  if (!fn.async) throw new Error('Native capability submit guard requires asynchronous admission')
  const block = plan.require(
    fn.body,
    n =>
      n.type === 'BlockStatement'
      && n.body.some((statement: SyntaxNode) =>
        statement.type === 'VariableDeclaration' && statement.declarations.includes(declaration)
      ),
    'submit-options-block',
  )
  const optionsStatement = one<SyntaxNode>(
    block.body.filter((statement: SyntaxNode) =>
      statement.type === 'VariableDeclaration' && statement.declarations.includes(declaration)
    ),
    'submit-options-statement',
  )
  const prefix = block.body.slice(0, block.body.indexOf(optionsStatement)) as SyntaxNode[]
  const effectfulPrefix = prefix.some(statement =>
    plan.nodes(statement, (node, parents) =>
      !parents.some(parent => parent !== statement && isFunction(parent))
      && (node.type === 'ExpressionStatement' || node.type === 'AwaitExpression' || node.type === 'NewExpression'))
      .length > 0
  )
  if (effectfulPrefix) throw new Error('Native capability submit guard ordering changed')
  const follow = bind('followUp')
  const raw = plan.binding(declaration.id, 'promptRawOverride')
  const persisted = plan.binding(declaration.id, 'persistedPromptRawOverride')
  plan.insert(
    optionsStatement.end,
    `;let ${decision}={allow:true};if(typeof globalThis.__cordisxNativeSubmitHook==='function'){
    ${decision}=await globalThis.__cordisxNativeSubmitHook({target:${bind('submitTarget')}.type,thread:${
      bind('conversationId')
    },response:${
      bind('isResponseInProgress')
    },followUp:${follow}?.type,followUpThread:${follow}?.type==='local'?${follow}.localConversationId:void 0,defaultAction:${
      bind('defaultFollowUpSubmitAction')
    },explicitAction:${options}.followUpSubmitAction,edit:${
      bind('editingQueuedMessagePosition')
    },promptOverride:${raw}!=null||${persisted}!=null});
    if(${decision}?.allow!==true)return;if(${decision}.operationToken!==void 0&&${
      valid(`${decision}.operationToken`)
    }===void 0)return;
  }`,
  )
  const context = plan.require(fn.body, n =>
    n.type === 'ObjectExpression'
    && has(n, ['threadReferences', 'openingPromptForHistory']) && n.properties.some((p: SyntaxNode) =>
      p.type === 'SpreadElement'
    ), 'submit-context')
  plan.insert(
    context.end - 1,
    `,...(${decision}.operationToken===void 0?{}:{${carrier}:${decision}.operationToken,...(${
      JSON.stringify(modelReasoningEfforts)
    }.includes(${decision}.reasoningEffort)?{${reasoningCarrier}:${decision}.reasoningEffort}:{})})`,
  )
  plan.capabilities.push('submit-guard')
}

function draftRequest(plan: ResourcePlan, fn: SyntaxNode): void {
  const context = plan.binding(inputPattern(plan, fn, ['context', 'prompt', 'serviceTier'])!, 'context')
  const request = plan.require(fn.body, n =>
    n.type === 'ObjectExpression'
    && has(n, ['configOverrides', 'requiresThreadReferences', 'input', 'serviceTier']), 'draft-request')
  const overrides = properties(request).get('configOverrides')!
  const token = valid(`${context}.${carrier}`)
  const effort = `${context}.${reasoningCarrier}`
  plan.replace(
    overrides,
    `(${token}===void 0?${plan.text(overrides)}:{...${plan.text(overrides)},${JSON.stringify(TOKEN)}:${token},...(${
      JSON.stringify(modelReasoningEfforts)
    }.includes(${effort})?{model_reasoning_effort:${effort}}:{})})`,
  )
  // Main-process first-turn builders retain client metadata but drop config.
  // Carry the original admitted Send token; the intermediary removes it.
  const metadata = properties(request).get('responsesapiClientMetadata')
  if (metadata) plan.replace(metadata, config(token, plan.text(metadata)))
  else plan.insert(request.end - 1, `,...(${token}===void 0?{}:{responsesapiClientMetadata:${config(token)}})`)
  plan.serviceTier(request)
  plan.capabilities.push('draft-request')
}

function existingRequest(plan: ResourcePlan, fn: SyntaxNode): void {
  const context = plan.binding(inputPattern(plan, fn, ['context', 'targetConversationId', 'serviceTier'])!, 'context')
  const request = plan.require(
    fn.body,
    n =>
      n.type === 'ObjectExpression'
      && has(n, ['threadId', 'turnTrigger', 'clientUserMessageId', 'input', 'multiAgentMode', 'serviceTier']),
    'existing-request',
  )
  plan.addConfig(request, valid(`${context}.${carrier}`))
  plan.serviceTier(request)
  plan.capabilities.push('existing-request')
}

function draftConfigForward(plan: ResourcePlan, fn: SyntaxNode): void {
  const declaration = plan.require(fn.body, n =>
    n.type === 'VariableDeclarator'
    && has(n.id, ['configOverrides', 'input', 'threadStartKind', 'requiresThreadReferences']), 'draft-config-input')
  const binding = plan.binding(declaration.id, 'configOverrides')
  plan.require(fn.body, n =>
    n.type === 'ObjectExpression'
    && has(n, ['config', 'input', 'threadStartKind', 'requiresThreadReferences'])
    && properties(n).get('config')?.type === 'Identifier'
    && properties(n).get('config')?.name === binding, 'draft-config-forward')
  plan.capabilities.push('draft-config-forward')
}

function normalizedRequest(plan: ResourcePlan, fn: SyntaxNode): void {
  const declaration = plan.require(fn.body, n =>
    n.type === 'VariableDeclarator'
    && has(n.id, ['inheritThreadSettings', 'usePermissionSelection', 'useAppServerPermissionDefault'])
    && !has(n.id, ['localTurnMetadata']), 'normalized-context')
  if (declaration.init?.type !== 'LogicalExpression' || !member(declaration.init.left, 'context')) {
    throw new Error('Native capability normalized-context: expected operation context')
  }
  const operation = plan.text(declaration.init.left.object)
  const request = plan.require(
    fn.body,
    n =>
      n.type === 'ObjectExpression'
      && has(n, ['input', 'model', 'effort', 'multiAgentMode', 'serviceTier', 'cyberAccessProgram']),
    'normalized-request',
  )
  plan.addConfig(request, valid(`${operation}.request.config?.[${JSON.stringify(TOKEN)}]`))
  plan.serviceTier(request)
  const params = plan.require(fn.body, n =>
    n.type === 'ObjectExpression' && n !== request
    && has(n, ['model', 'effort', 'multiAgentMode', 'serviceTier']), 'normalized-params')
  plan.serviceTier(params)
  plan.capabilities.push('normalized-request')
}

function wireRequestInputs(expression: SyntaxNode, local = false): SyntaxNode[] {
  const request = (node: SyntaxNode | undefined): boolean =>
    member(node, 'request') || (local && node?.type === 'Identifier')
  if (request(expression)) return [expression]
  if (
    expression.type === 'CallExpression' && request(expression.arguments[0])
    && expression.arguments[1]?.type === 'CallExpression'
    && member(expression.arguments[1].callee, 'getAppServerVersion')
  ) return [expression.arguments[0]]
  if (expression.type === 'ConditionalExpression') {
    return [...wireRequestInputs(expression.consequent, local), ...wireRequestInputs(expression.alternate, local)]
  }
  if (local && expression.type === 'SequenceExpression') {
    return wireRequestInputs(expression.expressions.at(-1), local)
  }
  throw new Error('Native capability wire-normalizer: unsupported request source')
}

function sameRequestReference(left: SyntaxNode, right: SyntaxNode): boolean {
  if (left.type === 'Identifier' && right.type === 'Identifier') return left.name === right.name
  return left.type === 'MemberExpression' && right.type === 'MemberExpression'
    && !left.computed && !right.computed && left.property.name === right.property.name
    && sameRequestReference(left.object, right.object)
}

function finalDispatch(plan: ResourcePlan, fn: SyntaxNode): void {
  plan.binding(inputPattern(plan, fn, ['manager', 'operation'])!, 'operation')
  const call = plan.require(fn.body, n =>
    n.type === 'CallExpression'
    && member(n.callee, 'sendRequest') && literal(n.arguments[0]) === 'turn/start', 'turn-dispatch')
  const argument = call.arguments[1]
  if (argument?.type === 'CallExpression') {
    const lazy = resolveNativeLazyWireRequest(fn, argument)
    const requests = wireRequestInputs(lazy.expression, true)
    const origins = requests.map(request => nativeLazyRequestSource(lazy.factory, lazy.statement, request))
    if (
      !requests.every(request => sameRequestReference(requests[0]!, request))
      || !origins.every(origin => sameRequestReference(origins[0]!, origin))
    ) {
      throw new Error('Native capability lazy-wire-request: branches use different request sources')
    }
    const capturedRequest = uniqueBinding(plan, fn, '__cordisxOperationRequest')
    const wire = uniqueBinding(plan, fn, '__cordisxNormalizedWire')
    plan.insert(lazy.statement.start, `let ${capturedRequest};`)
    for (const request of requests) plan.replace(request, `(${capturedRequest}=${plan.text(request)})`)
    const token = valid(`${capturedRequest}.config?.[${JSON.stringify(TOKEN)}]`)
    // Keep normalization lazy and run it once after native workspace/permission
    // checks. Forwarding inside the factory covers every existing native caller.
    plan.insert(
      lazy.expression.start,
      `((${wire})=>(${token}===void 0?${wire}:{...${wire},config:${config(token, `${wire}.config`)}}))((`,
    )
    plan.insert(lazy.expression.end, '))')
    plan.capabilities.push('final-dispatch')
    return
  }
  if (argument?.type !== 'Identifier') throw new Error('Native capability turn-dispatch: expected normalized request')
  const wire = resolveNativeVariable(fn, argument, 'wire-normalizer')
  if (wire.end > call.start) throw new Error('Native capability turn-dispatch: invalid normalization order')
  const requests = wireRequestInputs(wire.init)
  if (!requests.every(request => sameRequestReference(requests[0]!, request))) {
    throw new Error('Native capability wire-normalizer: branches use different request sources')
  }
  const capturedRequest = uniqueBinding(plan, fn, '__cordisxOperationRequest')
  const statement = plan.require(
    fn.body,
    n => n.type === 'VariableDeclaration' && n.declarations.includes(wire),
    'wire-declaration',
  )
  plan.require(fn.body, n => n.type === 'BlockStatement' && n.body.includes(statement), 'wire-declaration-block')
  plan.insert(statement.start, `let ${capturedRequest};`)
  // Capture only the selected branch, preserving guard order and getter evaluation count.
  for (const request of requests) plan.replace(request, `(${capturedRequest}=${plan.text(request)})`)
  const token = valid(`${capturedRequest}.config?.[${JSON.stringify(TOKEN)}]`)
  // Preserve every normalized field and native permission check, carrying only the transaction token.
  plan.replace(
    argument,
    `(${token}===void 0?${argument.name}:{...${argument.name},config:${config(token, `${argument.name}.config`)}})`,
  )
  plan.capabilities.push('final-dispatch')
}

function firstTurn(plan: ResourcePlan, fn: SyntaxNode): void {
  const declaration = plan.require(fn.body, n =>
    n.type === 'VariableDeclarator'
    && has(n.id, [
      'projectAssignment',
      'threadStartKind',
      'input',
      'localTurnMetadata',
      'attachments',
    ]), 'first-turn-input')
  const incomingConfig = properties(declaration.id).has('config')
    ? plan.binding(declaration.id, 'config')
    : declaration.init?.type === 'Identifier'
    ? `${plan.text(declaration.init)}.config`
    : undefined
  if (incomingConfig === undefined) throw new Error('Native capability first-turn-input: missing config source')
  const request = plan.require(fn.body, n =>
    n.type === 'ObjectExpression'
    && has(n, ['model', 'effort', 'multiAgentMode', 'input', 'toolOutput', 'collaborationMode']), 'first-turn-request')
  const token = valid(`${incomingConfig}?.[${JSON.stringify(TOKEN)}]`)
  const receipt = plan.require(fn.body, n =>
    n.type === 'VariableDeclarator' && has(n.id, ['conversationResponse'])
    && n.init?.type === 'AwaitExpression', 'first-turn-receipt')
  const response = plan.binding(receipt.id, 'conversationResponse')
  const model = properties(request).get('model')!
  if (!plan.nodes(model, n => member(n, 'model') && n.object.name === response).length) {
    throw new Error('Native capability first-turn-receipt: model is not bound to the creation response')
  }
  const mode = properties(request).get('collaborationMode')!
  const requestEffort = properties(request).get('effort')!
  const effort = `${incomingConfig}?.model_reasoning_effort`
  const validEffort = `${token}!==void 0&&${JSON.stringify(modelReasoningEfforts)}.includes(${effort})`
  // The intermediary already routes this first turn to the receipt's model. Seed the
  // native turn state too, before idle control synchronization can look like a switch.
  plan.replace(
    mode,
    `(${token}===void 0?${plan.text(mode)}:((mode,model,effort)=>
      mode!=null&&mode.settings!=null&&typeof model==='string'&&model.length>0&&model.length<=512
      ?{...mode,settings:{...mode.settings,model,...(effort===void 0?{}:{reasoning_effort:effort})}}:mode)(${
      plan.text(mode)
    },${response}.model,${validEffort}?${effort}:void 0))`,
  )
  plan.replace(requestEffort, `(${validEffort}?${effort}:${plan.text(requestEffort)})`)
  plan.addConfig(request, token)
  plan.serviceTier(request)
  plan.capabilities.push('first-turn')
}

function modelCompletion(plan: ResourcePlan): void {
  const menus: Array<{ binding: string; owner: SyntaxNode | undefined }> = []
  visitSyntax(plan.ast, (node, parents) => {
    if (
      node.type === 'ObjectExpression'
      && has(node, ['onSelectModel', 'onSelectModelOption'])
      && (has(node, ['onSelectReasoningEffort'])
        || has(node, ['onSelectComplete', 'onBeforeSelectModel', 'onSelectDefault', 'model', 'reasoningEffort']))
    ) {
      const binding = properties(node).get('onSelectModel')
      if (binding?.type === 'Identifier') menus.push({ binding: binding.name, owner: parents.findLast(isFunction) })
    }
  })
  if (menus.length === 0) return
  // Minified names are local bindings, not unique identifiers across the asset.
  const callbacks = plan.nodes(
    plan.ast,
    (node, parents) =>
      (node.type === 'AssignmentExpression' || node.type === 'VariableDeclarator')
      && isFunction(node.right ?? node.init)
      && menus.some(menu =>
        menu.binding === (node.left ?? node.id)?.name && menu.owner === parents.findLast(isFunction)
      ),
  )
  const callback = one(callbacks, 'model-completion')
  const fn = callback.right ?? callback.init
  const body = fn.body
  if (fn.params.length !== 2 || body.type !== 'BlockStatement' || body.body.length !== 1) {
    throw new Error('Native capability model-completion: unsupported callback shape')
  }
  const statement = body.body[0]
  if (
    statement.type === 'ExpressionStatement' && statement.expression.type === 'CallExpression'
    && statement.expression.arguments.length === 2
    && statement.expression.arguments.every((arg: SyntaxNode, i: number) =>
      arg.type === 'Identifier' && arg.name === fn.params[i].name
    )
  ) {
    plan.insert(statement.start, 'return ')
  } else if (
    statement.type !== 'ReturnStatement' || statement.argument?.type !== 'CallExpression'
    || !plan.nodes(statement.argument.callee, n => member(n, 'selectModelAndReasoningEffort')).length
  ) {
    throw new Error('Native capability model-completion: native update completion is unavailable')
  }
  plan.capabilities.push('model-completion')
}

/** Compatibility is a complete set of structural capabilities, never an App identity. */
export function analyzeNativeSubmissionTransforms(
  resources: readonly NativeScriptResource[],
): NativeSubmissionTransformAnalysis {
  const plans = resources.map(resource => new ResourcePlan(resource))
  for (const plan of plans) {
    for (const fn of plan.functions) {
      if (inputPattern(plan, fn, ['submitTarget', 'isResponseInProgress', 'options'])) {
        submitGuard(plan, fn)
      }
      if (inputPattern(plan, fn, ['context', 'prompt', 'serviceTier'])) {
        draftRequest(plan, fn)
      }
      if (
        inputPattern(plan, fn, [
          'context',
          'targetConversationId',
          'clientUserMessageId',
          'serviceTier',
        ])
      ) {
        existingRequest(plan, fn)
      }
      if (
        inputPattern(plan, fn, ['manager', 'operation'])
        && plan.nodes(fn.body, node =>
            node.type === 'CallExpression' && member(node.callee, 'sendRequest')
            && literal(node.arguments[0]) === 'turn/start').length > 0
      ) {
        finalDispatch(plan, fn)
      }
      const declarations = plan.declarations.get(fn) ?? []
      if (
        declarations.some(n => has(n.id, ['configOverrides', 'input', 'threadStartKind', 'requiresThreadReferences']))
      ) {
        draftConfigForward(plan, fn)
      }
      if (
        declarations.some(n =>
          n.type === 'VariableDeclarator'
          && has(n.id, ['inheritThreadSettings', 'usePermissionSelection', 'useAppServerPermissionDefault'])
          && !has(n.id, ['localTurnMetadata'])
        )
      ) normalizedRequest(plan, fn)
      if (
        declarations.some(n =>
          n.type === 'VariableDeclarator'
          && has(n.id, [
            'projectAssignment',
            'threadStartKind',
            'input',
            'localTurnMetadata',
            'attachments',
          ])
        )
      ) firstTurn(plan, fn)
    }
    if (plan.resource.source.includes('onSelectModelOption')) modelCompletion(plan)
  }
  const required = [
    'submit-guard',
    'model-completion',
    'draft-request',
    'draft-config-forward',
    'existing-request',
    'normalized-request',
    'final-dispatch',
    'first-turn',
  ]
  for (const capability of required) {
    one(plans.flatMap(plan => plan.capabilities.filter(c => c === capability)), capability)
  }
  const transforms = plans.filter(plan => plan.edits.length > 0).map(plan => {
    const sha256 = hash(plan.resource.source)
    const marker = `__cordisxNativeStructure_${sha256.slice(0, 16)}`
    const source = applySourceEdits(plan.resource.source, plan.edits)
      + `\n;globalThis.${marker}=true;${
        plan.capabilities.includes('submit-guard') ? 'globalThis.__cordisxNativeSubmissionActivate?.(true);' : ''
      }`
    return Object.freeze({
      url: plan.resource.url,
      sha256,
      requiredForDocumentReady: plan.capabilities.includes('submit-guard'),
      transform: (observed: string) => {
        if (hash(observed) !== sha256) {
          throw new Error(`Native resource changed after capability discovery: ${plan.resource.url}`)
        }
        return {
          source,
          anchorMatches: 1,
          acknowledgementExpression: `globalThis.${marker}===true`,
          fenceExpression: `(delete globalThis.${marker},delete globalThis.__cordisxNativeSubmitHook,true)`,
        }
      },
    })
  })
  return {
    transforms,
    syntaxByResource: new Map(plans.map(plan => [plan.resource, plan.ast])),
  }
}

/** Compatibility is a complete set of structural capabilities, never an App identity. */
export function discoverNativeSubmissionTransforms(
  resources: readonly NativeScriptResource[],
): readonly NativeResourceTransform[] {
  return analyzeNativeSubmissionTransforms(resources).transforms
}
