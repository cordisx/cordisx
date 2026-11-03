import { createHash } from 'node:crypto'
import type { NativeResourceTransform, NativeScriptResource } from './contracts.js'
import { fixedNativeTransform } from './fixed-transform.js'
import {
  applySourceEdits,
  literal,
  parseNativeSource,
  properties,
  type SyntaxNode,
  visitSyntax,
} from './native-source-structure.js'

const isTrue = (node: SyntaxNode | undefined): boolean =>
  literal(node) === true
  || (node?.type === 'UnaryExpression' && node.operator === '!' && literal(node.argument) === 0)

/** Reuse native attached side chats: they retain a rollout and support provider resume without copying history. */
export function nativeSideChatTransforms(
  resources: readonly NativeScriptResource[],
): readonly NativeResourceTransform[] {
  return resources.flatMap(resource => {
    if (
      !resource.source.includes('sideConversationParentNavigationPath') || !resource.source.includes('attachToSource')
    ) return []
    const candidates: SyntaxNode[] = []
    const declarations: SyntaxNode[] = []
    visitSyntax(parseNativeSource(resource.source), node => {
      if (node.type === 'VariableDeclarator') declarations.push(node)
      if (node.type !== 'ObjectExpression') return
      const fields = properties(node)
      if (
        !isTrue(fields.get('sideConversation')) || !fields.has('sourceConversationId')
        || !fields.has('sideConversationParentNavigationPath') || !fields.has('developerInstructions')
      ) return
      const branch = node.properties.filter((property: SyntaxNode) => {
        if (property.type !== 'SpreadElement' || property.argument.type !== 'ConditionalExpression') return false
        const yes = properties(property.argument.consequent)
        const no = properties(property.argument.alternate)
        return isTrue(yes.get('attachToSource')) && isTrue(no.get('ephemeral'))
      })
      if (branch.length === 1) candidates.push(branch[0]!.argument.test)
    })
    if (candidates.length !== 1) throw new Error('Native attached side chat creation is ambiguous')
    const test = candidates[0]!
    if (test.type !== 'Identifier') throw new Error('Native attached side chat gate changed')
    const declarationsForGate = declarations.filter(node =>
      node.id.type === 'Identifier' && node.id.name === test.name
      && node.init?.type === 'LogicalExpression' && node.init.operator === '&&'
      && resource.source.slice(node.init.left.start, node.init.left.end).includes('persistentSideChats')
    )
    if (declarationsForGate.length !== 1) throw new Error('Native attached side chat capability gate is ambiguous')
    // Enable the native user-facing path while retaining its user action,
    // paginated-parent and negotiated app-server version checks.
    const flag = declarationsForGate[0]!.init.right as SyntaxNode
    const sha256 = createHash('sha256').update(resource.source).digest('hex')
    const marker = `__cordisxNativeAttachedSideChat_${sha256.slice(0, 16)}`
    const source = applySourceEdits(resource.source, [{ start: flag.start, end: flag.end, text: 'true' }])
      + `\n;globalThis.${marker}=true;`
    return [fixedNativeTransform({
      url: resource.url,
      sha256,
      requiredForDocumentReady: false,
      transform(observed) {
        if (createHash('sha256').update(observed).digest('hex') !== sha256) {
          throw new Error('Native side chat source changed')
        }
        return {
          source,
          anchorMatches: 1,
          acknowledgementExpression: `globalThis.${marker}===true`,
          fenceExpression: `(delete globalThis.${marker},true)`,
        }
      },
    })]
  })
}
