import { describe, expect, it } from 'vitest'
import { cssDeclarations, findCssDeclarations } from './css-declarations.js'

describe('stylesheet declaration assertions', () => {
  it('preserves selector, declaration, priority and media semantics across formatting', () => {
    const css =
      '.a,\n.b { position: fixed; z-index: 12 !important; }\n.a,.b { z-index: 1; } @media (hover: none) { .a,.b { position: absolute; } }'
    expect(cssDeclarations(css, '.a, .b')).toEqual({ position: 'fixed', 'z-index': '12 !important' })
    expect(cssDeclarations(css, '.a,.b', '(hover: none)')).toEqual({ position: 'absolute' })
    expect(cssDeclarations('.fallback { color: var(--color, rgb(1, 2, 3)); }', '.fallback')).toEqual({
      color: 'var(--color,rgb(1,2,3))',
    })
    expect(
      findCssDeclarations(
        '@supports (display: grid) { @media (hover: none) { .a { position: fixed; } } }',
        '.a',
        '(hover: none)',
      ),
    ).toBeUndefined()
    expect(findCssDeclarations(css, '.missing')).toBeUndefined()
    expect(() => cssDeclarations(css, '.missing')).toThrow('Missing CSS rule')
    expect(() => cssDeclarations(css, '.a,.b', '(pointer: coarse)')).toThrow('Missing CSS rule')
  })
})
