import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: projectRoot,
  base: './',
  publicDir: false,
  build: {
    target: 'chrome120',
    outDir: '{{outDir}}',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    cssCodeSplit: true,
    manifest: 'manifest.json',
    rollupOptions: {
      input: fileURLToPath(new URL('./{{sourceEntry}}', import.meta.url)),
      preserveEntrySignatures: 'strict',
      external: [
        /^cordisx\/(?:contracts|react(?:\/jsx-(?:dev-)?runtime)?|ui)$/,
        /^react(?:-dom)?(?:\/.*)?$/,
      ],
      output: {
        entryFileNames: 'module.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
