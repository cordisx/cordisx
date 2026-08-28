import { useEffect, useRef } from 'react'
import cordisxMarkDark from '../../../assets/brand/cordisx-mark-dark.svg'
import cordisxMarkLight from '../../../assets/brand/cordisx-mark-light.svg'

const darkUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cordisxMarkDark)}`
const lightUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cordisxMarkLight)}`

/** DOM form for Host primitives that are mounted outside a React root. */
export function createBrandMarkElement(document: Document, className?: string): HTMLSpanElement {
  const mark = document.createElement('span')
  mark.className = ['cxr-brand-mark', className].filter(Boolean).join(' ')
  mark.setAttribute('aria-hidden', 'true')
  for (const [appearance, uri] of [['dark', darkUri], ['light', lightUri]] as const) {
    const image = document.createElement('img')
    image.className = `cxr-brand-mark-${appearance}`
    image.src = uri
    image.alt = ''
    image.draggable = false
    mark.append(image)
  }
  return mark
}

type Appearance = 'dark' | 'light'
type LineData = readonly [number, number, number, number, number, string]

interface AnimatedAsset {
  readonly appearance: Appearance
  readonly official: readonly LineData[]
  readonly outer: readonly LineData[]
}

function attribute(tag: string, name: string): string {
  const value = tag.match(new RegExp(`${name}="([#\\da-f.]+)"`))?.[1]
  if (value === undefined) throw new Error(`CordisX mark is missing ${name}`)
  return value
}

function parseLine(tag: string): LineData {
  return [
    Number(attribute(tag, 'x1')),
    Number(attribute(tag, 'y1')),
    Number(attribute(tag, 'x2')),
    Number(attribute(tag, 'y2')),
    Number(attribute(tag, 'stroke-width')),
    attribute(tag, 'stroke'),
  ]
}

function point(line: LineData, offset: 0 | 2): string {
  const x = offset === 0 ? line[0] : line[2]
  const y = offset === 0 ? line[1] : line[3]
  return `${x.toFixed(2)},${y.toFixed(2)}`
}

function item<T>(items: readonly T[], index: number, label: string): T {
  const value = items[index]
  if (value === undefined) throw new Error(`CordisX mark is missing ${label} ${index}`)
  return value
}

function splitRings(lines: readonly LineData[]): readonly number[][] {
  const endpoints = lines.map(line => [point(line, 0), point(line, 2)] as const)
  const touching = new Map<string, number[]>()
  endpoints.forEach((pair, index) => pair.forEach((key) => {
    const list = touching.get(key) ?? []
    list.push(index)
    touching.set(key, list)
  }))

  const seen = new Set<number>()
  const components: number[][] = []
  for (let start = 0; start < lines.length; start += 1) {
    if (seen.has(start)) continue
    const stack = [start]
    const component: number[] = []
    seen.add(start)
    while (stack.length > 0) {
      const index = stack.pop()
      if (index === undefined) break
      component.push(index)
      for (const key of item(endpoints, index, 'endpoint')) {
        for (const next of touching.get(key) ?? []) {
          if (seen.has(next)) continue
          seen.add(next)
          stack.push(next)
        }
      }
    }
    components.push(component.sort((left, right) => left - right))
  }

  if (components.length !== 3 || components.some(component => component.length !== 480)) {
    throw new Error('CordisX mark must contain three 480-segment rings')
  }
  const width = (component: readonly number[]) => {
    const xs = component.flatMap(index => {
      const line = item(lines, index, 'line')
      return [line[0], line[2]]
    })
    return Math.max(...xs) - Math.min(...xs)
  }
  return components.sort((left, right) => width(right) - width(left))
}

function animatedAsset(source: string, appearance: Appearance): AnimatedAsset {
  const official = (source.match(/<line\b[^>]*\/>/g) ?? []).map(parseLine)
  const outerIndexes = item(splitRings(official), 0, 'outer ring')
  return { appearance, official, outer: outerIndexes.map(index => item(official, index, 'official line')) }
}

const animatedAssets = {
  dark: animatedAsset(cordisxMarkDark, 'dark'),
  light: animatedAsset(cordisxMarkLight, 'light'),
} as const

function setLine(node: SVGLineElement, values: LineData): void {
  node.setAttribute('x1', values[0].toFixed(2))
  node.setAttribute('y1', values[1].toFixed(2))
  node.setAttribute('x2', values[2].toFixed(2))
  node.setAttribute('y2', values[3].toFixed(2))
  node.setAttribute('stroke-width', values[4].toFixed(2))
  node.setAttribute('stroke', values[5])
}

