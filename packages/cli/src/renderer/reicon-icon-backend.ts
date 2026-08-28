/*
 * Host-private Reicon compiler. This is the only production module allowed to
 * import Reicon or inspect its raw iconData/path strings. Neither source data
 * nor IconFunction crosses the normalized descriptor boundary.
 */
import type { IconFunction, IconWeight } from 'reicon/createIcon'
import Activity from 'reicon/icons/Activity'
import Add from 'reicon/icons/Add'
import ArrowDown from 'reicon/icons/ArrowDown'
import ArrowLeft from 'reicon/icons/ArrowLeft'
import ArrowRight from 'reicon/icons/ArrowRight'
import ArrowUp from 'reicon/icons/ArrowUp'
import ArrowUpRightSquare from 'reicon/icons/ArrowUpRightSquare'
import AlertTriangle from 'reicon/icons/AlertTriangle'
import Calendar from 'reicon/icons/Calendar'
import Chart from 'reicon/icons/Chart'
import Check from 'reicon/icons/Check'
import CheckCircle from 'reicon/icons/CheckCircle'
import Clock2 from 'reicon/icons/Clock2'
import Component from 'reicon/icons/Component'
import Copy from 'reicon/icons/Copy'
import Crown from 'reicon/icons/Crown'
import DocumentText from 'reicon/icons/DocumentText'
import Edit from 'reicon/icons/Edit'
import File from 'reicon/icons/File'
import Floppy from 'reicon/icons/Floppy'
import Folder from 'reicon/icons/Folder'
import History from 'reicon/icons/History'
import InfoCircle from 'reicon/icons/InfoCircle'
import Key from 'reicon/icons/Key'
import Layers from 'reicon/icons/Layers'
import MinusCircle from 'reicon/icons/MinusCircle'
import MoreH from 'reicon/icons/MoreH'
import Palette from 'reicon/icons/Palette'
import Puzzle from 'reicon/icons/Puzzle'
import Refresh from 'reicon/icons/Refresh'
import Rocket from 'reicon/icons/Rocket'
import Route from 'reicon/icons/Route'
import Search from 'reicon/icons/Search'
import Settings from 'reicon/icons/Settings'
import Share from 'reicon/icons/Share'
import Shop from 'reicon/icons/Shop'
import Sparkles from 'reicon/icons/Sparkles'
import Tag from 'reicon/icons/Tag'
import Trash2 from 'reicon/icons/Trash2'
import Verified from 'reicon/icons/Verified'
import XCircle from 'reicon/icons/XCircle'
import X from 'reicon/icons/X'
import {
  isNormalizedVectorDescriptor,
  type IconState,
  type IconVariant,
  type NormalizedVectorCommand,
  type NormalizedVectorDescriptor,
  type NormalizedVectorPath,
  type SemanticIconKey,
} from '../icon-theme-contracts.js'

const REICON_GLYPHS = Object.freeze({
  'action.add': Add,
  'action.back': ArrowLeft,
  'action.close': X,
  'action.copy': Copy,
  'action.delete': Trash2,
  'action.edit': Edit,
  'action.external-link': ArrowUpRightSquare,
  'action.more': MoreH,
  'action.open': Folder,
  'action.refresh': Refresh,
  'action.reset': Refresh,
  'action.save': Floppy,
  'action.search': Search,
  'action.settings': Settings,
  'action.share': Share,
  'agent.reasoning': Sparkles,
  'content.calendar': Calendar,
  'content.clock': Clock2,
  'content.files': File,
  'content.folder': Folder,
  'content.key': Key,
  'content.layers': Layers,
  'content.palette': Palette,
  'content.panel': Component,
  'content.tags': Tag,
  'control.check': Check,
  'control.chevron-down': ArrowDown,
  'control.chevron-left': ArrowLeft,
  'control.chevron-right': ArrowRight,
  'control.chevron-up': ArrowUp,
  'control.minus': MinusCircle,
  'control.plus': Add,
  'navigation.about': InfoCircle,
  'navigation.channels': Component,
  'navigation.dashboard': Chart,
  'navigation.extensions': Component,
  'navigation.history': History,
  'navigation.launcher': Rocket,
  'navigation.marketplace': Shop,
  'navigation.overview': Chart,
  'navigation.plugins': Puzzle,
  'navigation.routes': Route,
  'navigation.runtime': Activity,
  'navigation.store': Shop,
  'status.error': XCircle,
  'status.info': InfoCircle,
  'status.pending': Clock2,
  'status.success': CheckCircle,
  'status.warning': AlertTriangle,
  'trust.certified': Verified,
  'trust.official': Crown,
} as const satisfies Readonly<Record<SemanticIconKey, IconFunction>>)

