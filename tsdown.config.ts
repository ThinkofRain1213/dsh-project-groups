/**
 * Standalone tsdown config for dsh-project-groups.
 *
 * Emits the node half (`lib/index.js`) and the browser client bundle
 * (`lib/client.js`, a closure-factory artifact calling
 * `window.__ModuleLoader__.load({ id, factory })`).
 *
 * The client entry is the vendored official sidebar browser. See
 * `src/vendored/README.md` for provenance and `tsdown.specifiers.mjs` for how
 * its imports are classified.
 *
 * Two build-time rules matter and both mirror upstream's own client preset:
 *
 *  - shell-provided platform modules stay `require()`d, so React and the slot
 *    registry are shared rather than duplicated;
 *  - CSS Modules are compiled inside the bundle (lightningcss) and inject one
 *    tagged `<style>` at factory execution, so class hashing is deterministic
 *    and the emitted file set stays exactly `lib/*.js` + `lib/*.css`-free.
 *
 * Virtual ids are repo-relative so neither the emitted region banner nor a CSS
 * class hash can embed the build machine's checkout path (which would break
 * byte-stable rebuilds across machines).
 */
import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { transform } from 'lightningcss'
import ts from 'typescript'

/**
 * Lower standard decorators before bundling.
 *
 * `@Remote` is TypeScript syntax, and neither tsdown's TypeScript reader nor
 * rolldown erases it — the decorator is emitted verbatim into `lib/index.js`,
 * which Node then rejects with "Invalid or unexpected token". Upstream hits the
 * same thing and solves it the same way: its `dsh-typert-generator` tsdown
 * plugin's first job is this exact `transpileModule` pass
 * (`packages/typert/generator/src/tsdown-plugin.ts`).
 *
 * Only files that actually carry a decorator are touched, so the rest of the
 * build keeps its existing pipeline.
 */
/**
 * A decorator at the start of a line.
 *
 * Anchored and shaped rather than the bare `/^\s*@/` this used to be, which also matched prose:
 * a line beginning `@word` inside a block comment, or inside a multi-line template literal. The
 * cost of such a false hit is only one extra `transpileModule` pass, so the pattern stays
 * permissive on purpose — requiring the call parentheses would miss a bare `@Injectable` and
 * change a cheap false positive into a missed file.
 *
 * (`\s` became `[ \t]` for the same reason: `\s` matches the newline, so `^\s*@` could match an
 * `@` on a line of its own after a blank one.)
 */
