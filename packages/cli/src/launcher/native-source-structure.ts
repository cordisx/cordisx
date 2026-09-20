import { parse } from 'acorn'

export interface SyntaxNode {
  readonly type: string
  readonly start: number
  readonly end: number
  readonly [key: string]: any
}

export function parseNativeSource(source: string): SyntaxNode {
  return parse(source, { ecmaVersion: 'latest', sourceType: 'module' }) as SyntaxNode
}

export function visitSyntax(node: SyntaxNode, visit: (node: SyntaxNode, parents: readonly SyntaxNode[]) => void): void {
  const walk = (node: SyntaxNode, parents: readonly SyntaxNode[]): void => {
    visit(node, parents)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) walk(child, [...parents, node])
      } else if (value?.type) walk(value, [...parents, node])
    }
  }
  walk(node, [])
}

export function properties(node: SyntaxNode | undefined): Map<string, SyntaxNode> {
  return new Map(
    (node?.properties ?? []).filter((p: SyntaxNode) => p.type === 'Property' && !p.computed)
      .map((p: SyntaxNode) => [p.key.name ?? p.key.value, p.value]),
  )
}

export function member(node: SyntaxNode | undefined, name: string): boolean {
  return node?.type === 'MemberExpression' && !node.computed && node.property.name === name
}

export function literal(node: SyntaxNode | undefined): unknown {
  if (node?.type === 'Literal') return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked
  return undefined
}

export function one<T>(values: readonly T[], capability: string): T {
  if (values.length !== 1) {
    throw new Error(`Native capability ${capability}: expected one structure, found ${values.length}`)
  }
  return values[0]!
}

export interface SourceEdit {
  readonly start: number
  readonly end: number
  readonly text: string
}
export function applySourceEdits(source: string, edits: readonly SourceEdit[]): string {
  let boundary = source.length
  for (const edit of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
    if (edit.end > boundary) throw new Error('Native capability edits overlap')
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end)
    boundary = edit.start
  }
  parseNativeSource(source)
  return source
}
