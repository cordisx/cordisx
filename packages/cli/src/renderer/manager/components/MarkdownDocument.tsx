import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Host-owned Markdown projection: no raw HTML or plugin-supplied renderer escapes. */
export function MarkdownDocument({ source }: { readonly source: string }) {
  return <article className="cxr-markdown cxm-readme">
    <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={{
      a: ({ href, children, ...props }) => {
        const external = href?.startsWith('https://') || href?.startsWith('http://')
        return <a {...props} href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{children}</a>
      },
    }}>{source}</ReactMarkdown>
  </article>
}
