import {
  CANONICAL_COMBINING_CLASSES,
  CANONICAL_COMPOSITIONS,
  CANONICAL_DECOMPOSITIONS,
  NFKC_CASEFOLD_MAPPINGS,
  UNICODE_MANAGER_COLLECTION_VERSION,
} from './manager-collection-unicode-17.generated.js'

const REPLACEMENT = 0xFFFD
const S_BASE = 0xAC00
const L_BASE = 0x1100
const V_BASE = 0x1161
const T_BASE = 0x11A7
const L_COUNT = 19
const V_COUNT = 21
const T_COUNT = 28
const N_COUNT = V_COUNT * T_COUNT
const S_COUNT = L_COUNT * N_COUNT

const WHITE_SPACE = new Set([
  0x0009,
  0x000A,
  0x000B,
  0x000C,
  0x000D,
  0x0020,
  0x0085,
  0x00A0,
  0x1680,
  0x2000,
  0x2001,
  0x2002,
  0x2003,
  0x2004,
  0x2005,
  0x2006,
  0x2007,
  0x2008,
  0x2009,
  0x200A,
  0x2028,
  0x2029,
  0x202F,
  0x205F,
  0x3000,
])

export const MANAGER_COLLECTION_UNICODE_VERSION = UNICODE_MANAGER_COLLECTION_VERSION

function scalars(value: string): number[] {
  const result: number[] = []
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index)
    if (first >= 0xD800 && first <= 0xDBFF) {
      const second = value.charCodeAt(index + 1)
      if (second >= 0xDC00 && second <= 0xDFFF) {
        result.push(((first - 0xD800) * 0x400) + (second - 0xDC00) + 0x10000)
        index += 1
      } else result.push(REPLACEMENT)
    } else if (first >= 0xDC00 && first <= 0xDFFF) result.push(REPLACEMENT)
    else result.push(first)
  }
  return result
}

function decomposeHangul(value: number, output: number[]): boolean {
  const index = value - S_BASE
  if (index < 0 || index >= S_COUNT) return false
  output.push(L_BASE + Math.floor(index / N_COUNT))
  output.push(V_BASE + Math.floor((index % N_COUNT) / T_COUNT))
  const trailing = index % T_COUNT
  if (trailing !== 0) output.push(T_BASE + trailing)
  return true
}

function decompose(value: number, output: number[]): void {
  if (decomposeHangul(value, output)) return
  const mapping = CANONICAL_DECOMPOSITIONS.get(value)
  if (mapping === undefined) {
    output.push(value)
    return
  }
  for (const child of mapping) decompose(child, output)
}

function canonicalOrder(input: readonly number[]): number[] {
  const output: number[] = []
  for (const value of input) {
    const combining = CANONICAL_COMBINING_CLASSES.get(value) ?? 0
    output.push(value)
    if (combining === 0) continue
    let index = output.length - 1
    while (index > 0) {
      const previous = CANONICAL_COMBINING_CLASSES.get(output[index - 1]!) ?? 0
      if (previous === 0 || previous <= combining) break
      ;[output[index - 1], output[index]] = [output[index]!, output[index - 1]!]
      index -= 1
    }
  }
  return output
}

function composeHangul(left: number, right: number): number | undefined {
  const lIndex = left - L_BASE
  if (lIndex >= 0 && lIndex < L_COUNT) {
    const vIndex = right - V_BASE
    if (vIndex >= 0 && vIndex < V_COUNT) return S_BASE + (lIndex * V_COUNT + vIndex) * T_COUNT
  }
  const sIndex = left - S_BASE
  if (sIndex >= 0 && sIndex < S_COUNT && sIndex % T_COUNT === 0) {
    const tIndex = right - T_BASE
    if (tIndex > 0 && tIndex < T_COUNT) return left + tIndex
  }
  return undefined
}

function canonicalCompose(input: readonly number[]): number[] {
  if (input.length === 0) return []
  const output = [input[0]!]
  let starterIndex = 0
  let starter = output[0]!
  let previousCombining = 0
  for (const value of input.slice(1)) {
    const combining = CANONICAL_COMBINING_CLASSES.get(value) ?? 0
    const composed = composeHangul(starter, value) ?? CANONICAL_COMPOSITIONS.get(`${starter}:${value}`)
    if (composed !== undefined && (previousCombining === 0 || previousCombining < combining)) {
      output[starterIndex] = composed
      starter = composed
      continue
    }
    output.push(value)
    if (combining === 0) {
      starterIndex = output.length - 1
      starter = value
    }
    previousCombining = combining
  }
  return output
}

function unicode17Nfc(input: readonly number[]): number[] {
  const decomposed: number[] = []
  for (const value of input) decompose(value, decomposed)
  return canonicalCompose(canonicalOrder(decomposed))
}

export interface ManagerCollectionNormalizationBounds {
  readonly maximumInputCodePoints?: number
  readonly maximumOutputCodePoints?: number
}

/** Exact Unicode 17.0.0 toNFKC_Casefold R5 + NFC + frozen White_Space folding. */
export function normalizeManagerCollectionSearch(
  value: string,
  bounds: ManagerCollectionNormalizationBounds = {},
): string {
  const input = scalars(value)
  if (bounds.maximumInputCodePoints !== undefined && input.length > bounds.maximumInputCodePoints) {
    throw new Error('manager collection search input exceeds its code-point bound')
  }
  const mapped: number[] = []
  for (const scalar of input) {
    const replacement = NFKC_CASEFOLD_MAPPINGS.get(scalar)
    if (replacement === undefined) mapped.push(scalar)
    else mapped.push(...scalars(replacement))
  }
  const normalized = unicode17Nfc(mapped)
  const folded: number[] = []
  let pendingSpace = false
  for (const scalar of normalized) {
    if (WHITE_SPACE.has(scalar)) {
      if (folded.length > 0) pendingSpace = true
      continue
    }
    if (pendingSpace) folded.push(0x20)
    pendingSpace = false
    folded.push(scalar)
  }
  if (bounds.maximumOutputCodePoints !== undefined && folded.length > bounds.maximumOutputCodePoints) {
    throw new Error('manager collection normalized search exceeds its code-point bound')
  }
  return String.fromCodePoint(...folded)
}

/** Contiguous Unicode-code-point substring; never spans two source fields. */
export function managerCollectionCodePointIncludes(haystack: string, needle: string): boolean {
  const source = scalars(haystack)
  const query = scalars(needle)
  if (query.length === 0) return true
  if (query.length > source.length) return false
  outer: for (let start = 0; start <= source.length - query.length; start += 1) {
    for (let offset = 0; offset < query.length; offset += 1) {
      if (source[start + offset] !== query[offset]) continue outer
    }
    return true
  }
  return false
}
