import { generate, parse, walk } from 'css-tree'

const sheets = new Map<string, ReturnType<typeof parse>>()

/** Read declarations from the real stylesheet, independent of its source formatting. */
export function findCssDeclarations(css: string, selector: string, media?: string): Record<string, string> | undefined {
  const expectedSelector = generate(parse(selector, { context: 'selectorList' }))
  const expectedMedia = media === undefined
    ? undefined
    : generate(parse(media, { context: 'atrulePrelude', atrule: 'media' }))
  const expectedContext = expectedMedia === undefined ? [] : [`media:${expectedMedia}`]
  const ancestors: string[] = []
  const declarations: Record<string, string> = {}
  let found = false
  let sheet = sheets.get(css)
  if (!sheet) {
    sheet = parse(css, { parseCustomProperty: true })
    sheets.set(css, sheet)
  }
  walk(sheet, {
    enter(rule) {
      if (rule.type === 'Atrule') {
        ancestors.push(`${rule.name}:${rule.prelude ? generate(rule.prelude) : ''}`)
        return
      }
      if (rule.type !== 'Rule') return
      if (
        ancestors.length !== expectedContext.length
        || ancestors.some((value, index) => value !== expectedContext[index])
      ) return
      if (generate(rule.prelude) !== expectedSelector) return
      found = true
      rule.block.children.forEach(node => {
        if (node.type !== 'Declaration') return
        const value = generate(node.value) + (node.important ? ' !important' : '')
        if (!declarations[node.property]?.endsWith(' !important') || node.important) {
          declarations[node.property] = value
        }
      })
    },
    leave(node) {
      if (node.type === 'Atrule') ancestors.pop()
    },
  })
  return found ? declarations : undefined
}

/** Positive assertions fail when the requested rule or media condition is absent. */
export function cssDeclarations(css: string, selector: string, media?: string): Record<string, string> {
  const declarations = findCssDeclarations(css, selector, media)
  if (!declarations) throw new Error(`Missing CSS rule: ${selector}${media ? ` in @media ${media}` : ''}`)
  return declarations
}