function AnimatedMarkSvg({ asset, className }: { readonly asset: AnimatedAsset; readonly className: string }) {
  const groupRef = useRef<SVGGElement>(null)
  const initial = [asset.outer, asset.outer, asset.outer].flat()

  useEffect(() => {
    const group = groupRef.current
    if (group === null) return
    const nodes = Array.from(group.children) as SVGLineElement[]
    const center = 512
    const baseWidth = 56
    const hold = 420
    const finish = 3200
    const targetTilt = 64.8 * Math.PI / 180
    const configs = [
      { axis: null, direction: 0, distance: Infinity },
      { axis: 45 * Math.PI / 180, direction: -1, distance: 4200 },
      { axis: 135 * Math.PI / 180, direction: 1, distance: 4200 },
    ] as const
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
    const ease = (progress: number) => -(Math.cos(Math.PI * progress) - 1) / 2
    const hex = (value: number) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0')
    const shade = (width: number) => {
      if (asset.appearance === 'dark') {
        const middle = clamp(188 + (width - baseWidth) * 15.4, 125, 252)
        return `#${hex(middle - 2)}${hex(middle)}${hex(middle + 2)}`
      }
      const middle = clamp(71 - (width - baseWidth) * 16.5, 3, 139)
      return `#${hex(middle)}${hex(middle)}${hex(middle)}`
    }
    const rotate = (point3d: { x: number; y: number; z: number }, axisAngle: number, angle: number) => {
      const ux = Math.cos(axisAngle)
      const uy = Math.sin(axisAngle)
      const cosine = Math.cos(angle)
      const sine = Math.sin(angle)
      const dot = ux * point3d.x + uy * point3d.y
      return {
        x: point3d.x * cosine + uy * point3d.z * sine + ux * dot * (1 - cosine),
        y: point3d.y * cosine - ux * point3d.z * sine + uy * dot * (1 - cosine),
        z: (ux * point3d.y - uy * point3d.x) * sine + point3d.z * cosine,
      }
    }
    const project = (point3d: { x: number; y: number; z: number }, distance: number) => {
      const scale = distance / (distance - point3d.z)
      return { x: center + point3d.x * scale, y: center + point3d.y * scale, z: point3d.z }
    }
    const renderOfficial = () => {
      const fragment = document.createDocumentFragment()
      asset.official.forEach((line, index) => {
        const node = item(nodes, index, 'animated line')
        setLine(node, line)
        fragment.appendChild(node)
      })
      group.appendChild(fragment)
    }

    if (window.getComputedStyle(group.parentElement ?? group).display === 'none') {
      renderOfficial()
      return
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      renderOfficial()
      return
    }

    const start = performance.now()
    let animationFrame = 0
    const frame = (now: number) => {
      const elapsed = now - start
      const progress = elapsed <= hold ? 0 : ease(clamp((elapsed - hold) / (finish - hold), 0, 1))
      const rendered: Array<{ node: SVGLineElement; depth: number }> = []
      let nodeIndex = 0

      configs.forEach((config, ringIndex) => {
        const angle = config.direction * (Math.PI * 2 + targetTilt) * progress
        asset.outer.forEach(source => {
          const node = item(nodes, nodeIndex++, 'animated line')
          if (ringIndex === 0 || config.axis === null) {
            setLine(node, source)
            rendered.push({ node, depth: 0 })
            return
          }
          const first3d = rotate({ x: source[0] - center, y: source[1] - center, z: 0 }, config.axis, angle)
          const second3d = rotate({ x: source[2] - center, y: source[3] - center, z: 0 }, config.axis, angle)
          const first = project(first3d, config.distance)
          const second = project(second3d, config.distance)
          const depth = (first.z + second.z) / 2
          const scale = config.distance / (config.distance - depth)
          const width = baseWidth * scale
          setLine(node, [first.x, first.y, second.x, second.y, width, shade(width)])
          rendered.push({ node, depth })
        })
      })

      rendered.sort((left, right) => left.depth - right.depth)
      const fragment = document.createDocumentFragment()
      rendered.forEach(({ node }) => fragment.appendChild(node))
      group.appendChild(fragment)

      if (elapsed < finish) animationFrame = window.requestAnimationFrame(frame)
      else renderOfficial()
    }
    animationFrame = window.requestAnimationFrame(frame)
    return () => window.cancelAnimationFrame(animationFrame)
  }, [asset])

  return <svg className={className} viewBox="0 0 1024 1024" role="presentation" data-cordisx-animation="one-shot">
    <g ref={groupRef} fill="none" strokeLinecap="round">
      {initial.map((line, index) => <line key={index} x1={line[0]} y1={line[1]} x2={line[2]} y2={line[3]} strokeWidth={line[4]} stroke={line[5]} />)}
    </g>
  </svg>
}

/** Host-owned adaptive CordisX mark using the repository's approved artwork. */
export function BrandMark({ className }: { readonly className?: string }) {
  return <span className={['cxr-brand-mark', className].filter(Boolean).join(' ')} aria-hidden="true">
    <img className="cxr-brand-mark-dark" src={darkUri} alt="" draggable={false} />
    <img className="cxr-brand-mark-light" src={lightUri} alt="" draggable={false} />
  </span>
}

/** About-page mark that unfolds once whenever the page is mounted. */
export function AnimatedBrandMark({ className }: { readonly className?: string }) {
  return <span className={['cxr-brand-mark', 'cxr-brand-mark-animated', className].filter(Boolean).join(' ')} aria-hidden="true">
    <AnimatedMarkSvg className="cxr-brand-mark-dark" asset={animatedAssets.dark} />
    <AnimatedMarkSvg className="cxr-brand-mark-light" asset={animatedAssets.light} />
  </span>
}
