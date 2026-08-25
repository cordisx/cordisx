function appendInline(document: Document, parent: HTMLElement, source: string): void {
  const token = /(`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~|(?<!\*)\*[^*]+\*(?!\*)|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g
  let offset = 0
  for (const match of source.matchAll(token)) {
    const index = match.index ?? 0
    if (index > offset) parent.append(document.createTextNode(source.slice(offset, index)))
    const value = match[0]
    if (value.startsWith('`')) {
      const code = document.createElement('code')
      code.textContent = value.slice(1, -1)
      parent.append(code)
    } else if (value.startsWith('**')) {
      const strong = document.createElement('strong')
      strong.textContent = value.slice(2, -2)
      parent.append(strong)
    } else if (value.startsWith('~~')) {
      const deleted = document.createElement('del')
      deleted.textContent = value.slice(2, -2)
      parent.append(deleted)
    } else if (value.startsWith('*')) {
      const emphasis = document.createElement('em')
      emphasis.textContent = value.slice(1, -1)
      parent.append(emphasis)
    } else {
      const parts = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(value)
      if (parts === null) {
        parent.append(document.createTextNode(value))
      } else {
        const anchor = document.createElement('a')
        anchor.textContent = parts[1] ?? ''
        anchor.href = parts[2] ?? '#'
        anchor.target = '_blank'
        anchor.rel = 'noopener noreferrer'
        parent.append(anchor)
      }
    }
    offset = index + value.length
  }
  if (offset < source.length) parent.append(document.createTextNode(source.slice(offset)))
}

function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/u, '').replace(/\|$/u, '')
  return trimmed.split('|').map(cell => cell.trim())
}

function isTableDivider(line: string): boolean {
  const cells = tableCells(line)
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/u.test(cell))
}

const SHIKI_LANGUAGES = [
  'bash', 'css', 'html', 'javascript', 'json', 'jsx', 'markdown', 'shellscript',
  'text', 'tsx', 'typescript', 'yaml',
] as const

const SHIKI_LANGUAGE_SET = new Set<string>(SHIKI_LANGUAGES)
type ShikiLanguage = typeof SHIKI_LANGUAGES[number]

function shikiLanguage(value: string | undefined): ShikiLanguage {
  const normalized = value?.trim().toLocaleLowerCase()
  if (normalized === 'js') return 'javascript'
  if (normalized === 'ts') return 'typescript'
  if (normalized === 'sh' || normalized === 'shell' || normalized === 'zsh') return 'shellscript'
  if (normalized === 'yml') return 'yaml'
  return normalized !== undefined && SHIKI_LANGUAGE_SET.has(normalized) ? normalized as ShikiLanguage : 'text'
}

let shikiHighlighter: Promise<Awaited<ReturnType<typeof import('shiki')['createHighlighter']>>> | undefined

function loadShiki() {
  shikiHighlighter ??= import('shiki').then(({ createHighlighter }) => createHighlighter({
    themes: ['github-dark', 'github-light'],
    langs: [...SHIKI_LANGUAGES],
  }))
  return shikiHighlighter
}

/**
 * Repaint only fenced-code text with Shiki tokens. The Markdown parser always
 * creates safe text DOM first; neither plugin HTML nor Shiki HTML is inserted.
 */
export async function highlightSafeMarkdownCodeBlocks(article: HTMLElement, theme: 'dark' | 'light'): Promise<void> {
  const blocks = [...article.querySelectorAll<HTMLElement>('pre > code[data-language]')]
  if (blocks.length === 0) return
  const highlighter = await loadShiki()
  for (const code of blocks) {
    if (!code.isConnected) return
    const source = code.textContent ?? ''
    const tokens = await highlighter.codeToTokens(source, {
      lang: shikiLanguage(code.dataset.language),
      theme: theme === 'dark' ? 'github-dark' : 'github-light',
    })
    if (!code.isConnected) return
    const fragment = code.ownerDocument.createDocumentFragment()
    tokens.tokens.forEach((line, index) => {
      const lineElement = code.ownerDocument.createElement('span')
      lineElement.className = 'cxm-readme-code-line'
      for (const token of line) {
        const span = code.ownerDocument.createElement('span')
        if (token.color !== undefined) span.style.color = token.color
        if (token.fontStyle !== undefined && token.fontStyle !== 0) {
          if ((token.fontStyle & 1) !== 0) span.style.fontStyle = 'italic'
          if ((token.fontStyle & 2) !== 0) span.style.fontWeight = '700'
          if ((token.fontStyle & 4) !== 0) span.style.textDecoration = 'underline'
        }
        span.textContent = token.content
        lineElement.append(span)
      }
      fragment.append(lineElement)
      if (index < tokens.tokens.length - 1) fragment.append(code.ownerDocument.createTextNode('\n'))
    })
    code.replaceChildren(fragment)
    code.dataset.shikiTheme = theme
  }
}

