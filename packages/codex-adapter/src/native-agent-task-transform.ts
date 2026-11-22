import { fixedNativeTransform } from './fixed-transform.js'
import { createHash } from 'node:crypto'
import type { NativeScriptResource } from './native-submission-structure.js'
import type { NativeResourceTransform } from './contracts.js'
import { literal, member, one, properties, type SyntaxNode, visitSyntax } from './native-source-structure.js'
import { nativeModuleFactories } from './native-chunk-structure.js'
import { resolveNativeVariable } from './native-source-bindings.js'
import {
  discoverTaskExecution,
  discoverTaskInitial,
  hasKeys,
  taskHandle,
  taskMarker,
  TaskSource,
  taskToken,
} from './native-agent-task-source.js'

const hash = (source: string) => createHash('sha256').update(source).digest('hex')

function executionEdits(plan: TaskSource): void {
  const fn = discoverTaskExecution(plan)
  const input = plan.parameter(fn, ['argumentsValue', 'sourceThreadId', 'parentTurnId', 'rootTurnId'])
  const args = plan.binding(input, 'argumentsValue')
  const sourceThread = plan.binding(input, 'sourceThreadId')
  plan.addProperty(input, 'cordisxCallId:__cxTaskCallId')
  plan.insert(fn.body.start + 1, `const __cxTaskArguments=${args},__cxTaskSourceThread=${sourceThread};`)
  const call = plan.require(fn.body, node =>
    node.type === 'CallExpression'
    && literal(properties(node.arguments[0]).get('turnTrigger')) === 'app_tool_create_thread', 'native-create-call')
  const options = call.arguments[0]
  if (!hasKeys(options, ['scope', 'sourceThreadId', 'target', 'model', 'prompt', 'parentTurnId', 'rootTurnId'])) {
    throw new Error('Native task creation input unavailable')
  }
  const modelNode = properties(options).get('model')!
  if (!['Identifier', 'MemberExpression', 'Literal'].includes(modelNode.type)) {
    throw new Error('Native task model binding unavailable')
  }
  const thinkingNode = properties(options).get('thinking')
  const tierNode = properties(options).get('serviceTier')
  if (
    [thinkingNode, tierNode].some(node => node && !['Identifier', 'MemberExpression', 'Literal'].includes(node.type))
  ) {
    throw new Error('Native task configuration binding unavailable')
  }
  const targetNode = properties(options).get('target')!
  if (targetNode.type !== 'Identifier') throw new Error('Native task target binding unavailable')
  const target = plan.text(targetNode)
  // Wrap this one native call, preserving original permission, registration and settlement helpers.
  plan.replace(
    call,
    `await (async()=>{const ${taskHandle}=await globalThis.${taskMarker}?.claim({callId:__cxTaskCallId,sourceThreadId:__cxTaskSourceThread,arguments:__cxTaskArguments,model:${
      plan.text(modelNode)
    },${thinkingNode ? `thinking:${plan.text(thinkingNode)},` : ''}${
      tierNode ? `serviceTier:${plan.text(tierNode)},` : ''
    }hostId:${target}.type==='remoteProject'?${target}.hostId:'local'});if(typeof __cxTaskCallId==='string'&&__cxTaskCallId.startsWith('cordisx-task-')&&${taskHandle}===void 0)throw Error('Native task routing unavailable');return ${
      plan.text(call.callee)
    }({${taskHandle},${plan.text(options).slice(1, -1)}})})()`,
  )
  const callers = plan.nodes(
    plan.ast,
    node =>
      node.type === 'CallExpression'
      && (node.callee === fn
        || fn.id?.name !== undefined && node.callee.type === 'Identifier' && node.callee.name === fn.id.name),
  )
  const caller = one(callers, 'task-dispatch-call')
  const argumentsValue = properties(caller.arguments[0]).get('argumentsValue')
  if (!member(argumentsValue, 'arguments') || argumentsValue?.object.type !== 'Identifier') {
    throw new Error('Native task call identity unavailable')
  }
  plan.addProperty(caller.arguments[0], `cordisxCallId:${argumentsValue.object.name}.callId`)
}

