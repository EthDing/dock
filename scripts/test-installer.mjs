import { chmod, copyFile, cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const release = join(root, '.release')
const temporary = await mkdtemp(join(tmpdir(), 'dock-installer-test-'))
const assets = join(temporary, 'assets')
const home = join(temporary, 'home')
await cp(release, assets, { recursive: true })
await chmod(join(root, 'install.sh'), 0o755)

const environment = {
  ...process.env,
  HOME: home,
  DOCK_DOWNLOAD_BASE_URL: `file://${assets}`,
  DOCK_INSTALL_DIR: join(home, 'share', 'dock'),
  DOCK_BIN_DIR: join(home, 'bin'),
}
run(join(root, 'install.sh'), [], environment)
const installed = spawnSync(join(home, 'bin', 'dock'), ['--version'], {
  encoding: 'utf8',
  env: environment,
})
if (installed.status !== 0 || installed.stdout.trim() !== '0.1.0')
  throw new Error(`Installed Dock did not run: ${installed.stderr}`)

await copyFile(join(release, 'dock-linux.tar.gz'), join(assets, 'dock-linux.tar.gz'))
await writeFile(join(assets, 'dock-linux.tar.gz.sha256'), `${'0'.repeat(64)}  dock-linux.tar.gz\n`)
const failed = spawnSync(join(root, 'install.sh'), [], { encoding: 'utf8', env: environment })
if (failed.status === 0) throw new Error('Installer accepted an invalid checksum')
if ((await readFile(join(home, 'share', 'dock', 'VERSION'), 'utf8')).trim() !== '0.1.0')
  throw new Error('Failed upgrade did not preserve the installed version')
console.log('Installer E2E passed')

function run(command, args, env) {
  const result = spawnSync(command, args, { encoding: 'utf8', env })
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`)
}
