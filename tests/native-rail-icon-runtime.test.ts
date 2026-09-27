import { describe, expect, it } from 'vitest'
import {
  nativeRailIconVersionAllowed,
  nativeRailReactExportNames,
} from '../packages/cli/src/renderer/adapter/native-rail-icon-runtime.js'

const source = `var a=i((e=>{var t=Symbol.for(\`react.transitional.element\`);e.version=\`19.2.7\`;
${'x'.repeat(120)} })),o=i(((e,t)=>{t.exports=a()}));
var Se=i((e=>{var tu={rendererPackageName:\`react-dom\`};e.createRoot=function(){}})),
Ce=i(((e,t)=>{t.exports=Se()}));export{o as t0t,Ce as P1t};`

describe('native rail React capability probe', () => {
  it('discovers runtime wrappers from this module export table without a build alias list', () => {
    expect(nativeRailReactExportNames(source)).toEqual({ react: 't0t', reactDOM: 'P1t' })
    expect(nativeRailReactExportNames(source.replace('react.transitional.element', 'changed.element')))
      .toBeUndefined()
    expect(nativeRailReactExportNames(source.replace('rendererPackageName', 'renamedPackage')))
      .toBeUndefined()
  })

  it('allows later app versions and refuses a build older than the runtime proof', () => {
    expect(nativeRailIconVersionAllowed('26.924.22138')).toBe(true)
    expect(nativeRailIconVersionAllowed('26.925.1')).toBe(true)
    expect(nativeRailIconVersionAllowed('27.1.0')).toBe(true)
    expect(nativeRailIconVersionAllowed('26.924.20706')).toBe(false)
    expect(nativeRailIconVersionAllowed('unknown')).toBe(false)
  })
})