function initialEdits(plan: TaskSource, firstTurnIsSeparate = false, scope?: SyntaxNode): void {
  const fn = discoverTaskInitial(plan)
  const input = plan.parameter(fn, ['config', 'sourceThreadId', 'startWithoutFirstTurn', 'onBeforeWorktreeCreate'])
  // Ordinary delegated config remains rejected by the unchanged native guard.
  const config = plan.binding(input, 'config'), sourceThread = plan.binding(input, 'sourceThreadId')
  const nonNull = (node: SyntaxNode, binding: string): boolean =>
    node.type === 'BinaryExpression'
    && node.operator === '!='
    && (node.left.type === 'Identifier' && node.left.name === binding
        && node.right.type === 'Literal' && node.right.value === null
      || node.right.type === 'Identifier' && node.right.name === binding
        && node.left.type === 'Literal' && node.left.value === null)
  plan.require(fn.body, node =>
    node.type === 'IfStatement' && node.test.type === 'LogicalExpression'
    && node.test.operator === '&&'
    && (nonNull(node.test.left, config) && nonNull(node.test.right, sourceThread)
      || nonNull(node.test.right, config) && nonNull(node.test.left, sourceThread))
    && (node.consequent.type === 'ThrowStatement'
      || node.consequent.type === 'BlockStatement' && node.consequent.body.length === 1
        && node.consequent.body[0].type === 'ThrowStatement'), 'delegated-config-guard')
  plan.addHandle(fn, input)
  const local = plan.require(
    fn.body,
    node =>
      node.type === 'CallExpression'
      && hasKeys(node.arguments[0], ['scope', 'attachments', 'config', 'input', 'target', 'startWithoutFirstTurn']),
    'local-helper-call',
  )
  const worktree = plan.require(
    fn.body,
    node =>
      node.type === 'CallExpression'
      && hasKeys(node.arguments[0], [
        'scope',
        'attachments',
        'input',
        'startingState',
        'projectPath',
        'onBeforeWorktreeCreate',
      ]),
    'worktree-helper-call',
  )
  for (const call of [local, worktree]) {
    if (!['Identifier', 'FunctionExpression'].includes(call.callee.type)) {
      throw new Error('Native task helper reference unavailable')
    }
    plan.addProperty(call.arguments[0], taskHandle)
  }
  const localFn = local.callee.type === 'Identifier' ? plan.declaration(local.callee.name, scope) : local.callee
  const localInput = plan.parameter(localFn, ['config', 'model', 'thinking', 'target', 'sourceThreadId'])
  plan.addHandle(localFn, localInput, plan.binding(localInput, 'model'), plan.binding(localInput, 'thinking'))
  const localRequest = plan.require(
    localFn.body,
    node =>
      node.type === 'ObjectExpression'
      && hasKeys(node, ['collaborationMode', 'config', 'projectAssignment', 'workspaceKind', 'threadSource']),
    'local-request',
  )
  const priorConfig = properties(localRequest).get('config')!
  plan.replace(
    priorConfig,
    `(${taskHandle}===void 0?${plan.text(priorConfig)}:{...(${plan.text(priorConfig)}),${
      JSON.stringify(taskToken)
    }:${taskHandle}.token})`,
  )
  const priorMetadata = properties(localRequest).get('responsesapiClientMetadata')
  const taskMetadata = `(${taskHandle}===void 0?${priorMetadata ? plan.text(priorMetadata) : 'void 0'}:{...(${
    priorMetadata ? plan.text(priorMetadata) : 'void 0'
  }),${JSON.stringify(taskToken)}:${taskHandle}.token})`
  if (priorMetadata) plan.replace(priorMetadata, taskMetadata)
  else plan.addProperty(localRequest, `responsesapiClientMetadata:${taskMetadata}`)
  const worktreeFn = worktree.callee.type === 'Identifier'
    ? plan.declaration(worktree.callee.name, scope)
    : worktree.callee
  const worktreeInput = plan.parameter(worktreeFn, [
    'model',
    'thinking',
    'projectPath',
    'startingState',
    'sourceThreadId',
  ])
  plan.addHandle(
    worktreeFn,
    worktreeInput,
    plan.binding(worktreeInput, 'model'),
    plan.binding(worktreeInput, 'thinking'),
  )
  const queued = plan.require(
    worktreeFn.body,
    node =>
      node.type === 'ObjectExpression'
      && hasKeys(node, ['startConversationParamsInput', 'startingState', 'launchMode']),
    'worktree-request',
  )
  const queuedInput = properties(queued).get('startConversationParamsInput')!
  if (queuedInput.type !== 'Identifier') throw new Error('Native task worktree input unavailable')
  plan.replace(
    queuedInput,
    `(${taskHandle}===void 0?${queuedInput.name}:{...${queuedInput.name},configOverrides:{...${queuedInput.name}.configOverrides,${
      JSON.stringify(taskToken)
    }:${taskHandle}.token},responsesapiClientMetadata:{...${queuedInput.name}.responsesapiClientMetadata,${
      JSON.stringify(taskToken)
    }:${taskHandle}.token}})`,
  )
  // The Rspack submission dependency independently attests the first-turn carrier.
  if (firstTurnIsSeparate) return
  // The regular submission adapter also carries this token. Keep this seam when composed or used independently.
  const firstFn = one(
    plan.functions.filter(f =>
      f.params.some((p: SyntaxNode) => hasKeys(p, ['readThreadCreationInputs', 'onFirstTurnReady', 'onSettled']))
    ),
    'task-first-turn',
  )
  const incoming = firstFn.params[2]
  if (incoming?.type !== 'Identifier') throw new Error('Native task first-turn config unavailable')
  const firstCall = plan.require(
    firstFn.body,
    node =>
      node.type === 'CallExpression' && member(node.callee, 'executeTurnStart')
      && hasKeys(properties(node.arguments[1]).get('request'), [
        'threadId',
        'clientUserMessageId',
        'disabledPluginIds',
        'collaborationMode',
      ]),
    'first-turn-call',
  )
  const request = properties(firstCall.arguments[1]).get('request')!
  const existingConfig = properties(request).get('config')
  if (existingConfig !== undefined) {
    // Only the normal submission transform's attested carrier may satisfy this seam.
    const text = plan.text(existingConfig)
    if (!text.includes(`${incoming.name}.config`) || !text.includes(JSON.stringify(taskToken))) {
      throw new Error('Native task first-turn carrier unavailable')
    }
  } else {
    plan.addProperty(
      request,
      `...(typeof ${incoming.name}.config?.[${JSON.stringify(taskToken)}]==='string'?{config:{${
        JSON.stringify(taskToken)
      }:${incoming.name}.config[${JSON.stringify(taskToken)}]}}:{})`,
    )
  }
}

