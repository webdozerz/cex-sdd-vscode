import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const created: string[] = []

/** Временный корень проекта с файлами `{ 'относительный/путь': 'содержимое' }`. */
export function makeProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sdd-flow-'))
  created.push(root)
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

export function cleanupProjects(): void {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true })
}

export const CHANGE_NAME = 'tn-123-withdraw-limits'
export const CHANGE = `openspec/changes/${CHANGE_NAME}`
export const DESIGN = `docs/changes/${CHANGE_NAME}`

/** Спека change: tier 1, затронуты exchange и client-fe; у фронта своя подзадача TN-130. */
export const SPEC_FILES: Record<string, string> = {
  [`${CHANGE}/.openspec.yaml`]: 'schema: cex-sdd\naffected_areas:\n  - exchange\n  - client-fe\n',
  [`${CHANGE}/meta.yaml`]: 'jira: TN-123\ntier: 1\nbreaking: false\n',
  [`${CHANGE}/proposal.md`]: '# Proposal: Лимиты на вывод\n\n## Why\n',
  [`${CHANGE}/tasks.md`]:
    '# Tasks\n\n## 1. exchange (TN-131)\n\n- [ ] 1.1 API\n\n## 2. client-fe (TN-130)\n\n- [ ] 2.1 Форма\n- [ ] 2.2 Ошибки\n',
}

export const DESIGN_FILES: Record<string, string> = {
  [`${DESIGN}/design.md`]: '# Design\n',
  [`${DESIGN}/plan.md`]:
    '# План\n\n## tasks.md 2.1 — Форма\n- [x] Каркас формы — проверка: vitest\n- [ ] Валидация — проверка: vitest\n\n## tasks.md 2.2 — Ошибки\n- [ ] Тексты — проверка: e2e\n',
}

export const PLAN_DONE =
  '# План\n\n## tasks.md 2.1 — Форма — готово\n- [x] Каркас формы\n- [x] Валидация\n\n## tasks.md 2.2 — Ошибки — готово\n- [x] Тексты\n'
