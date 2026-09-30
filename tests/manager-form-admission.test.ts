import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { expect, it } from 'vitest'

// Bounded root detection only. Arbitrary div-based editors need the documented PR review.
function rootBypasses(source: string): string[] {
  const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const issues: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      const bindings = clause?.namedBindings
      if (node.moduleSpecifier.text.split('/')[0] === 'tdesign-react' && !clause?.isTypeOnly) {
        if (bindings && ts.isNamedImports(bindings)) {
          for (const specifier of bindings.elements) {
            const name = (specifier.propertyName ?? specifier.name).text
            if (!specifier.isTypeOnly && ['Form', 'Dialog', 'DialogPlugin'].includes(name)) issues.push(name)
          }
        } else if (bindings && ts.isNamespaceImport(bindings)) {
          // Namespace/default imports conceal the selected roots; use named imports here.
          issues.push('TDesign namespace')
        }
        if (clause?.name) issues.push('TDesign default')
      }
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (ts.isIdentifier(node.tagName) && ['form', 'dialog'].includes(node.tagName.text)) {
        issues.push(node.tagName.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return issues
}

it('rejects explicit form/modal roots in Manager business pages while preserving Host primitive ownership', () => {
  // Vite records lazy module imports as dependencies, including newly added business pages.
  const modules = import.meta.glob('../packages/cli/src/renderer/manager/{pages,components}/**/*.tsx')
  const failures: string[] = []
  for (const file of Object.keys(modules)) {
    const issues = rootBypasses(readFileSync(new URL(file, import.meta.url), 'utf8'))
    if (issues.length) failures.push(`${file}: ${issues.join(', ')}`)
  }
  expect(
    failures,
    'Use the Manager form selection table; canonical host-ui/dialogs implementations are outside this boundary.',
  )
    .toEqual([])
})

it('recognizes aliases and native roots without banning search controls, types or public Host dialogs', () => {
  expect(rootBypasses("import { Form as Editor, DialogPlugin as open } from 'tdesign-react'"))
    .toEqual(['Form', 'DialogPlugin'])
  expect(rootBypasses("import * as UI from 'tdesign-react'; const x = <UI.Dialog />"))
    .toEqual(['TDesign namespace'])
  expect(rootBypasses('const x = <form><dialog /></form>')).toEqual(['form', 'dialog'])
  expect(rootBypasses(`
    import type { Form } from 'tdesign-react'
    import { type Dialog, Input, Switch } from 'tdesign-react'
    import { Dialog as HostDialog, SchemaForm } from 'cordisx/ui'
    const hint = '<form>' // <dialog> is documentation
    const body = <HostDialog><SchemaForm /><Input /><Switch /></HostDialog>
  `)).toEqual([])
})