function verifyModuleLink(
  initial: { resource: NativeScriptResource; plan: TaskSource },
  execution: { resource: NativeScriptResource; plan: TaskSource },
): void {
  const initialFn = discoverTaskInitial(initial.plan)
  const executionFn = discoverTaskExecution(execution.plan)
  const call = execution.plan.require(executionFn.body, node =>
    node.type === 'CallExpression'
    && literal(properties(node.arguments[0]).get('turnTrigger')) === 'app_tool_create_thread', 'linked-create-call')
  if (call.callee.type !== 'Identifier') throw new Error('Native task helper import unavailable')
  const imported = one(
    execution.plan.nodes(execution.plan.ast, node =>
      node.type === 'ImportDeclaration'
      && node.specifiers.some((s: SyntaxNode) => s.type === 'ImportSpecifier' && s.local.name === call.callee.name)),
    'task-helper-import',
  )
  const specifier = one<SyntaxNode>(
    imported.specifiers.filter((s: SyntaxNode) => s.local.name === call.callee.name),
    'task-helper-import-binding',
  )
  if (new URL(imported.source.value, execution.resource.url).href !== initial.resource.url) {
    throw new Error('Native task helper resource mismatch')
  }
  const exported = one(
    initial.plan.nodes(initial.plan.ast, node =>
      node.type === 'ExportSpecifier'
      && node.local.name === initialFn.id?.name && node.exported.name === specifier.imported.name),
    'task-helper-export',
  )
  if (!exported) throw new Error('Native task helper export unavailable')
}

