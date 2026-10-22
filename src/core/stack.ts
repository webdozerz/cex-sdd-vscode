import type { IPrSteps } from './types'

/** Ветка, в которую мержатся PR задачи. PR с другой базой — часть стека веток. */
export const BASE_BRANCH = 'develop'

export interface IStackItem {
  /** null — у ветки ещё нет PR (текущая ветка поверх верха стека). */
  pr: number | null
  branch: string
  current: boolean
}

export interface IStack {
  /** Снизу вверх: первая — PR в develop, каждая следующая — PR с базой предыдущей ветки. */
  items: IStackItem[]
  /** Открытые PR, нацеленные на ветку, PR которой уже смержен: их нужно перенацелить на develop. */
  retarget: Array<{ pr: number; base: string }>
}

/**
 * Стек веток задачи по открытым PR: цепочка от PR в develop вверх, где база каждого следующего — ветка предыдущего
 * (`/cex-sdd:apply` в режиме стека, правило `CLAUDE.md` репозитория). null — PR задачи идут каждый в develop.
 * belowCurrent — ветки задачи, на которых стоит текущая: если её PR ещё нет, она дописывается наверх стека.
 */
export function buildStack(prs: IPrSteps[] | null | undefined, currentBranch: string | null, belowCurrent: string[] = []): IStack | null {
  if (!prs) return null
  const open = prs.filter((pr) => pr.state === 'OPEN')
  const mergedHeads = new Set(prs.filter((pr) => pr.state === 'MERGED').map((pr) => pr.branch))
  const retarget = open.filter((pr) => mergedHeads.has(pr.base)).map((pr) => ({ pr: pr.number, base: pr.base }))
  const byBase = new Map(open.map((pr) => [pr.base, pr]))

  // Низ стека: открытый PR, на ветку которого нацелен другой PR, а сам он нацелен не на открытую ветку задачи.
  const openHeads = new Set(open.map((pr) => pr.branch))
  const bottom = open.find((pr) => byBase.has(pr.branch) && !openHeads.has(pr.base))
  if (!bottom) return retarget.length ? { items: [], retarget } : null

  const items: IStackItem[] = []
  const seen = new Set<string>()
  for (let pr: IPrSteps | undefined = bottom; pr && !seen.has(pr.branch); pr = byBase.get(pr.branch)) {
    seen.add(pr.branch)
    items.push({ pr: pr.number, branch: pr.branch, current: pr.branch === currentBranch })
  }
  const top = items[items.length - 1]
  if (currentBranch && !seen.has(currentBranch) && belowCurrent.includes(top.branch)) {
    items.push({ pr: null, branch: currentBranch, current: true })
  }
  return { items, retarget }
}
