import { expect, it } from 'vitest'
import { nativeChunkPaths } from '../packages/codex-adapter/src/native-chunk-structure.js'
import { discoverNativeSubmissionTransforms } from '../packages/codex-adapter/src/native-submission-structure.js'
import { resources } from './fixtures/native-submission-structure.js'

it('resolves finite native chunk tables without running application code', () => {
  expect(nativeChunkPaths(`r.u=id=>'assets/async/'+id+'.'+({12:'abc',34:'def'})[id]+'.js'`))
    .toEqual(['assets/async/12.abc.js', 'assets/async/34.def.js'])
  expect(nativeChunkPaths(`r.u=id=>'assets/async/'+runCode(id)+'.js'`)).toEqual([])
  expect(nativeChunkPaths(`r.u=id=>'assets/async/'+id+'.'+({12:'../../escape'})[id]+'.js'`)).toEqual([])
})

const factory = (id: string, source: string) =>
  `export const __webpack_modules__={${JSON.stringify(id)}(module,exports,require){${source}}};`

it('patches each lazy copy of a verified native module without treating minified copies as different capabilities', () => {
  const [primary, initial] = resources()
  const fixture = [
    { url: 'app://-/assets/async/a.js', source: factory('composer', primary!.source) },
    { url: 'app://-/assets/async/b.js', source: factory('composer', primary!.source.replaceAll('context', 'context')) },
    { url: 'app://-/assets/async/c.js', source: factory('requests', initial!.source) },
  ]
  // The menu capability lives in its own module in Rspack builds.
  const menuStart = primary!.source.indexOf('let select;')
  const menuEnd = primary!.source.indexOf('async function draft')
  const menu = primary!.source.slice(menuStart, menuEnd)
  fixture[0]!.source = factory('composer', primary!.source.replace(menu, ''))
  fixture[1]!.source = factory(
    'composer',
    primary!.source.replace(menu, '').replaceAll('prompt:prompt', 'prompt:renamed'),
  )
  fixture.push({ url: 'app://-/assets/async/menu.js', source: factory('menu', menu) })
  fixture.push({ url: 'app://-/assets/async/menu-copy.js', source: factory('menu', menu) })
  const transforms = discoverNativeSubmissionTransforms(fixture)
  expect(transforms).toHaveLength(5)
  expect(transforms.every(transform => transform.requiredForDocumentReady === false)).toBe(true)
  for (const transform of transforms) {
    const original = fixture.find(resource => resource.url === transform.url)!.source
    expect(transform.transform(original).anchorMatches).toBe(1)
    expect(() => transform.transform(original + '\n')).toThrow('changed')
  }
})

it('rejects competing native module identities and duplicate capabilities within a factory', () => {
  const [primary, initial] = resources()
  const fixture = [
    { url: 'app://-/assets/a.js', source: factory('one', primary!.source) },
    { url: 'app://-/assets/b.js', source: factory('two', primary!.source) },
    { url: 'app://-/assets/c.js', source: factory('requests', initial!.source) },
  ]
  expect(() => discoverNativeSubmissionTransforms(fixture)).toThrow('submit-guard')
  const duplicate = primary!.source
    + primary!.source.slice(
      primary!.source.indexOf('async function draft'),
      primary!.source.indexOf('async function existing'),
    ).replace('function draft', 'function otherDraft')
  expect(() =>
    discoverNativeSubmissionTransforms([
      { ...fixture[0]!, source: factory('one', duplicate) },
      fixture[2]!,
    ])
  ).toThrow('duplicate structure')
})