interface TaskPlan {
  readonly resource: NativeScriptResource
  readonly plan: TaskSource
}

function enclosingFactory(plan: TaskSource, node: SyntaxNode): { factory: SyntaxNode; id: string } {
  const factories = nativeModuleFactories(plan.ast)
  let selected: SyntaxNode | undefined
  visitSyntax(plan.ast, (child, parents) => {
    if (child === node) selected = parents.findLast(parent => factories.has(parent))
  })
  if (!selected) throw new Error('Native task module factory unavailable')
  return { factory: selected, id: factories.get(selected)! }
}

/** Prove the dispatcher calls the actual exported creation function by module identity. */
function rspackTaskPlans(plans: readonly TaskPlan[], transforms: readonly NativeResourceTransform[]): {
  initial: readonly TaskPlan[]
  execution: TaskPlan
} {
  if (!transforms.some(transform => transform.taskFirstTurnCarrier === true)) {
    throw new Error('Native task first-turn submission carrier unavailable')
  }
  const executions = plans.filter(({ plan }) => {
    try {
      discoverTaskExecution(plan)
      return true
    } catch {
      return false
    }
  })
  const execution = one(executions, 'task-execution-resource')
  const fn = discoverTaskExecution(execution.plan)
  const executionFactory = enclosingFactory(execution.plan, fn).factory
  const call = execution.plan.require(fn.body, node =>
    node.type === 'CallExpression'
    && literal(properties(node.arguments[0]).get('turnTrigger')) === 'app_tool_create_thread', 'linked-create-call')
  const callee = call.callee.type === 'SequenceExpression' && call.callee.expressions.length === 2
      && literal(call.callee.expressions[0]) === 0
    ? call.callee.expressions[1]
    : call.callee
  if (callee?.type !== 'MemberExpression' || callee.computed || callee.object.type !== 'Identifier') {
    throw new Error('Native task module call unavailable')
  }
  const reference = resolveNativeVariable(execution.plan.ast, callee.object, 'task-module-import')
  const imported = reference.init
  if (
    reference.start < executionFactory.start || reference.end > executionFactory.end
    || imported?.type !== 'CallExpression' || imported.callee.type !== 'Identifier'
    || imported.callee.name !== executionFactory.params[2]?.name || imported.arguments.length !== 1
    || typeof literal(imported.arguments[0]) !== 'string'
  ) {
    throw new Error('Native task module import unavailable')
  }
  const moduleId = literal(imported.arguments[0])
  const exportName = callee.property.name
  const initial: TaskPlan[] = []
  for (const candidate of plans) {
    let creation: SyntaxNode
    try {
      creation = discoverTaskInitial(candidate.plan)
    } catch {
      continue
    }
    let identity: { factory: SyntaxNode; id: string }
    try {
      identity = enclosingFactory(candidate.plan, creation)
    } catch {
      continue
    }
    if (identity.id !== moduleId) continue
    const exports = candidate.plan.nodes(identity.factory, node =>
      node.type === 'CallExpression'
      && member(node.callee, 'd') && node.callee.object.type === 'Identifier'
      && node.callee.object.name === identity.factory.params[2]?.name
      && node.arguments[0]?.type === 'Identifier' && node.arguments[0].name === identity.factory.params[1]?.name
      && node.arguments.some((arg: SyntaxNode) => properties(arg).get(exportName) === creation))
    if (exports.length !== 1) throw new Error('Native task module export unavailable')
    initial.push(candidate)
  }
  if (!initial.length) throw new Error('Native task linked creation module unavailable')
  return { initial, execution }
}

export function applyAgentTaskStructure(source: string, kind: 'initial' | 'execution', ast?: SyntaxNode): string {
  const plan = new TaskSource(source, ast)
  if (kind === 'execution') executionEdits(plan)
  else initialEdits(plan)
  return plan.result()
}

