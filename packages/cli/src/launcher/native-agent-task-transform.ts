import { createHash } from 'node:crypto'
import type { NativeScriptResource } from './native-submission-structure.js'
import type { NativeResourceTransform } from './native-predispatch-interception.js'
import { literal, member, one, properties, type SyntaxNode } from './native-source-structure.js'
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
  const targetNode = properties(options).get('target')!
  if (targetNode.type !== 'Identifier') throw new Error('Native task target binding unavailable')
  const target = plan.text(targetNode)
  // Wrap this one native call, preserving original permission, registration and settlement helpers.
  plan.replace(
    call,
    `await (async()=>{const ${taskHandle}=await globalThis.${taskMarker}?.claim({callId:__cxTaskCallId,sourceThreadId:__cxTaskSourceThread,arguments:__cxTaskArguments,hostId:${target}.type==='remoteProject'?${target}.hostId:'local'});if(typeof __cxTaskCallId==='string'&&__cxTaskCallId.startsWith('cordisx-task-')&&${taskHandle}===void 0)throw Error('Native task routing unavailable');return ${
      plan.text(call.callee)
    }({${taskHandle},${plan.text(options).slice(1, -1)}})})()`,
  )
  const callers = plan.nodes(
    plan.ast,
    node => node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === fn.id?.name,
  )
  const caller = one(callers, 'task-dispatch-call')
  const argumentsValue = properties(caller.arguments[0]).get('argumentsValue')
  if (!member(argumentsValue, 'arguments') || argumentsValue?.object.type !== 'Identifier') {
    throw new Error('Native task call identity unavailable')
  }
  plan.addProperty(caller.arguments[0], `cordisxCallId:${argumentsValue.object.name}.callId`)
}

function initialEdits(plan: TaskSource): void {
  const fn = discoverTaskInitial(plan)
  const input = plan.parameter(fn, ['config', 'sourceThreadId', 'startWithoutFirstTurn', 'onBeforeWorktreeCreate'])
  // Ordinary delegated config remains rejected by the unchanged native guard.
  const config = plan.binding(input, 'config'), sourceThread = plan.binding(input, 'sourceThreadId')
  const nonNull = (node: SyntaxNode, binding: string): boolean =>
    node.type === 'BinaryExpression'
    && node.operator === '!=' && node.left.type === 'Identifier' && node.left.name === binding
    && node.right.type === 'Literal' && node.right.value === null
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
    if (call.callee.type !== 'Identifier') throw new Error('Native task helper reference unavailable')
    plan.addProperty(call.arguments[0], taskHandle)
  }
  const localFn = plan.declaration(local.callee.name)
  const localInput = plan.parameter(localFn, ['config', 'model', 'thinking', 'target', 'sourceThreadId'])
  plan.addHandle(localFn, localInput, plan.binding(localInput, 'model'))
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
  const worktreeFn = plan.declaration(worktree.callee.name)
  const worktreeInput = plan.parameter(worktreeFn, [
    'model',
    'thinking',
    'projectPath',
    'startingState',
    'sourceThreadId',
  ])
  plan.addHandle(worktreeFn, worktreeInput, plan.binding(worktreeInput, 'model'))
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
    }:${taskHandle}.token}})`,
  )
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
): { transforms: readonly NativeResourceTransform[]; available: boolean } {
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
    const initial = one(candidates('initial'), 'task-initial-resource')
    const execution = one(candidates('execution'), 'task-execution-resource')
    verifyModuleLink(initial, execution)
    const merged = [...transforms]
    for (const [{ resource, plan }, kind] of [[initial, 'initial'], [execution, 'execution']] as const) {
      // Prove all creation seams before admitting any part of this capability.
      if (kind === 'initial') initialEdits(plan)
      else executionEdits(plan)
      const priorIndex = merged.findIndex(transform => transform.url === resource.url)
      const prior = merged[priorIndex]
      const next: NativeResourceTransform = {
        url: resource.url,
        sha256: hash(resource.source),
        requiredForDocumentReady: prior?.requiredForDocumentReady ?? false,
        taskExecutionUrl: execution.resource.url,
        transform(source) {
          if (hash(source) !== hash(resource.source)) throw new Error('Native task resource drift')
          const result = prior?.transform(source)
          // Compose on the transformed source; native submission edits can shift creation offsets.
          const transformed = result === undefined ? plan.result() : applyAgentTaskStructure(result.source, kind)
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
      }
      next.transform(resource.source)
      if (priorIndex < 0) merged.push(next)
      else merged[priorIndex] = next
    }
    return { transforms: merged, available: true }
  } catch {
    return { transforms, available: false }
  }
}
