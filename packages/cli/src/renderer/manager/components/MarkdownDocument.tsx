import { PublicMarkdownViewer } from '../../host-ui/PublicMarkdownViewer.js'

/** Host-owned Markdown projection with sanitized GitHub media and Host-theme-aware code. */
export function MarkdownDocument({ source }: { readonly source: string }) {
  return <PublicMarkdownViewer className="cxr-markdown" source={source} />
}
