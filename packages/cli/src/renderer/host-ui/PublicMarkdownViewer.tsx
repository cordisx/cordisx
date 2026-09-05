/** @jsxImportSource react */
import {
  Children,
  cloneElement,
  type ComponentPropsWithoutRef,
  isValidElement,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { type HostAppTheme, resolveHostTheme } from '../host-theme.js'
import { highlightSafeMarkdownCodeBlocks } from '../markdown.js'

const MARKDOWN_SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: [...defaultSchema.tagNames ?? [], 'video'],
  attributes: {
    ...defaultSchema.attributes,
    img: [...defaultSchema.attributes?.img ?? [], 'alt', 'title', 'width', 'height', 'loading', 'decoding'],
    source: [...defaultSchema.attributes?.source ?? [], 'media', 'src', 'srcSet', 'type'],
    video: ['src', 'poster', 'controls', 'loop', 'muted', 'playsInline', 'preload', 'width', 'height', 'title'],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: [...defaultSchema.protocols?.src ?? [], 'data'],
    srcSet: ['http', 'https', 'data'],
    poster: ['http', 'https', 'data'],
  },
}

function joinClassName(...values: (string | undefined)[]): string {
  return values.filter((value): value is string => value !== undefined && value !== '').join(' ')
}

function useHostTheme(): HostAppTheme {
  const read = () => resolveHostTheme(document).theme
  const [theme, setTheme] = useState<HostAppTheme>(read)
  useEffect(() => {
    const update = () => setTheme(read())
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme', 'data-color-theme', 'data-color-scheme'],
    })
    if (document.body !== null) {
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme', 'data-color-theme', 'data-color-scheme'],
      })
    }
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    media?.addEventListener?.('change', update)
    return () => {
      observer.disconnect()
      media?.removeEventListener?.('change', update)
    }
  }, [])
  return theme
}

function pictureChildren(children: ReactNode, theme: HostAppTheme): ReactNode {
  return Children.map(children, child => {
    if (!isValidElement<{ readonly media?: string }>(child) || child.type !== 'source') return child
    const condition = child.props.media?.toLocaleLowerCase()
    const expected = condition?.includes('prefers-color-scheme: dark') === true
      ? 'dark'
      : condition?.includes('prefers-color-scheme: light') === true
      ? 'light'
      : undefined
    return expected === undefined ? child : cloneElement(child, { media: expected === theme ? 'all' : 'not all' })
  })
}

function markdownUrlTransform(value: string, key: string): string {
  if (
    (key === 'src' || key === 'srcSet' || key === 'poster')
    && /^data:(?:image|video)\/[a-z0-9.+-]+(?:;base64)?,/iu.test(value)
  ) return value
  return defaultUrlTransform(value)
}

export interface PublicMarkdownViewerProps {
  readonly source: string
  readonly className?: string
  readonly 'aria-label'?: string
}

/** Public Host-owned Markdown projection with sanitized media and theme-aware code. */
export function PublicMarkdownViewer({ source, className, 'aria-label': ariaLabel }: PublicMarkdownViewerProps) {
  const article = useRef<HTMLElement>(null)
  const theme = useHostTheme()
  useEffect(() => {
    const element = article.current
    if (element !== null) void highlightSafeMarkdownCodeBlocks(element, theme).catch(() => undefined)
  }, [source, theme])
  const components = useMemo(() => ({
    a: ({ href, children, node: _node, ...props }: ComponentPropsWithoutRef<'a'> & { readonly node?: unknown }) => {
      const external = href?.startsWith('https://') || href?.startsWith('http://')
      return (
        <a {...props} href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{children}</a>
      )
    },
    code: (
      { className: codeClassName, children, node: _node, ...props }: ComponentPropsWithoutRef<'code'> & {
        readonly node?: unknown
      },
    ) => {
      const language = /(?:^|\s)language-([^\s]+)/u.exec(codeClassName ?? '')?.[1]
      return (
        <code {...props} className={codeClassName} {...(language === undefined ? {} : { 'data-language': language })}>
          {children}
        </code>
      )
    },
    img: ({ node: _node, ...props }: ComponentPropsWithoutRef<'img'> & { readonly node?: unknown }) => (
      <img {...props} loading="lazy" decoding="async" />
    ),
    picture: (
      { children, node: _node, ...props }: ComponentPropsWithoutRef<'picture'> & { readonly node?: unknown },
    ) => <picture {...props}>{pictureChildren(children, theme)}</picture>,
    video: ({ node: _node, ...props }: ComponentPropsWithoutRef<'video'> & { readonly node?: unknown }) => (
      <video {...props} controls preload="metadata" />
    ),
  }), [theme])
  return (
    <article ref={article} className={joinClassName('cxr-ui-markdown', 'cxm-readme', className)} aria-label={ariaLabel}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA]]}
        urlTransform={markdownUrlTransform}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </article>
  )
}
