import { execFile } from 'node:child_process'

import { createTtlCache } from './core/cache'
import type { IGitProbe } from './core/model'
import { parseTempMarkers } from './core/plan'
import { specSubmodulePath } from './core/repoinfo'
import type { IPrSteps } from './core/types'

const GIT_TIMEOUT_MS = 10_000

/**
 * Фоновые чтения (статус для панели) не должны брать необязательные блокировки:
 * иначе `git status` на мгновение занимает index.lock и мешает git-командам разработчика и мастера.
 */
export function gitRead(root: string, args: string[]): Promise<string> {
  return git(root, ['--no-optional-locks', ...args])
}

export function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message))
      else resolve(stdout)
    })
  })
}

export interface ISpecsStatus {
  /** Закреплённый commit сабмодуля отстаёт от main OpenSpec. */
  behind: boolean
  /** В свежем main есть активные changes (обновление сабмодуля что-то даст). */
  latestHasChanges: boolean
}

/**
 * Сверка сабмодуля спек с main OpenSpec. Нужен `git fetch` в сабмодуле (сеть и доступ к репо);
 * null — определить не удалось.
 */
export async function inspectSpecs(root: string, submodulePath: string): Promise<ISpecsStatus | null> {
  try {
    await git(root, ['-C', submodulePath, 'fetch', 'origin', 'main'])
    const pinned = (await gitRead(root, ['-C', submodulePath, 'rev-parse', 'HEAD'])).trim()
    const latest = (await gitRead(root, ['-C', submodulePath, 'rev-parse', 'origin/main'])).trim()
    const listing = await gitRead(root, ['-C', submodulePath, 'ls-tree', '--name-only', 'origin/main', 'openspec/changes/'])
    const latestHasChanges = listing
      .split('\n')
      .map((path) => path.trim().replace(/^openspec\/changes\//, ''))
      .some((name) => name && name !== 'archive')
    return { behind: pinned !== latest, latestHasChanges }
  } catch {
    return null
  }
}

function run(command: string, root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message))
      else resolve(stdout)
    })
  })
}

const PR_STEPS_RE = /Шаги plan\.md:\s*([^\n]+)/i

