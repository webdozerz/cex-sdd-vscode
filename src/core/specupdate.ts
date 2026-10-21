import type { TPlansLocation } from './types'

export interface ISpecUpdateInput {
  change: string
  /** Ключ задачи разработчика (подзадача). */
  key: string
  /** Ключ change из meta.yaml (родитель). */
  jira: string | null
  /** Расхождения с решением «обновить change» без ссылки на правку. */
  gaps: Array<{ n: string; title: string }>
  /** Задачи своей группы tasks.md, которые пора отметить. */
  tasks: string[]
  plansLocation: TPlansLocation
  /** Каталог spec-gaps.md и plan.md относительно корня проекта. */
  plansDir: string | null
}

/**
 * `/cex-sdd:spec-update <change>` и подсказка агенту, что расширение уже нашло. Сам порядок правки
 * (клон OpenSpec, одна правка на change, проверки, PR) — в скилле плагина cex-sdd 0.7.0.
 */
export function buildSpecUpdatePrompt(input: ISpecUpdateInput): string {
  const parts = [`/cex-sdd:spec-update ${input.change}`]
  if (input.key && input.jira && input.key.toUpperCase() !== input.jira.toUpperCase()) {
    parts.push(`Ключ моей задачи — ${input.key} (подзадача, родитель ${input.jira}).`)
  }
  if (input.gaps.length > 0) {
    parts.push(`Решения «обновить change» без правки: ${input.gaps.map((gap) => `№${gap.n} «${gap.title}»`).join(', ')}.`)
  }
  if (input.tasks.length > 0) {
    parts.push(`Шаги плана смержены, в tasks.md не отмечены задачи: ${input.tasks.join(', ')}.`)
  }
  if (input.plansLocation === 'spec' && input.plansDir) {
    parts.push(`План и spec-gaps.md ведутся в спеке: ${input.plansDir}/.`)
  }
  return parts.join(' ')
}
