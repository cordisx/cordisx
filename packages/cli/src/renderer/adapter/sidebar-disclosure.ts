/** Keep the shared SVG node while adopting the native disclosure's vector specification. */
const projected = new WeakMap<SVGSVGElement, string>()
const vectorAttributes = [
  'd',
  'fill',
  'fill-rule',
  'clip-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
] as const

export function projectSidebarDisclosure(root: HTMLElement, heading: HTMLElement | undefined): void {
  if (root.dataset.cordisxSidebarAppearance !== 'codex') return
  const native = heading?.querySelector('svg')
  const viewBox = native?.getAttribute('viewBox')
  const paths = native === undefined || native === null ? [] : [...native.querySelectorAll('path')]
  if (viewBox == null || !/^[\d.\s-]+$/.test(viewBox) || paths.length === 0) return
  // Only vector geometry and currentColor paint are copied, never classes,
  // event handlers, external references, transient opacity, or transforms.
  const vectors = paths.map(path => Object.fromEntries(vectorAttributes.map(name => [name, path.getAttribute(name)])))
  if (
    vectors.some(vector =>
      ['fill', 'stroke'].some(name =>
        vector[name] !== null && vector[name] !== 'none' && vector[name] !== 'currentColor'
      )
    )
  ) return
  const signature = JSON.stringify([viewBox, vectors])
  for (const svg of root.querySelectorAll<SVGSVGElement>('.cordisx-navigation-group-chevron')) {
    if (projected.get(svg) === signature) continue
    svg.setAttribute('viewBox', viewBox)
    svg.replaceChildren(...vectors.map(vector => {
      const path = root.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path')
      for (const [name, value] of Object.entries(vector)) if (value !== null) path.setAttribute(name, value)
      return path
    }))
    svg.setAttribute('data-host-icon-provider', 'native:codex-sidebar')
    projected.set(svg, signature)
  }
}
