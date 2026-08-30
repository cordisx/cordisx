# Third-party notices

The CordisX CLI depends on packages distributed separately by npm. Their
licenses remain with their respective copyright holders:

| Package | Version used by this beta | Registry license |
| --- | --- | --- |
| `@deepseek-ai/cordis` | `4.0.1` | MIT |
| `@deepseek-ai/schemastery` | `3.18.1` | MIT |
| `@oneworks/avatar` | `1.0.0-rc.8` | MIT |
| `@oneworks/avatar-react` | `1.0.0-rc.8` | MIT |
| `esbuild` | `^0.25.9` | MIT |
| `intl-messageformat` | `11.2.14` | BSD-3-Clause |
| `luna-console` | `1.3.6` | MIT |
| `luna-data-grid` | `1.6.5` | MIT |
| `luna-dom-viewer` | `1.8.4` | MIT |
| `luna-object-viewer` | `0.3.2` | MIT |
| `reicon` | `1.2.1` | MIT |
| `tar` | `7.5.22` | BlueOak-1.0.0 |
| `ws` | `^8.18.3` | MIT |

CordisX also bundles a generated, production-controlled subset of these
packages inside the renderer rather than installing their full npm graphs:

| Bundled package | Exact version | License |
| --- | --- | --- |
| `tdesign-web-components` | `1.2.10` | MIT |
| `omi` | `7.7.13` | MIT |
| `reactive-signal` | `2.0.1` | MIT |
| `weakmap-polyfill` | `2.0.4` | MIT |
| `clsx` | `2.1.1` | MIT |
| `tailwind-merge` | `2.6.1` | MIT |
| `lodash-es` | `4.18.1` | MIT |
| `omi-transition` | `0.1.11` | MIT |
| `@popperjs/core` | `2.11.8` | MIT |

The TDesign subset is generated from npm tarball SHA-256
`e1929f06eda5c3d2ee194da0d6bc9f81e187184fe1054627afeabad2ae71db0e`.
Only Input, Textarea, InputNumber, Select/Option, DatePicker, TagInput,
Checkbox, Switch, Radio, Slider, Button, Alert, and Loading are imported.
Embedded CSS source maps and Omi's
legacy replacement of the native `HTMLElement` constructor are removed; no
component behavior is reimplemented or represented as a different library.
The retained notices and MIT terms are at
`third_party/tdesign-web-components-subset-MIT.txt`.

CordisX bundles only the selected Reicon glyph modules referenced by its
Host-private semantic icon catalog. Reicon credits Solar Icons, designed by
480 Design, under CC BY 4.0 and Zappicon under the Zappicon License as base-icon
sources. Reicon, Zappicon, and Solar Icons remain upstream assets; CordisX does
not represent them as CordisX-owned MIT icon assets, export their raw SVG/icon
dataset, or provide an icon-library redistribution channel. The retained Reicon
MIT terms and upstream credits are at `third_party/reicon-MIT.txt` and
`third_party/reicon-icon-credits.txt`.

The exact dependency graph in `package-lock.json` contains MIT, Apache-2.0,
BSD-3-Clause, BlueOak-1.0.0, and ISC license identifiers for production
dependencies in this beta. This inventory is evidence for release review, not
legal advice.

The plugin DevTools Console pins and locally bundles Luna Console with its
official Luna Object Viewer, Data Grid, and DOM Viewer peers. Their upstream
project is liriliri/luna; all four packages are MIT licensed (copyright
liriliri contributors). CordisX inserts each safe structured `method + args[]`
record independently into Luna Console. The separate Host Inspector contains
metadata only. There is no runtime CDN dependency.

The package-size, dependency, component-coverage, style-isolation, and
reproducible-generation evidence for the TDesign subset is recorded in
`.agents/docs/host-form-system.md`.
