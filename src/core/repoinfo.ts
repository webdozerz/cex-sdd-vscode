import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_SPEC_PATH = 'vendor/openspec'

/** Путь сабмодуля спек из .gitmodules: vendor/openspec во фронтах, third_party/openspec в exchange. */
export function specSubmodulePath(root: string): string {
  try {
    const text = readFileSync(join(root, '.gitmodules'), 'utf8')
    const match = text.match(/^\s*path\s*=\s*(\S*openspec\S*)\s*$/m)
    return match ? match[1] : DEFAULT_SPEC_PATH
  } catch {
    return DEFAULT_SPEC_PATH
  }
}

function packageScripts(root: string): Record<string, string> {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const scripts = (pkg as { scripts?: Record<string, string> }).scripts
    return scripts ?? {}
  } catch {
    return {}
  }
}

function runner(root: string): string {
  return existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm run'
}

/** Команда полной или быстрой проверки репозитория, null — не найдена. */
export function verifyCommand(root: string, fast: boolean): string | null {
  const scripts = packageScripts(root)
  const script = fast ? 'verify:fast' : 'verify'
  if (scripts[script]) return `${runner(root)} ${script}`
  if (!fast && existsSync(join(root, 'Makefile'))) return 'make verify'
  return null
}

/** Команда подключения сабмодуля спек: `pnpm specs`, `make specs` или голый git. */
export function initSpecsCommand(root: string): string {
  if (packageScripts(root).specs) return `${runner(root)} specs`
  return `git submodule update --init ${specSubmodulePath(root)}`
}

export function bumpSpecsCommand(root: string): string {
  return `git submodule update --remote ${specSubmodulePath(root)}`
}
