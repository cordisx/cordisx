# create-cordisx-plugin

Create a minimal trusted-local CordisX plugin project.

```bash
npm create cordisx-plugin@beta my-plugin
# or
npx create-cordisx-plugin@beta my-plugin
```

The `@beta` qualifier is required while npm `latest` remains the non-functional
`0.0.0` package-name reservation.

The generated project includes a version-1 manifest exported from its entry,
structured UI contribution, TypeScript build, manifest test, and
`cordisx dev --dry-run` script. It does not install to a marketplace, sign the
plugin, provide a permission sandbox, or promise hot reload.

The minimal generated entry has no route or page. Plugin authors who add them
must use closed route-v2/page-v3 documents with the matching `$schema` URI and
`schemaVersion`: separate localized `title` and `description` references on
both registrations, backed by real locale dictionaries. Page v3 omits the
legacy `localeNamespace` hint. Canonical ids, path, outlet, params, and chrome
remain untranslated machine fields.

The `create-cordisx-plugin` tool itself is licensed under
`AGPL-3.0-or-later`. Files under its marked `template` directory and projects
generated from them receive the included CordisX Independent Plugin Exception.
An independent plugin using only public, versioned CordisX plugin interfaces
may be commercial, sold, distributed through a marketplace, and licensed under
terms chosen by its author. The custom Exception is not a standard SPDX
exception and should receive legal review before stable.