/** Render a safe GitHub-style Markdown subset using Host-owned DOM only. */
export function renderSafeMarkdown(document: Document, markdown: string): HTMLElement {
  const article = document.createElement('article')
  article.className = 'cxm-readme'
  const lines = markdown.replaceAll('\r\n', '\n').split('\n')
  let paragraph: string[] = []
  let list: HTMLUListElement | HTMLOListElement | undefined
  let code: { readonly language?: string; readonly lines: string[] } | undefined

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    const element = document.createElement('p')
    appendInline(document, element, paragraph.join(' '))
    article.append(element)
    paragraph = []
  }
  const flushList = (): void => {
    if (list === undefined) return
    article.append(list)
    list = undefined
  }
  const flushCode = (): void => {
    if (code === undefined) return
    const pre = document.createElement('pre')
    const element = document.createElement('code')
    if (code.language !== undefined && code.language !== '') element.dataset.language = code.language
    element.textContent = code.lines.join('\n')
    pre.append(element)
    article.append(pre)
    code = undefined
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.startsWith('```')) {
      flushParagraph()
      flushList()
      if (code === undefined) {
        const language = line.slice(3).trim()
        code = language === '' ? { lines: [] } : { language, lines: [] }
      }
      else flushCode()
      continue
    }
    if (code !== undefined) {
      code.lines.push(line)
      continue
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading !== null) {
      flushParagraph()
      flushList()
      const level = heading[1]?.length ?? 1
      const element = document.createElement(`h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6')
      appendInline(document, element, heading[2] ?? '')
      article.append(element)
      continue
    }
    if (/^\s*(?:-{3,}|\*{3,})\s*$/u.test(line)) {
      flushParagraph()
      flushList()
      article.append(document.createElement('hr'))
      continue
    }
    if (line.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1] ?? '')) {
      flushParagraph()
      flushList()
      const headings = tableCells(line)
      const table = document.createElement('table')
      const head = document.createElement('thead')
      const headRow = document.createElement('tr')
      for (const value of headings) {
        const cell = document.createElement('th')
        appendInline(document, cell, value)
        headRow.append(cell)
      }
      head.append(headRow)
      table.append(head)
      const body = document.createElement('tbody')
      index += 2
      while (index < lines.length && (lines[index] ?? '').includes('|') && (lines[index] ?? '').trim() !== '') {
        const row = document.createElement('tr')
        const values = tableCells(lines[index] ?? '')
        for (let column = 0; column < headings.length; column += 1) {
          const cell = document.createElement('td')
          appendInline(document, cell, values[column] ?? '')
          row.append(cell)
        }
        body.append(row)
        index += 1
      }
      index -= 1
      table.append(body)
      article.append(table)
      continue
    }
    const quote = /^>\s?(.*)$/u.exec(line)
    if (quote !== null) {
      flushParagraph()
      flushList()
      const element = document.createElement('blockquote')
      const content = document.createElement('p')
      appendInline(document, content, quote[1] ?? '')
      element.append(content)
      article.append(element)
      continue
    }
    const item = /^\s*([-*]|\d+\.)\s+(.+)$/.exec(line)
    if (item !== null) {
      flushParagraph()
      const ordered = item[1]?.endsWith('.') === true
      if (list === undefined || ordered !== (list.tagName === 'OL')) {
        flushList()
        list = document.createElement(ordered ? 'ol' : 'ul')
      }
      const element = document.createElement('li')
      const task = /^\[([ xX])\]\s+(.+)$/u.exec(item[2] ?? '')
      if (task !== null) {
        element.className = 'task-list-item'
        const checkbox = document.createElement('input')
        checkbox.type = 'checkbox'
        checkbox.disabled = true
        checkbox.checked = task[1]?.toLocaleLowerCase() === 'x'
        checkbox.setAttribute('aria-hidden', 'true')
        element.append(checkbox)
        appendInline(document, element, task[2] ?? '')
      } else appendInline(document, element, item[2] ?? '')
      list.append(element)
      continue
    }
    if (line.trim() === '') {
      flushParagraph()
      flushList()
      continue
    }
    flushList()
    paragraph.push(line.trim())
  }
  flushParagraph()
  flushList()
  flushCode()
  return article
}
