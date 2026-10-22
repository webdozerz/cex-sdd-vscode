import { execFile } from 'node:child_process'

import { AI_REVIEW_LABEL, type IPrInfo } from './core/aireview'
import { createTtlCache } from './core/cache'
import type { IGitProbe } from './core/model'
import { parseTempMarkers } from './core/plan'
import { specSubmodulePath } from './core/repoinfo'
import type { ISpecsSync } from './core/specsync'
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

/** git fetch сабмодуля спек — сетевой вызов: не чаще раза в 10 минут, «Обновить» и кнопки спек сбрасывают. */
const SPECS_FETCH_TTL_MS = 600_000
const specsFetchCache = createTtlCache<boolean>(SPECS_FETCH_TTL_MS)

export function clearSpecsFetchCache(): void {
  specsFetchCache.clear()
}

async function isAncestor(root: string, submodule: string, older: string, newer: string): Promise<boolean> {
  return gitRead(root, ['-C', submodule, 'merge-base', '--is-ancestor', older, newer]).then(
    () => true,
    () => false,
  )
}

/** Состояние сабмодуля спек: рабочая копия против закреплённого commit и закреплённый против main OpenSpec. */
export async function inspectSpecsSync(root: string, change: string | null): Promise<ISpecsSync | null> {
  const submodule = specSubmodulePath(root)
  try {
    // «160000 commit <sha>\t<путь>»: commit сабмодуля, закреплённый в HEAD кодового репо.
    const pinned = (await gitRead(root, ['ls-tree', 'HEAD', submodule])).trim().split(/\s+/)[2]
    const working = (await gitRead(root, ['-C', submodule, 'rev-parse', 'HEAD'])).trim()
    if (!pinned) return null
    let state: ISpecsSync['working'] = 'same'
    if (working !== pinned) {
      // Закреплённого commit нет в сабмодуле — его ещё не скачали: рабочая копия отстаёт.
      const known = await gitRead(root, ['-C', submodule, 'cat-file', '-e', `${pinned}^{commit}`]).then(() => true, () => false)
      if (!known || (await isAncestor(root, submodule, working, pinned))) state = 'behind'
      else state = (await isAncestor(root, submodule, pinned, working)) ? 'ahead' : 'diverged'
    }
    await specsFetchCache.get(root, () =>
      git(root, ['-C', submodule, 'fetch', '--quiet', 'origin', 'main']).then(() => true, () => false),
    )
    const latest = (await gitRead(root, ['-C', submodule, 'rev-parse', '--verify', '--quiet', 'origin/main']).catch(() => '')).trim()
    if (!latest) return { working: state, changeUpdated: null, pinnedBehind: null }
    const pinnedBehind = latest !== pinned && (await isAncestor(root, submodule, pinned, latest))
    const changed = change
      ? (await gitRead(root, ['-C', submodule, 'diff', '--name-only', pinned, latest, '--', `openspec/changes/${change}`])).trim()
      : ''
    return { working: state, changeUpdated: pinnedBehind && changed.length > 0, pinnedBehind }
  } catch {
    return null
  }
}

/** PR текущей ветки: статус AI-ревью меняется за минуты, поэтому кэш короче. */
const CURRENT_PR_TTL_MS = 60_000
const currentPrCache = createTtlCache<IPrInfo | null>(CURRENT_PR_TTL_MS)

/** Сброс кэша PR: кнопка «Обновить» должна показывать свежее состояние. */
export function clearPrCache(): void {
  prCache.clear()
  currentPrCache.clear()
}

interface IGhPr {
  number: number
  url: string
  isDraft: boolean
  state: IPrInfo['state']
  statusCheckRollup?: Array<{ workflowName?: string; status?: string; conclusion?: string; detailsUrl?: string }>
  comments?: Array<{ author?: { login?: string }; url?: string }>
}

/** PR ветки через gh; null — PR нет, gh не установлен или нет доступа. */
async function fetchCurrentPr(root: string, branch: string): Promise<IPrInfo | null> {
  try {
    const output = await run('gh', root, ['pr', 'view', branch, '--json', 'number,url,isDraft,state,statusCheckRollup,comments'])
    const pr = JSON.parse(output) as IGhPr
    return {
      number: pr.number,
      url: pr.url,
      isDraft: pr.isDraft,
      state: pr.state,
      checks: (pr.statusCheckRollup ?? []).map((check) => ({
        workflowName: check.workflowName ?? '',
        status: check.status ?? '',
        conclusion: check.conclusion ?? '',
        detailsUrl: check.detailsUrl ?? '',
      })),
      comments: (pr.comments ?? []).map((comment) => ({ author: comment.author?.login ?? '', url: comment.url ?? '' })),
    }
  } catch {
    return null
  }
}

/**
 * Перезапуск AI-ревью: метка ai-review ставится заново — workflow срабатывает на событие labeled,
 * а повторная установка уже стоящей метки события не даёт.
 */
export async function restartAiReview(root: string, pr: number): Promise<void> {
  await run('gh', root, ['pr', 'edit', String(pr), '--remove-label', AI_REVIEW_LABEL]).catch(() => '')
  await run('gh', root, ['pr', 'edit', String(pr), '--add-label', AI_REVIEW_LABEL])
  currentPrCache.clear()
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
      '--json', 'number,state,headRefName,baseRefName,body',
    ])
    const prs = JSON.parse(output) as Array<{
      number: number
      state: IPrSteps['state']
      headRefName: string
      baseRefName: string
      body: string
    }>
    return prs.map((pr) => ({
      number: pr.number,
      state: pr.state,
      branch: pr.headRefName,
      base: pr.baseRefName,
      steps: parsePrSteps(pr.body ?? ''),
    }))
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
      const branches: Array<{ name: string; text: string; below: boolean; ahead: number }> = []
      if (key) {
        const refs = await gitRead(root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin']).catch(() => '')
        const wanted = key.toUpperCase()
        const own = currentBranch ? `origin/${currentBranch}` : null
        for (const ref of refs.split('\n').map((line) => line.trim())) {
          if (!ref || ref === own || ref === 'origin/develop' || ref.endsWith('/HEAD')) continue
          if (!ref.toUpperCase().includes(wanted)) continue
          const text = await show(ref)
          if (text === null) continue
          // Стек веток: текущая ветка стоит на этой, а в develop её ещё нет — галочки унаследованы, шаги сделаны ниже по стеку.
          const isAncestor = (of: string): Promise<boolean> =>
            gitRead(root, ['merge-base', '--is-ancestor', ref, of]).then(() => true, () => false)
          const below = (await isAncestor('HEAD')) && !(await isAncestor('origin/develop'))
          const ahead = Number((await gitRead(root, ['rev-list', '--count', `origin/develop..${ref}`]).catch(() => '0')).trim()) || 0
          branches.push({ name: ref.replace(/^origin\//, ''), text, below, ahead })
        }
      }
      // Снизу вверх: чем меньше коммитов поверх develop, тем ниже ветка в стеке.
      branches.sort((a, b) => a.ahead - b.ahead)
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

    specsSync(change) {
      return inspectSpecsSync(root, change)
    },

    currentPr(branch) {
      return currentPrCache.get(`${root}\0${branch}`, () => fetchCurrentPr(root, branch))
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
