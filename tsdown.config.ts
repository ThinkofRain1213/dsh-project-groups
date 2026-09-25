/**
 * Standalone tsdown config for dsh-project-groups. Emits the node-half library
 * (lib/index.js) and the browser client bundle (lib/client.js).
 *
 * The client bundle is a closure-factory artifact: it calls
 * window.__ModuleLoader__.load({ id, factory }) and resolves platform modules
 * through the loader module table. Everything not on that table is bundled.
 *
 * CSS is imported as a plain string via the virtual-module plugin below, which
 * injects one <style data-plugin-css="..."> tag at factory execution. The
 * virtual id is repo-relative so neither the emitted region banner nor any hash
 * embeds the build machine's checkout path.
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve, sep } from 'node:path'

const PACKAGE_NAME = 'dsh-project-groups'

/** Module specifiers the DSH shell shares into the frozen module table. */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/** Repo-relative, forward-slashed identity for a CSS file. */
const cssIdentity = (absolutePath) => relative(process.cwd(), absolutePath).split(sep).join('/')

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

const client = {
  name: `${PACKAGE_NAME}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...PLATFORM_MODULES],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  // Bundles everything not on the loader module table.
  noExternal: (id) => (PLATFORM_MODULES.includes(id) ? undefined : true),
  plugins: [{
    name: 'dsh-css-inline',
    resolveId(source, importer) {
      if (!source.endsWith('.css') && !source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? resolve(dirname(importer), source) : source
      return CSS_VIRTUAL_PREFIX + cssIdentity(abs) + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const identity = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      const fileId = resolve(process.cwd(), identity)
      this.addWatchFile(fileId)
      const css = (await readFile(fileId, 'utf8')).trim()
      return [
        `const css = ${JSON.stringify(css)};`,
        `const tagId = ${JSON.stringify(`${PACKAGE_NAME}/${basename(fileId)}`)};`,
        'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
        '  const tag = document.createElement(\'style\');',
        `  tag.dataset.plugin = ${JSON.stringify(PACKAGE_NAME)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        'export default css;',
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

/** The host half: registers the bundle row; no host-side behaviour at L0. */
const node = {
  name: PACKAGE_NAME,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
  fixedExtension: false,
  external: ['@deepseek-ai/cordis'],
}

export default [node, client]
