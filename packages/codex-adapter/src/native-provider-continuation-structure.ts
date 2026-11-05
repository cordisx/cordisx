import { member, properties, type SyntaxNode } from './native-source-structure.js'

interface ContinuationPlan {
  readonly functions: readonly SyntaxNode[]
  text(node: SyntaxNode): string
  binding(pattern: SyntaxNode, name: string): string
  nodes(root: SyntaxNode, predicate: (node: SyntaxNode, parents: readonly SyntaxNode[]) => boolean): SyntaxNode[]
  insert(at: number, text: string): void
  replace(node: SyntaxNode, text: string): void
  claimCapability(capability: string, fn: SyntaxNode): void
  readonly capabilities: string[]
}

const continuation = '__cordisxProviderContinuation'
const carrier = '__cordisxOperationToken'
const has = (node: SyntaxNode, keys: readonly string[]) => keys.every(key => properties(node).has(key))

/** Retarget before the native local submission owner creates state, resumes, or builds an operation. */
export function continuationLocalSend(plan: ContinuationPlan): void {
  const matches = plan.functions.flatMap(fn => {
    if (
      !fn.async || fn.body.type !== 'BlockStatement' || fn.params.length !== 10
      || !fn.params.every((param: SyntaxNode) => param.type === 'Identifier')
    ) return []
    const context = fn.params[0].name
    const follow = fn.params[1].name
    const calls = plan.nodes(fn.body, node =>
      node.type === 'ObjectExpression'
      && has(node, [
        'scope',
        'context',
        'targetConversationId',
        'managerHostId',
        'clientUserMessageId',
        'onMessageAdded',
        'permissionSelection',
        'submissionLifecycle',
      ])
      && properties(node).get('context')?.name === context
      && member(properties(node).get('targetConversationId'), 'localConversationId')
      && properties(node).get('targetConversationId')?.object.name === follow)
    return calls.length === 1 ? [{ fn, context, follow }] : []
  })
  if (matches.length === 0) return
  for (const { fn, context, follow } of matches) {
    const restore = fn.params[4].name
    plan.insert(
      fn.body.start + 1,
      `
      if(${context}.${continuation}!==void 0){
        let __cxBranch=${context}.${continuation};
        if(__cxBranch.sourceThreadId!==${follow}.localConversationId
          ||typeof __cxBranch.threadId!=='string'||!__cxBranch.threadId||__cxBranch.threadId.length>512
          ||/[\\0\\r\\n]/u.test(__cxBranch.threadId)||__cxBranch.threadId===__cxBranch.sourceThreadId
          ||typeof ${context}.${carrier}!=='string')throw new Error('Native continuation target changed');
        ${follow}={...${follow},localConversationId:__cxBranch.threadId};
        ${context}={...${context},messageThreadId:__cxBranch.threadId};
        if(${restore}!=null)${restore}={...${restore},context:{...${restore}.context,messageThreadId:__cxBranch.threadId}};
      }
    `,
    )
    plan.capabilities.push('continuation-local-send')
    plan.claimCapability('continuation-local-send', fn)
  }
}

/** Capture the real native submit result and navigate only after its Composer cleanup has run. */
export function continuationComposerSend(
  plan: ContinuationPlan,
  fn: SyntaxNode,
  input: SyntaxNode,
  decision: string,
): string | undefined {
  const target = plan.binding(input, 'submitTarget')
  const calls = plan.nodes(fn.body, node =>
    node.type === 'AwaitExpression' && node.argument.type === 'CallExpression'
    && member(node.argument.callee, 'submit') && node.argument.callee.object.name === target)
  if (calls.length === 0) return undefined
  const local = calls.filter(node =>
    node.argument.arguments.length >= 7
    && !member(node.argument.arguments[4], 'executionOptions')
  )
  if (local.length !== 1) throw new Error('Native capability continuation-submit: ambiguous local submission')
  const names = new Set(plan.nodes(fn, node => node.type === 'Identifier').map(node => node.name))
  let witness = '__cxContinuationSubmission'
  while (names.has(witness)) witness += '_'
  const call = local[0]!
  const callback = call.argument.arguments[7]
  if (!callback) throw new Error('Native capability continuation-submit: missing message callback')
  let deferred = '__cxContinuationMessageAdded'
  while (names.has(deferred)) deferred += '_'
  plan.insert(fn.body.start + 1, `let ${witness},${deferred};try{`)
  plan.replace(
    callback,
    `((__cxCallback)=>{
      if(${decision}.continuation===void 0||typeof __cxCallback!=='function')return __cxCallback;
      ${deferred}={callback:__cxCallback,accepted:false};
      return(...__cxArgs)=>{
        if(${deferred}.accepted)return __cxCallback(...__cxArgs);
        ${deferred}.args=__cxArgs;
      };
    })(${plan.text(callback)})`,
  )
  const capture = `((__cxResult)=>{
    if(${decision}.continuation!==void 0)${witness}={operationToken:${decision}.operationToken,
      continuation:${decision}.continuation,accepted:__cxResult?.threadId===${decision}.continuation.threadId
      &&__cxResult?.messageResult?.status==='sent'};
    if(${witness}?.accepted&&${deferred}){
      ${deferred}.accepted=true;
      if(${deferred}.args){
        const __cxArgs=${deferred}.args;delete ${deferred}.args;
        try{Promise.resolve(${deferred}.callback(...__cxArgs)).catch(()=>{});}catch{}
      }
    }
    return __cxResult;
  })(`
  plan.insert(call.start, capture)
  plan.insert(call.end, ')')
  plan.insert(
    fn.body.end - 1,
    `}finally{
    if(${witness}?.accepted)queueMicrotask(()=>globalThis.__cordisxNativeContinuationComplete?.(${witness}));
  }`,
  )
  plan.capabilities.push('continuation-composer-send')
  return `,...(${decision}.continuation===void 0?{}:{${continuation}:${decision}.continuation})`
}