const numberPattern = '[-+]?(?:\\d*\\.\\d+|\\d+\\.?)(?:[eE][-+]?\\d+)?'
const tokenPattern = new RegExp(`[A-Za-z]|${numberPattern}`, 'g')

function pathCommands(source: string): readonly NormalizedVectorCommand[] {
  const tokens = source.match(tokenPattern) ?? []
  const commands: NormalizedVectorCommand[] = []
  let index = 0
  let operation = ''
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let lastCubicX = 0
  let lastCubicY = 0
  let lastQuadraticX = 0
  let lastQuadraticY = 0
  let previous = ''
  const number = (): number => {
    const token = tokens[index++]
    if (token === undefined || /^[A-Za-z]$/.test(token)) throw new Error('invalid Reicon path operand')
    const value = Number(token)
    if (!Number.isFinite(value)) throw new Error('invalid Reicon path number')
    return value
  }
  const point = (relative: boolean): readonly [number, number] => {
    const nextX = number()
    const nextY = number()
    return relative ? [x + nextX, y + nextY] : [nextX, nextY]
  }
  while (index < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[index]!)) operation = tokens[index++]!
    if (operation === '') throw new Error('Reicon path lacks an operation')
    const relative = operation === operation.toLowerCase()
    const upper = operation.toUpperCase()
    if (upper === 'Z') {
      commands.push({ op: 'close' })
      x = startX
      y = startY
      previous = upper
      operation = ''
      continue
    }
    if (upper === 'M' || upper === 'L') {
      const [nextX, nextY] = point(relative)
      x = nextX
      y = nextY
      const move = upper === 'M' && (commands.length === 0 || previous === 'Z')
      commands.push({ op: move ? 'move' : 'line', x, y })
      if (move) {
        startX = x
        startY = y
        operation = relative ? 'l' : 'L'
      }
    } else if (upper === 'H') {
      const next = number()
      x = relative ? x + next : next
      commands.push({ op: 'line', x, y })
    } else if (upper === 'V') {
      const next = number()
      y = relative ? y + next : next
      commands.push({ op: 'line', x, y })
    } else if (upper === 'C') {
      const [x1, y1] = point(relative)
      const [x2, y2] = point(relative)
      const [nextX, nextY] = point(relative)
      commands.push({ op: 'cubic', x1, y1, x2, y2, x: nextX, y: nextY })
      lastCubicX = x2
      lastCubicY = y2
      x = nextX
      y = nextY
    } else if (upper === 'S') {
      const x1 = previous === 'C' || previous === 'S' ? (2 * x) - lastCubicX : x
      const y1 = previous === 'C' || previous === 'S' ? (2 * y) - lastCubicY : y
      const [x2, y2] = point(relative)
      const [nextX, nextY] = point(relative)
      commands.push({ op: 'cubic', x1, y1, x2, y2, x: nextX, y: nextY })
      lastCubicX = x2
      lastCubicY = y2
      x = nextX
      y = nextY
    } else if (upper === 'Q') {
      const [x1, y1] = point(relative)
      const [nextX, nextY] = point(relative)
      commands.push({ op: 'quadratic', x1, y1, x: nextX, y: nextY })
      lastQuadraticX = x1
      lastQuadraticY = y1
      x = nextX
      y = nextY
    } else if (upper === 'T') {
      const x1 = previous === 'Q' || previous === 'T' ? (2 * x) - lastQuadraticX : x
      const y1 = previous === 'Q' || previous === 'T' ? (2 * y) - lastQuadraticY : y
      const [nextX, nextY] = point(relative)
      commands.push({ op: 'quadratic', x1, y1, x: nextX, y: nextY })
      lastQuadraticX = x1
      lastQuadraticY = y1
      x = nextX
      y = nextY
    } else {
      throw new Error(`unsupported private Reicon path operation: ${operation}`)
    }
    previous = upper
  }
  return commands
}