/** Discover semantics across native builds, then bind transforms to the exact discovered asset bytes. */
export function nativeAgentTaskTransforms(
  _version: string,
  _build: string,
  resources: readonly NativeScriptResource[],
  transforms: readonly NativeResourceTransform[],
  syntaxByResource?: ReadonlyMap<NativeScriptResource, SyntaxNode>,
): { transforms: readonly NativeResourceTransform[]; available: boolean; reason?: string } {
  let stage = 'discovery'
  try {
    const plans = resources.filter(resource =>
      resource.source.includes('create_thread')
      || resource.source.includes('startWithoutFirstTurn') && resource.source.includes('onBeforeWorktreeCreate')
    ).map(resource => ({ resource, plan: new TaskSource(resource.source, syntaxByResource?.get(resource)) }))
    const candidates = (kind: 'initial' | 'execution') =>
      plans.filter(({ plan }) => {
        try {
          if (kind === 'initial') discoverTaskInitial(plan)
          else discoverTaskExecution(plan)
          return true
        } catch {
          return false
        }
      })
    stage = 'link'
    let initial: readonly TaskPlan[]
    let execution: TaskPlan
    let rspack = false
    const possibleInitial = candidates('initial')
    const possibleExecution = candidates('execution')
    if (
      possibleInitial.length === 1 && possibleExecution.length === 1
      && discoverTaskInitial(possibleInitial[0]!.plan).id?.name !== undefined
    ) {
      initial = possibleInitial
      execution = possibleExecution[0]!
      verifyModuleLink(initial[0]!, execution)
    } else {
      const linked = rspackTaskPlans(plans, transforms)
      initial = linked.initial
      execution = linked.execution
      rspack = true
    }
    stage = 'transform'
    const merged = [...transforms]
    const taskOwnedResources = new Set<string>()
    const operations: Array<readonly [TaskPlan, 'initial' | 'execution']> = [
      ...initial.map(item => [item, 'initial'] as const),
      [execution, 'execution'],
    ]
    for (const [{ resource, plan }, kind] of operations) {
      // Prove all creation seams before admitting any part of this capability.
      if (kind === 'initial') {
        initialEdits(plan, rspack, rspack ? enclosingFactory(plan, discoverTaskInitial(plan)).factory : undefined)
      } else executionEdits(plan)
      const priorIndex = merged.findIndex(transform => transform.url === resource.url)
      const prior = merged[priorIndex]
      const includesTaskEdits = taskOwnedResources.has(resource.url)
      const next = fixedNativeTransform({
        url: resource.url,
        sha256: hash(resource.source),
        requiredForDocumentReady: prior?.requiredForDocumentReady ?? false,
        taskExecutionUrl: execution.resource.url,
        transform(source) {
          if (hash(source) !== hash(resource.source)) throw new Error('Native task resource drift')
          const result = prior?.transform(source)
          // Compose on the transformed source; native submission edits can shift creation offsets.
          const composed = result === undefined
            ? undefined
            : new TaskSource(result.source, undefined, includesTaskEdits)
          if (composed) {
            if (kind === 'initial') {
              initialEdits(
                composed,
                rspack,
                rspack ? enclosingFactory(composed, discoverTaskInitial(composed)).factory : undefined,
              )
            } else executionEdits(composed)
          }
          const transformed = composed === undefined ? plan.result() : composed.result()
          return {
            source: transformed + `\n;globalThis.__cordisxNativeAgentTask_${kind}=true;${
              kind === 'initial'
                ? `globalThis.__cordisxNativeAgentTaskExecutionUrl=${JSON.stringify(execution.resource.url)};`
                : ''
            }`,
            anchorMatches: 1,
            acknowledgementExpression: `(globalThis.__cordisxNativeAgentTask_${kind}===true&&(${
              result?.acknowledgementExpression ?? 'true'
            }))`,
            fenceExpression:
              `(delete globalThis.__cordisxNativeAgentTask_${kind},delete globalThis.__cordisxNativeAgentTaskExecutionUrl,globalThis.${taskMarker}?.dispose(),${
                result?.fenceExpression ?? 'true'
              })`,
          }
        },
      })
      stage = 'composition'
      next.transform(resource.source)
      stage = 'transform'
      if (priorIndex < 0) merged.push(next)
      else merged[priorIndex] = next
      taskOwnedResources.add(resource.url)
    }
    return { transforms: merged, available: true }
  } catch {
    return { transforms, available: false, reason: stage }
  }
}