/** Шаги plan.md из описания PR: «Шаги plan.md: base, modals» (id в обратных кавычках тоже допустимы). */
export function parsePrSteps(body: string): string[] {
  const line = body.match(PR_STEPS_RE)?.[1] ?? ''
  return line
    .replace(/`/g, '')
    .split(/[,;\s]+/)
    .map((id) => id.trim())
    .filter((id) => /^[\w.-]+$/.test(id))
}

/** Ответы gh живут 2 минуты: панель обновляется каждые 30 секунд и при фокусе окна, а PR меняются реже. */
const PR_CACHE_TTL_MS = 120_000
const prCache = createTtlCache<IPrSteps[] | null>(PR_CACHE_TTL_MS)

/** Сброс кэша PR: кнопка «Обновить» должна показывать свежее состояние. */
export function clearPrCache(): void {
  prCache.clear()
}

function listPrSteps(root: string, key: string): Promise<IPrSteps[] | null> {
  return prCache.get(`${root}\0${key.toUpperCase()}`, () => fetchPrSteps(root, key))
}

/** PR задачи через gh (репозиторий берётся из origin). null — gh не установлен или нет доступа. */
async function fetchPrSteps(root: string, key: string): Promise<IPrSteps[] | null> {
  try {
    const output = await run('gh', root, [
      'pr', 'list', '--state', 'all', '--limit', '100',
      '--search', `${key} in:title`,
      '--json', 'number,state,headRefName,body',
    ])
    const prs = JSON.parse(output) as Array<{ number: number; state: IPrSteps['state']; headRefName: string; body: string }>
    return prs.map((pr) => ({ number: pr.number, state: pr.state, branch: pr.headRefName, steps: parsePrSteps(pr.body ?? '') }))
  } catch {
    return null
  }
}

const CHANGE_FILE_RE = /^docs\/changes\/([^/]+)\//

function changeNames(paths: string[]): string[] {
  return paths.flatMap((path) => {
    const match = path.match(CHANGE_FILE_RE)
    return match ? [match[1]] : []
  })
}

/** `git status --porcelain`: два символа статуса, пробел, путь (возможно в кавычках). */
function porcelainPaths(output: string): string[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/^"|"$/g, ''))
}

/** Проба git для определения change по файлам ветки и состояния design PR. Ошибки git не роняют панель. */
export function createGitProbe(root: string): IGitProbe {
  return {
    async branchChanges() {
      const names: string[] = []
      try {
        const committed = await gitRead(root, ['diff', '--name-only', 'origin/develop...HEAD', '--', 'docs/changes'])
        names.push(...changeNames(committed.split('\n').filter(Boolean)))
      } catch {
        // нет origin/develop — остаётся рабочее дерево
      }
      try {
        const working = await gitRead(root, ['status', '--porcelain', '--', 'docs/changes'])
        names.push(...changeNames(porcelainPaths(working)))
      } catch {
        // не git-репозиторий
      }
      return [...new Set(names)]
    },

    async planSources(change, key, currentBranch, specPlanPath) {
      if (specPlanPath) {
        // План в спеке: база — main репозитория спек (после fetch сабмодуля), иначе закреплённый commit.
        // PR кодового репо по-прежнему отмечают шаги строкой «Шаги plan.md: …».
        const submodule = specSubmodulePath(root)
        // Путь внутри сабмодуля тот же, что через симлинк openspec/ в корне; в git — только прямые слэши.
        const inSpec = specPlanPath.replace(/\\/g, '/')
        const show = (ref: string): Promise<string | null> =>
          gitRead(root, ['-C', submodule, 'show', `${ref}:${inSpec}`]).catch(() => null)
        const base = (await show('origin/main')) ?? (await show('HEAD'))
        return { develop: base, branches: [], prs: key ? await listPrSteps(root, key) : null }
      }
      const path = `docs/changes/${change}/plan.md`
      const show = (ref: string): Promise<string | null> => gitRead(root, ['show', `${ref}:${path}`]).catch(() => null)
      const branches: Array<{ name: string; text: string }> = []
      if (key) {
        const refs = await gitRead(root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin']).catch(() => '')
        const wanted = key.toUpperCase()
        const own = currentBranch ? `origin/${currentBranch}` : null
        for (const ref of refs.split('\n').map((line) => line.trim())) {
          if (!ref || ref === own || ref === 'origin/develop' || ref.endsWith('/HEAD')) continue
          if (!ref.toUpperCase().includes(wanted)) continue
          const text = await show(ref)
          if (text !== null) branches.push({ name: ref.replace(/^origin\//, ''), text })
        }
      }
      return { develop: await show('origin/develop'), branches, prs: key ? await listPrSteps(root, key) : null }
    },

    async tempMarkers() {
      // Документация и сабмодуль спек не сканируются: там метка может встречаться как пример.
      const output = await gitRead(root, [
        'grep', '-n', '-I', '-E', 'sdd-temp\\(', '--', '.',
        ':(exclude)vendor', ':(exclude)third_party', ':(exclude)node_modules', ':(exclude,glob)**/*.md',
      ]).catch(() => '')
      return parseTempMarkers(output)
    },

    async isBranchActive() {
      const ahead = await gitRead(root, ['rev-list', '--count', 'origin/develop..HEAD']).catch(() => '0')
      if (Number(ahead.trim()) > 0) return true
      const changed = await gitRead(root, ['status', '--porcelain', '--untracked-files=no']).catch(() => '')
      return changed.trim().length > 0
    },

    async isDesignMerged(change) {
      try {
        const log = await gitRead(root, ['log', 'origin/develop', '--oneline', '-1', '--', `docs/changes/${change}/design.md`])
        return log.trim().length > 0
      } catch {
        return null
      }
    },
  }
}
