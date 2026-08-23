function appendInline(document: Document, parent: HTMLElement, source: string): void {
  const token = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g
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

/** Render a small, non-HTML Markdown subset using owned DOM nodes only. */
export function renderSafeMarkdown(document: Document, markdown: string): HTMLElement {
  const article = document.createElement('article')
  article.className = 'cxm-readme'
  const lines = markdown.replaceAll('\r\n', '\n').split('\n')
  let paragraph: string[] = []
  let list: HTMLUListElement | undefined
  let code: string[] | undefined

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
    element.textContent = code.join('\n')
    pre.append(element)
    article.append(pre)
    code = undefined
  }

  for (const line of lines) {
    if (line.startsWith('```')) {
      flushParagraph()
      flushList()
      if (code === undefined) code = []
      else flushCode()
      continue
    }
    if (code !== undefined) {
      code.push(line)
      continue
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line)
    if (heading !== null) {
      flushParagraph()
      flushList()
      const level = heading[1]?.length ?? 1
      const element = document.createElement(`h${level}` as 'h1' | 'h2' | 'h3' | 'h4')
      appendInline(document, element, heading[2] ?? '')
      article.append(element)
      continue
    }
    const item = /^[-*]\s+(.+)$/.exec(line)
    if (item !== null) {
      flushParagraph()
      list ??= document.createElement('ul')
      const element = document.createElement('li')
      appendInline(document, element, item[1] ?? '')
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
