type PostElement = { tag: 'md'; text: string } | { tag: 'code_block'; text: string; language?: string }

const languages = new Set([
  'PYTHON',
  'C',
  'CPP',
  'GO',
  'JAVA',
  'KOTLIN',
  'SWIFT',
  'PHP',
  'RUBY',
  'RUST',
  'JAVASCRIPT',
  'TYPESCRIPT',
  'BASH',
  'SHELL',
  'SQL',
  'JSON',
  'XML',
  'YAML',
  'HTML',
  'THRIFT',
])
const aliases: Record<string, string> = { js: 'JAVASCRIPT', ts: 'TYPESCRIPT', py: 'PYTHON', sh: 'SHELL' }

function payloadBytes(content: object): number {
  return Buffer.byteLength(JSON.stringify({ content: JSON.stringify(content) }), 'utf8')
}

export function renderFeishuMarkdown(text: string): { msg_type: 'text' | 'post'; content: object } {
  const plain = { text }
  if (payloadBytes(plain) > 140_000) throw new RangeError('FEISHU_TEXT_TOO_LARGE')
  const fallback = { msg_type: 'text' as const, content: plain }
  if (!/(^|\n)\s*(?:#{1,6} |[-*+] |\d+\. |> |`{3,}|~{3,})|\*\*|~~|\[[^\]\n]+\]\(/.test(text)) return fallback
  const rows: PostElement[][] = []
  let prose: string[] = []
  let fence: { marker: string; width: number; language?: string; lines: string[] } | undefined
  const flush = () => {
    if (prose.length) rows.push([{ tag: 'md', text: prose.join('\n') }])
    prose = []
  }
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/)
      if (closing && closing[1]![0] === fence.marker && closing[1]!.length >= fence.width) {
        rows.push([{
          tag: 'code_block',
          text: fence.lines.join('\n'),
          ...(fence.language ? { language: fence.language } : {}),
        }])
        fence = undefined
      } else fence.lines.push(line)
      continue
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})([\w+-]*)\s*$/)
    if (opening) {
      flush()
      const info = opening[2]!
      const language = aliases[info.toLowerCase()] ?? info.toUpperCase()
      fence = {
        marker: opening[1]![0]!,
        width: opening[1]!.length,
        lines: [],
        ...(languages.has(language) ? { language } : {}),
      }
      continue
    }
    if (/[<>`]|!\[|\|/.test(line.replace(/^\s*> /, '')) || /^\s*(?:`{3,}|~{3,})/.test(line)) return fallback
    prose.push(line.replace(/^ {0,3}#{1,6} (.+?)(?: +#+\s*)?$/, '**$1**').replace(/^(\s*)[*+] /, '$1- '))
  }
  if (fence) return fallback
  flush()
  const content = { zh_cn: { title: '', content: rows } }
  return payloadBytes(content) <= 24_000 ? { msg_type: 'post', content } : fallback
}
