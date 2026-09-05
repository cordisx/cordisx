import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { highlightSafeMarkdownCodeBlocks, renderSafeMarkdown } from '../packages/cli/src/renderer/markdown.js'

describe('safe manager Markdown renderer', () => {
  it('renders README structure without interpreting raw HTML', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>')
    const article = renderSafeMarkdown(
      dom.window.document,
      [
        '# Demo',
        '',
        'A **trusted** plugin with `slots` and [docs](https://cordisx.github.io/).',
        '',
        '- first',
        '- <img src=x onerror=alert(1)>',
        '- [x] shipped',
        '',
        '1. first step',
        '2. second step',
        '',
        '> A **safe** quote.',
        '',
        '| Name | State |',
        '| --- | --- |',
        '| Demo | Ready |',
        '',
        '---',
        '',
        '```html',
        '<script>alert(1)</script>',
        '```',
      ].join('\n'),
    )

    expect(article.querySelector('h1')?.textContent).toBe('Demo')
    expect(article.querySelector('strong')?.textContent).toBe('trusted')
    expect(article.querySelector('p code')?.textContent).toBe('slots')
    expect(article.querySelector('a')?.getAttribute('href')).toBe('https://cordisx.github.io/')
    expect(article.querySelectorAll('li')).toHaveLength(5)
    expect(article.querySelector('ol')?.textContent).toContain('second step')
    expect(article.querySelector('.task-list-item input')?.hasAttribute('disabled')).toBe(true)
    expect(article.querySelector('blockquote strong')?.textContent).toBe('safe')
    expect(article.querySelectorAll('table th')).toHaveLength(2)
    expect(article.querySelector('table td')?.textContent).toBe('Demo')
    expect(article.querySelector('hr')).not.toBeNull()
    expect(article.querySelector('pre code')?.textContent).toBe('<script>alert(1)</script>')
    expect(article.querySelector('pre code')?.dataset.language).toBe('html')
    expect(article.querySelector('script')).toBeNull()
    expect(article.querySelector('img')).toBeNull()
    expect(article.textContent).toContain('<img src=x onerror=alert(1)>')
    dom.window.close()
  })

  it('projects fenced code through Shiki token spans without inserting source HTML', async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>')
    const article = renderSafeMarkdown(dom.window.document, '```ts\nconst answer = 42\n```')
    dom.window.document.body.append(article)
    await highlightSafeMarkdownCodeBlocks(article, 'dark')
    const code = article.querySelector<HTMLElement>('pre > code')!
    expect(code.dataset.shikiTheme).toBe('dark')
    expect(code.querySelectorAll('.cxm-readme-code-line span').length).toBeGreaterThan(0)
    expect(code.textContent).toBe('const answer = 42')
    expect(code.querySelector('script')).toBeNull()
    dom.window.close()
  })

  it('does not project the closing-fence newline as an empty code row', async () => {
    const dom = new JSDOM(
      '<!doctype html><html><body><article><pre><code data-language="bash">npm run dev\n</code></pre></article></body></html>',
    )
    const article = dom.window.document.querySelector<HTMLElement>('article')!
    await highlightSafeMarkdownCodeBlocks(article, 'dark')
    expect(article.querySelectorAll('.cxm-readme-code-line')).toHaveLength(1)
    expect(article.querySelector('code')?.textContent).toBe('npm run dev')
    dom.window.close()
  })
})
