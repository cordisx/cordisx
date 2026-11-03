import { createHash } from 'node:crypto'
import type { NativeResourceTransform, NativeScriptResource } from './contracts.js'
import { fixedNativeTransform } from './fixed-transform.js'
import {
  applySourceEdits,
  literal,
  member,
  parseNativeSource,
  properties,
  type SyntaxNode,
  visitSyntax,
} from './native-source-structure.js'

const marker = '__cordisxNativeBrowserSessionCatchupV1'

/** Resume can establish native ownership before the lazy browser listeners are installed. */
export function nativeBrowserSessionTransforms(
  resources: readonly NativeScriptResource[],
): readonly NativeResourceTransform[] {
  const matches: { resource: NativeScriptResource; fn: SyntaxNode; manager: string; capture: string }[] = []
  for (const resource of resources) {
    if (
      !resource.source.includes('browser-use-session-route-capture')
      || !resource.source.includes('addStreamRoleStateCallback')
    ) continue
    const ast = parseNativeSource(resource.source)
    visitSyntax(ast, (node, parents) => {
      if (node.type !== 'CallExpression' || !member(node.callee, 'addStreamRoleStateCallback')) return
      const fn = [...parents].reverse().find(parent => parent.type === 'FunctionDeclaration')
      const callback = node.arguments[0]
      if (!fn || fn.params.length !== 3 || fn.params.some((param: SyntaxNode) => param.type !== 'Identifier')) return
      if (node.callee.object.type !== 'Identifier' || callback?.type !== 'ArrowFunctionExpression') return
      const manager = node.callee.object.name
      if (manager !== fn.params[1].name) return
      // Reuse the original capture closure, including its session-ID normalization and native owner route.
      const captures: SyntaxNode[] = []
      visitSyntax(callback.body, child => {
        if (
          child.type === 'CallExpression' && child.callee.type === 'Identifier'
          && properties(child.arguments[0]).has('conversationId')
        ) captures.push(child)
      })
      if (captures.length !== 1) return
      const capture = captures[0]!.callee.name
      const text = resource.source.slice(fn.start, fn.end)
      if (!text.includes('browser-use-session-route-capture') || !text.includes('thread/started')) return
      let ownerGuard = false
      visitSyntax(callback.body, child => {
        if (
          child.type === 'BinaryExpression' && ['===', '=='].includes(child.operator)
          && (member(child.left.type === 'ChainExpression' ? child.left.expression : child.left, 'role')
              && literal(child.right) === 'owner'
            || member(child.right.type === 'ChainExpression' ? child.right.expression : child.right, 'role')
              && literal(child.left) === 'owner')
        ) ownerGuard = true
      })
      if (ownerGuard) matches.push({ resource, fn, manager, capture })
    })
  }
  // Browser support is optional on older native builds. Ambiguous structures grant nothing.
  if (matches.length !== 1) return []
  const { resource, fn, manager, capture } = matches[0]!
  const insertion =
    `;const __cxBrowserLifetime=globalThis.${marker};const __cxBrowserCaptured=new Set;const __cxBrowserCatchup=(id,state)=>{if(globalThis.${marker}!==__cxBrowserLifetime||__cxBrowserLifetime===void 0)return;if(state==null||${manager}.getStreamRole(id)?.role!=="owner"){__cxBrowserCaptured.delete(id);return}if(__cxBrowserCaptured.has(id))return;__cxBrowserCaptured.add(id);if(__cxBrowserCaptured.size>128)__cxBrowserCaptured.delete(__cxBrowserCaptured.values().next().value);${capture}({conversationId:id})};${manager}.addConversationStateCallback(__cxBrowserCatchup);for(const state of ${manager}.getCachedConversations())__cxBrowserCatchup(state.id,state);`
  return [fixedNativeTransform({
    url: resource.url,
    sha256: createHash('sha256').update(resource.source).digest('hex'),
    requiredForDocumentReady: false,
    transform(source) {
      return {
        source: applySourceEdits(source, [
          { start: fn.body.end - 1, end: fn.body.end - 1, text: insertion },
          { start: source.length, end: source.length, text: `\n;globalThis.${marker}={};` },
        ]),
        anchorMatches: 1,
        acknowledgementExpression: `typeof globalThis.${marker}==="object"`,
        fenceExpression: `(delete globalThis.${marker},true)`,
      }
    },
  })]
}