function attributes(source: string): Readonly<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const match of source.matchAll(/([A-Za-z][\w:-]*)="([^"]*)"/g)) result[match[1]!] = match[2]!
  return result
}

function splitSubpaths(commands: readonly NormalizedVectorCommand[]): readonly (readonly NormalizedVectorCommand[])[] {
  const groups: NormalizedVectorCommand[][] = []
  let current: NormalizedVectorCommand[] = []
  for (const command of commands) {
    if (command.op === 'move' && current.length > 0) {
      groups.push(current)
      current = []
    }
    current.push(command)
    if (command.op === 'close') {
      groups.push(current)
      current = []
    }
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/*
 * Protocol v1 deliberately permits only a final close command. Reicon outline
 * glyphs commonly encode their visible stroke as one evenodd compound fill:
 * an outer contour followed by one or more inner contours. Splitting those
 * contours into independent filled paths destroys the holes and makes the
 * regular glyph look solid. Filled contours are implicitly closed by SVG, so
 * removing only intermediate close commands preserves both the compound path
 * and the Protocol invariant without exposing source SVG/path data.
 */
function compoundFillCommands(commands: readonly NormalizedVectorCommand[]): readonly NormalizedVectorCommand[] {
  return commands.filter((command, index) => command.op !== 'close' || index === commands.length - 1)
}

function compileFragment(fragment: string): NormalizedVectorDescriptor {
  const paths: NormalizedVectorPath[] = []
  for (const match of fragment.matchAll(/<path\b([^>]*)\/?>(?:<\/path>)?/g)) {
    const attrs = attributes(match[1] ?? '')
    if (attrs.d === undefined) throw new Error('Reicon path lacks geometry')
    const commands = pathCommands(attrs.d)
    if (attrs.fill !== undefined && attrs.fill !== 'none') {
      paths.push({
        paint: 'fill',
        ...(attrs['fill-rule'] === undefined ? {} : { fillRule: attrs['fill-rule'] as 'nonzero' | 'evenodd' }),
        ...(attrs.opacity === undefined ? {} : { opacity: Number(attrs.opacity) }),
        commands: compoundFillCommands(commands),
      })
    } else {
      for (const subpath of splitSubpaths(commands)) {
        paths.push({
          paint: 'stroke',
          strokeWidth: Number(attrs['stroke-width'] ?? 1.5),
          lineCap: (attrs['stroke-linecap'] ?? 'butt') as 'butt' | 'round' | 'square',
          lineJoin: (attrs['stroke-linejoin'] ?? 'miter') as 'miter' | 'round' | 'bevel',
          ...(attrs.opacity === undefined ? {} : { opacity: Number(attrs.opacity) }),
          commands: subpath,
        })
      }
    }
  }
  const descriptor: NormalizedVectorDescriptor = {
    format: 'cordisx.normalized-vector',
    formatVersion: 1,
    viewBox: { minX: 0, minY: 0, width: 24, height: 24 },
    paths,
  }
  if (!isNormalizedVectorDescriptor(descriptor)) {
    const shape = paths.map(path => `${path.paint}:${path.commands.length}:${path.commands.map(command => command.op).join(',')}`).join('|')
    throw new Error(`Reicon produced a non-conforming normalized descriptor (${shape})`)
  }
  return Object.freeze(descriptor)
}

const cache = new Map<string, NormalizedVectorDescriptor>()

/** Compile one exact Protocol tuple without exporting Reicon source geometry. */
export function resolveBuiltinReiconDescriptor(
  key: SemanticIconKey,
  variant: IconVariant,
  _state: IconState,
): NormalizedVectorDescriptor {
  const weight: IconWeight = variant === 'filled' ? 'Filled' : 'Outline'
  const cacheKey = `${key}\0${weight}`
  const cached = cache.get(cacheKey)
  if (cached !== undefined) return cached
  const glyph = REICON_GLYPHS[key]
  const sourceKey = weight === 'Filled' ? 'F' : 'O'
  const source = glyph.iconData[sourceKey] ?? glyph.iconData[Object.keys(glyph.iconData)[0]!]
  if (source === undefined) throw new Error(`Reicon has no ${weight} source for ${key}`)
  const descriptor = compileFragment(source)
  cache.set(cacheKey, descriptor)
  return descriptor
}

export function clearBuiltinReiconDescriptorCacheForTests(): void {
  cache.clear()
}
