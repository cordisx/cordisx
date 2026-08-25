# @cordisx/schemastery-ui

`@cordisx/schemastery-ui` is CordisX's Host-owned Schemastery form-engine
core. It converts a serializable descriptor into a closed presenter decision,
layout semantics, and deterministic diagnostics. It does not know about the
CordisX Manager, plugin lifecycle, routing, storage paths, or browser page
chrome.

The package accepts schema semantics and a bounded `formPresentation` token;
it never accepts a renderer, HTML, CSS, SVG, selector, popup target, or
callback from a plugin. The CordisX Host's TDesign adapter consumes the same
resolution in Manager, dialog, subpage, and UI Playground surfaces.

The API is versioned at the descriptor/presenter boundary from its first
release. It follows Schemastery's documented descriptor semantics and borrows
the type-to-presentation separation demonstrated by ZodUI, but includes no
upstream UI code, stylesheet, or document prose. The package is licensed
AGPL-3.0-or-later under the CordisX project license.

`@cordisx/schemastery-ui` is not a plugin-facing DOM SDK. Third-party plugins
declare only supported schema and presentation metadata; the Host owns DOM,
TDesign controls, accessibility, validation, draft transactions, theming,
fallbacks, and disposal.
