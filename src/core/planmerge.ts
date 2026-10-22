import { parsePlan } from './plan'
import { BASE_BRANCH } from './stack'
import type { IPlan, IPlanStep, IPrSteps, TPlanStepState } from './types'

/** plan.md этого change в develop и в других ветках задачи (каждый шаг плана — свой PR и своя ветка). */
export interface IPlanSources {
  develop: string | null
  /**
   * Другие ветки задачи, снизу вверх по стеку (меньше коммитов поверх develop — ниже).
   * below — текущая ветка стоит на этой (стек веток): отмеченное там сделано ниже по стеку, а не здесь.
   */
  branches: Array<{ name: string; text: string; below?: boolean }>
  /** PR задачи со списком шагов из описания; null — gh недоступен. */
  prs?: IPrSteps[] | null
}

/**
 * Состояние шага по PR, которые на него ссылаются («Шаги plan.md: base»). Главный источник для шагов с id:
 * PR не правит plan.md, поэтому конфликтов нет. undefined — ни один PR на шаг не ссылается.
 */
function stateFromPrs(
  stepId: string | undefined,
  prs: IPrSteps[] | null | undefined,
  currentBranch: string | null,
): { state: TPlanStepState; branch?: string } | undefined {
  if (!stepId || !prs) return undefined
  const related = prs.filter((pr) => pr.steps.includes(stepId))
  if (related.some((pr) => pr.state === 'MERGED' && pr.base === BASE_BRANCH)) return { state: 'merged' }
  // Смержен в ветку стека, а не в develop: шаг пока в PR ниже по стеку.
  const intoStack = related.find((pr) => pr.state === 'MERGED')
  if (intoStack) return { state: 'review', branch: `#${intoStack.number} → ${intoStack.base}` }
  const open = related.find((pr) => pr.state === 'OPEN')
  if (!open) return undefined
  return open.branch === currentBranch ? { state: 'local' } : { state: 'review', branch: `#${open.number} ${open.branch}` }
}

/** Ключ шага для сравнения между ветками: без разметки и без части «— проверка: …». */
export function stepKey(text: string): string {
  return text
    .split(/\s+[—–-]\s+проверка:/i)[0]
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 80)
}

/** Запасной ключ: раздел плана и номер шага в нём. Нужен, когда шаг переформулировали в своей ветке. */
function positionKey(sectionTitle: string, index: number): string {
  return `${stepKey(sectionTitle)}#${index}`
}

/** Ключи отмеченных шагов: по тексту и по позиции в разделе. */
function checkedKeys(markdown: string | null): { byText: Set<string>; byPosition: Set<string> } {
  const byText = new Set<string>()
  const byPosition = new Set<string>()
  if (markdown === null) return { byText, byPosition }
  for (const task of parsePlan(markdown).tasks) {
    task.steps.forEach((step, index) => {
      if (!step.done) return
      byText.add(stepKey(step.text))
      byPosition.add(positionKey(task.title, index))
    })
  }
  return { byText, byPosition }
}

/** Шаг «design.md + plan.md отдельным PR»: его галочку после мержа обычно никто не ставит. */
function isDesignStep(step: IPlanStep): boolean {
  return /design\.md/.test(step.text) && /plan\.md/.test(step.text)
}

/**
 * Сводит прогресс плана по всем веткам задачи. Галочка ставится в plan.md той ветки, где делается шаг,
 * поэтому в новой ветке от develop прогресс иначе выглядит как «сброшенный».
 */
export function mergePlan(
  local: IPlan,
  sources: IPlanSources,
  designMerged: boolean | null,
  currentBranch: string | null = null,
): IPlan {
  const merged = checkedKeys(sources.develop)
  // Сначала совпадение по тексту, потом по позиции: текстовое надёжнее, позиционное ловит переформулированный шаг.
  const inBranchesByText = new Map<string, string>()
  const inBranchesByPosition = new Map<string, string>()
  // Ветки ниже по стеку: текущая ветка унаследовала их plan.md вместе с галочками.
  const belowByText = new Map<string, string>()
  const belowByPosition = new Map<string, string>()
  for (const { name, text, below } of sources.branches) {
    const keys = checkedKeys(text)
    for (const key of keys.byText) {
      if (!inBranchesByText.has(key)) inBranchesByText.set(key, name)
      if (below && !belowByText.has(key)) belowByText.set(key, name)
    }
    for (const key of keys.byPosition) {
      if (!inBranchesByPosition.has(key)) inBranchesByPosition.set(key, name)
      if (below && !belowByPosition.has(key)) belowByPosition.set(key, name)
    }
  }

  const tasks = local.tasks.map((task) => ({
    ...task,
    steps: task.steps.map((step, index): IPlanStep => {
      const key = stepKey(step.text)
      const position = positionKey(task.title, index)
      const reviewBranch = inBranchesByText.get(key) ?? inBranchesByPosition.get(position)
      const belowBranch = belowByText.get(key) ?? belowByPosition.get(position)
      const fromPrs = stateFromPrs(step.stepId, sources.prs, currentBranch)
      if (fromPrs) {
        return { ...step, done: true, state: fromPrs.state, ...(fromPrs.branch ? { branch: fromPrs.branch } : {}) }
      }
      let state: TPlanStepState = 'todo'
      if (merged.byText.has(key) || merged.byPosition.has(position) || (isDesignStep(step) && designMerged === true)) {
        state = 'merged'
      } else if (step.done && belowBranch) state = 'review'
      else if (step.done) state = 'local'
      else if (reviewBranch) state = 'review'
      const branch = state === 'review' ? (belowBranch ?? reviewBranch) : undefined
      return { ...step, done: state !== 'todo', state, ...(branch ? { branch } : {}) }
    }),
  }))
  const steps = tasks.flatMap((task) => task.steps)
  return { tasks, total: steps.length, done: steps.filter((step) => step.done).length }
}
