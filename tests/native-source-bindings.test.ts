import { describe, expect, it } from 'vitest'
import { resolveNativeVariable } from '../packages/cli/src/launcher/native-source-bindings.js'
import {
  one,
  parseNativeSource,
  type SyntaxNode,
  visitSyntax,
} from '../packages/cli/src/launcher/native-source-structure.js'

function resolve(source: string): string {
  const ast = parseNativeSource(source)
  const references: SyntaxNode[] = []
  visitSyntax(ast, node => {
    if (node.type === 'CallExpression' && node.callee.name === 'send') references.push(node.arguments[0])
  })
  const binding = resolveNativeVariable(ast, one(references, 'test reference'), 'wire-normalizer')
  return source.slice(binding.start, binding.end)
}

describe('native request lexical binding', () => {
  it.each([
    'function f(){let m=outer;{let m=inner;try{send(m)}catch(e){}}}',
    'function f(){let m=outer;{let m=inner;send(m)}{let m=sibling}}',
    'function f(){let m=outer;function g(){let m=unrelated}{const m=inner;send(m)}}',
    'function f(){let m=outer;for(let m=inner;;){send(m)}}',
    'function f(){let m=outer;switch(1){case 1:let m=inner;send(m)}}',
    'function f(){let m=inner;{let m=unrelated}send(m)}',
    'function f(){{var m=inner}send(m)}',
  ])('selects the visible binding: %s', source => {
    expect(resolve(source)).toBe('m=inner')
  })

  it.each([
    'let m=outer;function f(m){send(m)}',
    'let m=outer;function f({m}){send(m)}',
    'let m=outer;function f([m]){send(m)}',
    'let m=outer;function f(m=inner){send(m)}',
    'let m=outer;function f(...m){send(m)}',
    'function f(){let m=outer;try{}catch(m){send(m)}}',
    'function f(){let m=outer;{let m;send(m)}}',
    'function f(){let m=outer;{const {m}=inner;send(m)}}',
    'function f(){let m=outer;{function m(){};send(m)}}',
    'function f(){let m=outer;{class m{};send(m)}}',
    'function f(){var m=outer;{var m=inner;send(m)}}',
    'function f(){{let m=unrelated}send(m)}',
  ])('rejects unsupported or ambiguous bindings instead of selecting an outer value: %s', source => {
    expect(() => resolve(source)).toThrow('wire-normalizer')
  })
})
