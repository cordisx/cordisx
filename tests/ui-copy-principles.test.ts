import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { MANAGER_PRODUCT_COPY, managerCopy } from '../packages/cli/src/renderer/ui-copy.js'

const renderer = resolve(import.meta.dirname, '../packages/cli/src/renderer')
function tree(path: string) {
  return ts.createSourceFile(
    path,
    readFileSync(resolve(renderer, path), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}
function descendants(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = []
  const visit = (item: ts.Node) => {
    result.push(item)
    ts.forEachChild(item, visit)
  }
  visit(node)
  return result
}
function importedBinding(source: ts.SourceFile, module: string, name: string): string {
  const declaration = source.statements.find((node): node is ts.ImportDeclaration =>
    ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === module
  )
  expect(declaration?.importClause?.isTypeOnly).toBe(false)
  const binding = declaration?.importClause?.namedBindings
  expect(binding && ts.isNamedImports(binding)).toBe(true)
  const imported = binding && ts.isNamedImports(binding)
    ? binding.elements.find(item => (item.propertyName?.text ?? item.name.text) === name)
    : undefined
  expect(imported?.isTypeOnly).toBe(false)
  expect(imported).toBeDefined()
  return imported!.name.text
}
function expectRenderedImport(path: string, module: string, name: string) {
  const source = tree(path)
  const binding = importedBinding(source, module, name)
  const rendered = descendants(source).some(node =>
    (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node))
    && ts.isIdentifier(node.tagName) && node.tagName.text === binding
  )
  expect(rendered, `${path} renders imported ${name}`).toBe(true)
}

describe('Host UI catalog and production React composition', () => {
  it('assembles complete bilingual catalog keys exactly once and resolves locale variants', () => {
    const modules = import.meta.glob('../packages/cli/src/renderer/ui-copy/*.ts', { eager: true })
    const keys = Object.values(modules).flatMap(module =>
      Object.values(module as Record<string, Record<string, unknown>>).flatMap(Object.keys)
    )
    expect(new Set(keys).size).toBe(keys.length)
    expect(Object.keys(MANAGER_PRODUCT_COPY).sort()).toEqual(keys.sort())
    for (const [key, messages] of Object.entries(MANAGER_PRODUCT_COPY)) {
      expect(messages.en).toMatch(/\S/u)
      expect(messages['zh-CN']).toMatch(/\S/u)
      expect(managerCopy('en-US', key as keyof typeof MANAGER_PRODUCT_COPY)).toBe(messages.en)
      expect(managerCopy('zh-Hans-CN', key as keyof typeof MANAGER_PRODUCT_COPY)).toBe(messages['zh-CN'])
    }
  })

  it('connects the production runtime installer to the React Manager root and each governed product page', () => {
    const runtime = tree('runtime-agent-composition.ts')
    const installer = importedBinding(runtime, './manager/install.js', 'installReactCordisXManager')
    expect(
      descendants(runtime).some(node =>
        ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === installer
      ),
    ).toBe(true)
    const install = tree('manager/install.tsx')
    const rootFactory = importedBinding(install, 'react-dom/client', 'createRoot')
    const root = descendants(install).find((node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node)
      && node.initializer !== undefined && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === rootFactory
    )
    expect(root && ts.isIdentifier(root.name)).toBe(true)
    const manager = importedBinding(install, './ManagerApp.js', 'ManagerApp')
    expect(
      descendants(install).some(node =>
        ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.expression.getText(install) === root!.name.getText(install)
        && node.expression.name.text === 'render'
        && node.arguments.some(argument =>
          descendants(argument).some(child =>
            ts.isJsxSelfClosingElement(child) && ts.isIdentifier(child.tagName) && child.tagName.text === manager
          )
        )
      ),
    ).toBe(true)
    for (
      const page of [
        'PluginDetailPage',
        'PermissionDetailPage',
        'PluginsPage',
        'MarketplacePage',
        'MarketplaceSourcesPage',
        'RoutesPage',
        'ExtensionPointsPage',
        'ManagerContentPage',
      ]
    ) {
      expectRenderedImport('manager/ManagerApp.tsx', `./pages/${page}.js`, page)
    }
    expectRenderedImport('manager/pages/PluginDetailPage.tsx', '../../host-ui/HostForm.js', 'HostForm')
    expectRenderedImport('manager-content-config-form.tsx', './host-ui/HostForm.js', 'HostForm')
    for (
      const control of [
        'Form',
        'Input',
        'Select',
        'Checkbox',
        'Switch',
        'RadioGroup',
        'InputNumber',
        'Slider',
        'DatePicker',
        'TimePicker',
        'ColorPicker',
        'TagInput',
        'Textarea',
      ]
    ) {
      expectRenderedImport('host-ui/HostForm.tsx', 'tdesign-react', control)
    }
    expectRenderedImport('manager/pages/PermissionDetailPage.tsx', 'tdesign-react', 'Select')
    expectRenderedImport('manager/pages/MarketplaceSourcesPage.tsx', '../../dialogs/internal.js', 'HostEditorDialog')
    for (const control of ['Input', 'Switch', 'Button']) {
      expectRenderedImport('manager/pages/MarketplaceSourcesPage.tsx', 'tdesign-react', control)
    }
  })
})
