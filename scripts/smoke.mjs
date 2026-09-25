import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const host = await import(pathToFileURL(join(root, 'lib/index.js')).href)
console.log('host apply:', typeof host.apply)

const src = fs.readFileSync(join(root, 'lib/client.js'), 'utf8')
new vm.Script(src, { filename: 'client.js' })
console.log('client bundle: syntax OK')

const idMatch = src.match(/__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/)
console.log('loader id:', idMatch ? idMatch[1] : 'NOT FOUND')

// The bundle must target the platform table for react and inline everything else.
const requires = [...src.matchAll(/require\("([^"]+)"\)/g)].map(m => m[1])
console.log('externals required:', [...new Set(requires)].sort().join(', '))

const leaks = src.match(/C:\\Users/g)
console.log('checkout path leaks:', leaks ? leaks.length : 0)
const css = src.match(/dpg-root/g)
console.log('inlined css markers:', css ? css.length : 0)
