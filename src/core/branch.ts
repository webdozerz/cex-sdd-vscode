import { REPO_IDS, type TRepoId } from './types'

/** Ключ задачи трекера: `TN-130` — проект из заглавных букв и цифр, дефис, номер. */
const ISSUE_KEY = '[A-Z][A-Z0-9]+-\\d+'

/** Ключ в начале имени ветки или сразу после `тип/`: `feat/TN-130-slug`. */
const ISSUE_KEY_RE = new RegExp(`(?:^|/)(${ISSUE_KEY})(?=$|[-_./])`)

/** Ключ задачи из имени ветки: `feat/TN-130-limits-form` → `TN-130`. */
export function parseIssueKey(branch: string | null | undefined): string | null {
  const match = branch?.match(ISSUE_KEY_RE)
  return match ? match[1] : null
}

/** Префикс имени change: `TN-123` → `tn-123-`. */
export function changePrefix(key: string): string {
  return `${key.toLowerCase()}-`
}

/** `tn-123-withdraw-limits` → `withdraw-limits`. */
export function slugFromChange(changeName: string): string {
  return changeName.replace(/^[a-z][a-z0-9]+-\d+-/i, '')
}

/**
 * Имя ветки по правилам процесса: `feat/TN-130-slug`; для design PR (tier 1–2) — с суффиксом `-design`.
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
