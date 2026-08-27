import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const brandRoot = path.join(packageRoot, 'assets', 'brand')

function attribute(tag, name) {
  return tag.match(new RegExp(`${name}="([#\\da-f.]+)"`))?.[1]
}

function point(tag, suffix) {
  return `${Number(attribute(tag, `x${suffix}`)).toFixed(2)},${Number(attribute(tag, `y${suffix}`)).toFixed(2)}`
}

function lineData(tag) {
  return [
    Number(attribute(tag, 'x1')),
    Number(attribute(tag, 'y1')),
    Number(attribute(tag, 'x2')),
    Number(attribute(tag, 'y2')),
    Number(attribute(tag, 'stroke-width')),
    attribute(tag, 'stroke'),
  ]
}

function splitRings(lineTags) {
  const endpoints = lineTags.map(tag => [point(tag, '1'), point(tag, '2')])
  const touching = new Map()
  endpoints.forEach((pair, index) => pair.forEach((key) => {
    const list = touching.get(key) ?? []
    list.push(index)
    touching.set(key, list)
  }))

  const seen = new Set()
  const components = []
  for (let start = 0; start < lineTags.length; start += 1) {
    if (seen.has(start)) continue
    const stack = [start]
    const component = []
    seen.add(start)
    while (stack.length > 0) {
      const index = stack.pop()
      component.push(index)
      for (const key of endpoints[index]) {
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
    throw new Error(`Expected three 480-segment rings, got ${components.map(component => component.length).join(', ')}`)
  }

  const width = component => {
    const xs = component.flatMap(index => endpoints[index].map(key => Number(key.split(',')[0])))
    return Math.max(...xs) - Math.min(...xs)
  }
  return components.sort((left, right) => width(right) - width(left))
}

function animatedSvg({ source, appearance }) {
  const lineTags = source.match(/<line\b[^>]*\/>/g) ?? []
  const [outer] = splitRings(lineTags)
  const outerData = JSON.stringify(outer.map(index => lineData(lineTags[index])))
  const officialData = JSON.stringify(lineTags.map(lineData))
  const initialLines = [outer, outer, outer]
    .flatMap(component => component)
    .map(index => `    ${lineTags[index]}`)
    .join('\n')
  const shadeExpression = appearance === 'dark'
    ? "const middle = clamp(188 + (width - baseWidth) * 15.4, 125, 252); return '#' + hex(middle - 2) + hex(middle) + hex(middle + 2);"
    : "const middle = clamp(71 - (width - baseWidth) * 16.5, 3, 139); return '#' + hex(middle) + hex(middle) + hex(middle);"

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-labelledby="title desc" data-cordisx-animation="one-shot">
  <title id="title">Animated CordisX mark for ${appearance} backgrounds</title>
  <desc id="desc">Three overlapping rings unfold once around fixed diagonal axes and settle into the official CordisX mark.</desc>
  <g id="dynamic-lines" fill="none" stroke-linecap="round">
${initialLines}
  </g>
  <script><![CDATA[
    (() => {
      const outer = ${outerData};
      const official = ${officialData};
      const center = 512;
      const baseWidth = 56;
      const hold = 420;
      const finish = 3200;
      const targetTilt = 64.8 * Math.PI / 180;
      const group = document.getElementById('dynamic-lines');
      const nodes = Array.from(group.children);
      const configs = [
        { axis: null, direction: 0, distance: Infinity },
        { axis: 45 * Math.PI / 180, direction: -1, distance: 4200 },
        { axis: 135 * Math.PI / 180, direction: 1, distance: 4200 },
      ];
      const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
      const ease = progress => -(Math.cos(Math.PI * progress) - 1) / 2;
      const hex = value => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');
      const shade = width => { ${shadeExpression} };

      const rotate = (point, axisAngle, angle) => {
        const ux = Math.cos(axisAngle);
        const uy = Math.sin(axisAngle);
        const cosine = Math.cos(angle);
        const sine = Math.sin(angle);
        const dot = ux * point.x + uy * point.y;
        return {
          x: point.x * cosine + uy * point.z * sine + ux * dot * (1 - cosine),
          y: point.y * cosine - ux * point.z * sine + uy * dot * (1 - cosine),
          z: (ux * point.y - uy * point.x) * sine + point.z * cosine,
        };
      };

      const project = (point, distance) => {
        const scale = distance / (distance - point.z);
        return { x: center + point.x * scale, y: center + point.y * scale, z: point.z };
      };

      const setLine = (node, values) => {
        node.setAttribute('x1', values[0].toFixed(2));
        node.setAttribute('y1', values[1].toFixed(2));
        node.setAttribute('x2', values[2].toFixed(2));
        node.setAttribute('y2', values[3].toFixed(2));
        node.setAttribute('stroke-width', values[4].toFixed(2));
        node.setAttribute('stroke', values[5]);
      };

      const renderOfficial = () => {
        const fragment = document.createDocumentFragment();
        official.forEach((line, index) => {
          setLine(nodes[index], line);
          fragment.appendChild(nodes[index]);
        });
        group.appendChild(fragment);
      };

      if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
        renderOfficial();
        return;
      }

      const start = performance.now();
      const frame = now => {
        const elapsed = now - start;
        const progress = elapsed <= hold ? 0 : ease(clamp((elapsed - hold) / (finish - hold), 0, 1));
        const rendered = [];
        let nodeIndex = 0;

        configs.forEach((config, ringIndex) => {
          const angle = config.direction * (Math.PI * 2 + targetTilt) * progress;
          outer.forEach(source => {
            const node = nodes[nodeIndex++];
            if (ringIndex === 0) {
              setLine(node, source);
              rendered.push({ node, depth: 0 });
              return;
            }
            const first3d = rotate({ x: source[0] - center, y: source[1] - center, z: 0 }, config.axis, angle);
            const second3d = rotate({ x: source[2] - center, y: source[3] - center, z: 0 }, config.axis, angle);
            const first = project(first3d, config.distance);
            const second = project(second3d, config.distance);
            const depth = (first.z + second.z) / 2;
            const scale = config.distance / (config.distance - depth);
            const width = baseWidth * scale;
            setLine(node, [first.x, first.y, second.x, second.y, width, shade(width)]);
            rendered.push({ node, depth });
          });
        });

        rendered.sort((left, right) => left.depth - right.depth);
        const fragment = document.createDocumentFragment();
        rendered.forEach(({ node }) => fragment.appendChild(node));
        group.appendChild(fragment);

        if (elapsed < finish) requestAnimationFrame(frame);
        else renderOfficial();
      };
      requestAnimationFrame(frame);
    })();
  ]]></script>
</svg>
`
}

for (const appearance of ['dark', 'light']) {
  const sourcePath = path.join(brandRoot, `cordisx-mark-${appearance}.svg`)
  const outputPath = path.join(brandRoot, `cordisx-mark-animated-${appearance}.svg`)
  const source = await readFile(sourcePath, 'utf8')
  await writeFile(outputPath, animatedSvg({ source, appearance }))
  console.log(`[cordisx] wrote ${path.relative(packageRoot, outputPath)}`)
}
