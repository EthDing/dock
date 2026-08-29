import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const output = join(root, '.release')
const stage = join(output, 'dock')
const archive = join(output, 'dock-linux.tar.gz')

await rm(output, { recursive: true, force: true })
run('pnpm', ['--filter', 'dock', 'deploy', '--legacy', '--prod', stage], root)
await mkdir(join(stage, 'bin'), { recursive: true })
await writeFile(
  join(stage, 'bin', 'dock'),
  `#!/bin/sh
set -eu
SCRIPT_PATH=$(readlink -f -- "$0")
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd)
exec node "$SCRIPT_DIR/../dist/cli.js" "$@"
`,
  'utf8',
)
await chmod(join(stage, 'bin', 'dock'), 0o755)
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
await writeFile(join(stage, 'VERSION'), `${pkg.version}\n`, 'utf8')
run('tar', ['-czf', archive, '-C', stage, '.'], root)
const digest = createHash('sha256')
  .update(await readFile(archive))
  .digest('hex')
await writeFile(join(output, 'dock-linux.tar.gz.sha256'), `${digest}  dock-linux.tar.gz\n`, 'utf8')
console.log(`Created ${archive}`)

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? 'unknown'}`)
}
