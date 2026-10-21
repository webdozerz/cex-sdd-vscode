/** Workflow «проход 0» в кодовых репо: `.github/workflows/ai-review.yml`, запуск — открытие PR или метка ai-review. */
export const AI_REVIEW_WORKFLOW_FILE = '.github/workflows/ai-review.yml'
export const AI_REVIEW_WORKFLOW = 'AI review'
export const AI_REVIEW_LABEL = 'ai-review'

/** PR текущей ветки по `gh pr view --json number,url,isDraft,state,statusCheckRollup,comments`. */
export interface IPrInfo {
  number: number
  url: string
  isDraft: boolean
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  checks: Array<{ workflowName: string; status: string; conclusion: string; detailsUrl: string }>
  comments: Array<{ author: string; url: string }>
}

/**
 * draft — PR черновик, ревью запустится после Ready for review; running — идёт прогон; done — есть комментарий Claude;
 * no-comment — прогон прошёл без комментария (обычно не задан секрет Claude); failed — прогон упал;
 * not-run — прогона не было (PR открыт до появления workflow) или последний прогон пропущен.
 */
export type TAiReviewState = 'draft' | 'running' | 'done' | 'no-comment' | 'failed' | 'not-run'

export interface IAiReview {
  pr: number
  prUrl: string
  state: TAiReviewState
  /** Комментарий ревью или лог прогона. */
  url: string | null
}

/** CANCELLED не ошибка: прогон отменяет более новый (concurrency в workflow). */
const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE'])
const CLAUDE_AUTHOR_RE = /claude/i

/**
 * Состояние AI-ревью открытого PR; null — PR нет или он закрыт.
 * Метка, отличная от ai-review, тоже создаёт прогон — пропущенный, и он становится последним в списке проверок.
 * Поэтому готовое ревью определяется по комментарию Claude, а не по итогу проверки.
 */
export function aiReviewStatus(pr: IPrInfo | null): IAiReview | null {
  if (!pr || pr.state !== 'OPEN') return null
  const base = { pr: pr.number, prUrl: pr.url }
  if (pr.isDraft) return { ...base, state: 'draft', url: null }
  const check = pr.checks.find((item) => item.workflowName === AI_REVIEW_WORKFLOW)
  if (check && check.status !== 'COMPLETED') return { ...base, state: 'running', url: check.detailsUrl || null }
  const comment = [...pr.comments].reverse().find((item) => CLAUDE_AUTHOR_RE.test(item.author))
  if (comment) return { ...base, state: 'done', url: comment.url }
  if (check && FAILED.has(check.conclusion)) return { ...base, state: 'failed', url: check.detailsUrl || null }
  if (check && check.conclusion === 'SUCCESS') return { ...base, state: 'no-comment', url: check.detailsUrl || null }
  return { ...base, state: 'not-run', url: null }
}
