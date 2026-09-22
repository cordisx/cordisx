import { readFile } from 'node:fs/promises'

/** Reuse the approved one-shot SVG artwork without importing the React runtime. */
export async function startupBrand(): Promise<{ markup: string; animate: string }> {
  const assets = await Promise.all(['dark', 'light'].map(async appearance => {
    const asset = await readFile(
      new URL(`../../assets/brand/cordisx-mark-animated-${appearance}.svg`, import.meta.url),
      'utf8',
    )
    const script = asset.match(/<script><!\[CDATA\[([\s\S]*?)\]\]><\/script>/u)?.[1]
    if (!script) throw new Error('Official CordisX animated mark is missing its animation')
    return {
      appearance,
      markup: asset.replace(/<script>[\s\S]*?<\/script>/u, '').replace('<svg ', `<svg class="mark-${appearance}" `),
      script,
    }
  }))
  const animate = `function animateStartupMark(mark) {
    const appearance = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    const requestAnimationFrame = callback => globalThis.requestAnimationFrame(time => {
      if (mark.isConnected) callback(time);
    });
    ${
    assets.map(asset =>
      `{
      const svg = mark.querySelector('.mark-${asset.appearance}');
      const document = {
        getElementById: id => svg.querySelector('[id="' + id + '"]'),
        createDocumentFragment: () => mark.ownerDocument.createDocumentFragment(),
      };
      const matchMedia = query => ({ matches: appearance !== '${asset.appearance}' || globalThis.matchMedia(query).matches });
      ${asset.script}
    }`
    ).join('\n')
  }
  }`
  return { markup: assets.map(asset => asset.markup).join('\n'), animate }
}
