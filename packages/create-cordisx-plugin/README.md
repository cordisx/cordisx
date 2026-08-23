# create-cordisx-plugin

Create a minimal trusted-local CordisX plugin project.

```bash
npm create cordisx-plugin my-plugin
# or
npx create-cordisx-plugin my-plugin
```

The generated project includes a version-1 manifest exported from its entry,
structured UI contribution, TypeScript build, manifest test, and
`cordisx dev --dry-run` script. It does not install to a marketplace, sign the
plugin, provide a permission sandbox, or promise hot reload.
