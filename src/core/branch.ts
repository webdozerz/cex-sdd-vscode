import { REPO_IDS, type TRepoId } from './types'

const ISSUE_KEY_RE = /\bSE-(\d+)\b/i

/** Ключ задачи из имени ветки: `feat/SE-130-limits-form` → `SE-130`. */
export function parseIssueKey(branch: string | null | undefined): string | null {
  const match = branch?.match(ISSUE_KEY_RE)
  return match ? `SE-${match[1]}` : null
}

/** Префикс имени change: `SE-123` → `se-123-`. */
export function changePrefix(key: string): string {
  return `${key.toLowerCase()}-`
}

/** `se-123-withdraw-limits` → `withdraw-limits`. */
export function slugFromChange(changeName: string): string {
  return changeName.replace(/^se-\d+-/i, '')
}

/**
 * Имя ветки по правилам процесса: `feat/SE-130-slug`; для design PR (tier 1–2) — с суффиксом `-design`.
 * Ключ — задача разработчика (подзадача), не обязательно родитель change.
 */
export function buildBranchName(key: string, slug: string, design: boolean): string {
  return `feat/${key.toUpperCase()}-${slug}${design ? '-design' : ''}`
}

export function isFixBranch(branch: string | null | undefined): boolean {
  return /^(fix|hotfix)\//.test(branch ?? '')
}

export function isRepoId(value: string): value is TRepoId {
  return (REPO_IDS as readonly string[]).includes(value)
}

/** Какой репозиторий из affected_areas — этот проект. Подсказка: адрес origin или имя папки. */
export function detectRepoId(hints: Array<string | null | undefined>): TRepoId | null {
  for (const hint of hints) {
    const text = hint?.toLowerCase()
    if (!text) continue
    if (text.includes('client-frontend') || text.includes('client-fe')) return 'client-fe'
    if (text.includes('admin-frontend') || text.includes('admin-fe')) return 'admin-fe'
    if (text.includes('qa-tests')) return 'qa-tests'
    if (/(^|[/:_-])exchange([._/-]|$)/.test(text)) return 'exchange'
  }
  return null
}