const DECORATOR_SYNTAX = /^[ \t]*@[A-Za-z_$][\w$]*[ \t]*(?:\(|$)/m

const decorators = {
  name: 'dsh-project-groups-decorators',
  transform(code, id) {
    const file = id.split('?', 1)[0] ?? id
    if (!/\.[cm]?tsx?$/.test(file) || !DECORATOR_SYNTAX.test(code)) return
    const result = ts.transpileModule(code, {
      fileName: file,
      compilerOptions: {
        target: ts.ScriptTarget.ES2024,
        module: ts.ModuleKind.ESNext,
        // An explicit extension test, not `file.endsWith('x')`. That worked only because the
        // guard above happens to restrict ids to `.ts`/`.tsx`/`.cts`/`.mts`, so it read as a
        // coincidence rather than a rule and would have flipped `jsx` for an unrelated file the
        // moment the guard changed.
        ...(/\.(?:[cm]?tsx)$/.test(file) ? { jsx: ts.JsxEmit.ReactJSX } : {}),
      },
    })
    // `transpileModule` with no `sourceMap` option emits no `//# sourceMappingURL=` line —
    // measured, not assumed — so the strip regex that used to be here was dead code. It was
    // also the one thing in this file that could corrupt input: its `$` anchor still matched a
    // template literal whose final line read like a source-map comment. Removed rather than
    // left as defensive-looking noise.
    return { code: result.outputText, map: undefined }
  },
}

/**
 * Specifiers the shell's module table answers; these stay `require()`d so React
 * and the slot registry are shared rather than duplicated. Mirrors upstream's
 * `PLATFORM_MODULES`.
 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/**
 * Wire and pure-fold layers safe to inline: no Symbol identity, no singleton
 * state, no `instanceof` contract shared with another bundle. This is what
 * upstream's own client bundle does with them.
 */
const INLINE_SAFE = /^(?:@deepseek-ai\/dsh-(?:util-values|util-workspace-path|session)(?:\/|$)|@deepseek-ai\/dsh-api-workspace-controller\/default-workspace$)/

/**
 * Packages a plugin bundle may only ever import for their types: the controller
 * clients, the view and type layers, and the subpath client faces of peer
 * plugins. The vendored source imports them with `import type` exclusively, so
 * they are erased before the purity gate sees them; listing them keeps a future
 * value import from being mistaken for a safe inline.
 */
const TYPE_ONLY = /^@deepseek-ai\/(?:dsh-api-|dsh-client-ui-(?:renderer|layout|session|sidebar|conversation)|dsh-client-locale|dsh-client-shortcuts|dsh-schedule|dsh-subagent|dsh-jobs|dsh-agent)(?:\/|$)/

/**
 * Classify one import specifier for the bundler.
 *
 * No `'external'` result: the caller decides externals before it gets here, in one place that
 * also covers the non-scoped platform modules (`react`, `react-dom`) which the
 * `@deepseek-ai/` guard below would have rejected. Returning `'external'` from here was dead
 * code — every `PLATFORM_MODULES` entry was already answered above — and a second, unreachable
 * path for one decision is how the two drift apart.
 *
 * `'typeOnly'` is its own outcome rather than folded into `'inline'`. Listing these packages
 * exists so a future **value** import of one is refused; returning the safe-inline value meant
 * such an import would have been bundled silently, which is the opposite of the intent.
 * @param specifier - the import specifier.
 * @returns how the bundler should treat it.
 */
function classifySpecifier(specifier: string): 'inline' | 'typeOnly' | 'unresolved' {
  if (TYPE_ONLY.test(specifier)) return 'typeOnly'
  if (INLINE_SAFE.test(specifier)) return 'inline'
  return 'unresolved'
}

/** This plugin's package name; the id the loader keys the bundle under. */
const PACKAGE_NAME = 'dsh-project-groups'

/**
 * The mode used for **both** the `define` substitutions and the resolver's `conditionNames`.
 *
 * These used to be computed independently: `conditionNames` normalized anything that was not
 * `'development'` to `'production'`, while `define` baked the raw `process.env.NODE_ENV` in. A
 * build with `NODE_ENV=test` therefore resolved React's **production** entry points while the
 * injected constant still said `'test'`, so any library branching on
 * `process.env.NODE_ENV !== 'production'` took its development path against production code —
 * a mismatch with no error and no obvious symptom. One value, so they cannot diverge.
 */
const MODE = process.env.NODE_ENV === 'development' ? 'development' : 'production'

/** Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline. */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Repo-relative, forward-slashed identity for a stylesheet. */
const cssIdentity = absolutePath => relative(process.cwd(), absolutePath).split(sep).join('/')

const client = {
  name: `${PACKAGE_NAME}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  // Browser bundles inline node-idiom deps (zustand/immer read
  // process.env.NODE_ENV; zustand's esm build also probes import.meta.env.MODE,
  // which a CJS output cannot carry). Substituting both keeps the factory from
  // throwing at boot.
  define: {
    'process.env.NODE_ENV': JSON.stringify(MODE),
    'import.meta.env.MODE': JSON.stringify(MODE),
    'import.meta.env': JSON.stringify({ MODE }),
  },
  inputOptions: {
    resolve: {
      conditionNames: [MODE, 'browser', 'import', 'module', 'default'],
    },
  },
  plugins: [{
    // Build-time mirror of the module-edge rules: platform modules stay
    // external, wire/pure folds inline, and any other @deepseek-ai value import
    // is a build error rather than a silent duplicate runtime instance.
    name: 'dsh-client-bundle-purity',
    resolveId(source, importer) {
      if (importer === undefined) return null // entry: always internal
      // The shell module table is answered whatever the scope. React is the case
      // that matters: it is a devDependency here (the shell supplies 18.3.1) and
      // NOT a peer, so without this branch rolldown would inline a second React
      // into the bundle — the duplicate-instance failure the gate exists to catch.
      // `compare-bundle.mjs` asserts our externals still equal the official
      // bundle's, which keeps this branch honest.
      if (PLATFORM_MODULES.includes(source)) return { id: source, external: true }
      if (!source.startsWith('@deepseek-ai/')) return null
      switch (classifySpecifier(source)) {
        case 'inline':
          return null
        // Reachable only for a **value** import of a type-only package: `import type` is erased
        // before this plugin runs, so anything arriving here as a type-only target is a value
        // edge. Bundling it would create a second runtime instance of a controller whose Symbol
        // identity has to match the shell's, which is the failure this gate exists to prevent —
        // so it is an error, exactly like an unrecognized package.
        case 'typeOnly':
          throw new Error(
            `client bundle purity: "${source}" is listed as a type-only target (TYPE_ONLY) but is `
            + 'imported as a value. Use `import type`, or — if a value import is genuinely needed — '
            + 'declare it a platform module so the shell answers it instead of bundling a duplicate.',
          )
        default:
          throw new Error(
            `client bundle purity: "${source}" is neither a shell platform module (PLATFORM_MODULES), `
            + 'an inline-safe wire/pure-fold layer, nor a type-only target. Declare it as a platform '
            + 'module, add it to INLINE_SAFE with a reason, or collaborate through cordis services.',
          )
      }
    },
  }, {
    name: 'dsh-css-modules-inline',
    resolveId(source, importer) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? resolve(dirname(importer), source) : source
      return CSS_VIRTUAL_PREFIX + cssIdentity(abs) + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const identity = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      const fileId = resolve(process.cwd(), identity)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      // The tag id is the **repo-relative identity**, not `basename(fileId)`.
      //
      // `basename` made two stylesheets with the same file name in different directories emit the
      // same `data-plugin-css` id, and the emitted guard then found the first tag and skipped
      // injecting the second — silently dropping its classes at runtime, with a correct-looking
      // build. `identity` is already computed above and is unique per file; the five stylesheets
      // in this tree happen not to collide today, so this was latent rather than live.
      const { code, exports: cssExports } = transform({
        // The repo-relative identity **prefixed with the package name**, not the bare identity.
        //
        // lightningcss derives the CSS Module hash from `filename` alone, and `identity` is
        // `relative(process.cwd(), abs)` — evaluated in each repository's own root. Two plugins
        // that both ship `src/client/settings-card.module.css` therefore produce the *same*
        // identity string, hence the same hash and byte-identical class names. Measured against
        // `dsh-auto-expand`: ten shared classes (`_section`, `_row`, `_rule`, `_stack`, …).
        //
        // The injected `tagId` carries the package name, but that only stops the two stylesheets
        // from overwriting each other — it does **not** scope their selectors. With both plugins
        // installed both sheets are live, so `.X_section` matches the other plugin's elements.
        // The live symptom: auto-expand's `.section > :first-child { margin-top: -12px }` landed
        // on this card's group headings, pulling each `h3` from 16px below the section top to 4px.
        //
        // Prefixing the package name gives the same file a different hash in each repository.
        // Only the hash is affected: `identity` still drives `resolve` and asset inlining.
        filename: `${PACKAGE_NAME}/${identity}`,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap = {}
      // Sorted for deterministic output: lightningcss does not guarantee key
      // order, and a nondeterministic map makes rebuild bytes unstable.
      for (const local of Object.keys(cssExports ?? {}).sort()) classMap[local] = cssExports[local].name
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(`${PACKAGE_NAME}/${identity}`)};`,
        'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
        '  const tag = document.createElement(\'style\');',
        `  tag.dataset.plugin = ${JSON.stringify(PACKAGE_NAME)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
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

/**
 * The host half: this plugin's own Remote namespace, its durable domain, and the
 * `@Remote` methods the Gateway discovers.
 *
 * Every harness package stays external. The running Host supplies them from its
 * own install — a bundled copy would be a second instance of `cordis` (its
 * service registry and `instanceof` checks are identity-based) and a second
 * `zod` (the domain validates records against the schemas this half declares).
 * `zod` is external for the same reason even though it is an ordinary library:
 * the storage backend parses what this half wrote, and both must share one
 * schema implementation.
 */
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
  plugins: [decorators],
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-typert-protocol',
    '@deepseek-ai/dsh-storage-domain',
    '@deepseek-ai/dsh-storage',
    'zod',
  ],
}

export default [node, client]
