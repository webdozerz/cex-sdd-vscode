import { afterEach, describe, expect, it } from 'vitest'

import { loadFlowModel, type IGitProbe } from '../src/core/model'
import { parsePlan } from '../src/core/plan'
import { mergePlan, stepKey } from '../src/core/planmerge'

import { CHANGE, DESIGN, SPEC_FILES, cleanupProjects, makeProject } from './fixtures'

afterEach(cleanupProjects)

/** Как типичный plan.md TN-1485: разделы без tasks.md, шаг дизайна, жирные названия шагов. */
const plan = (checks: { design?: boolean; base?: boolean; modals?: boolean; screen?: boolean } = {}): string => `# План

## 0. Дизайн

- [${checks.design ? 'x' : ' '}] \`design.md\`, \`plan.md\`, \`spec-gaps.md\` — PR \`TN-1485: design\` — проверка: ревью

## Общее (для 2.1–2.3)

- [${checks.base ? 'x' : ' '}] **Основа раздела.** Сервис и роуты — проверка: \`pnpm verify\`
- [${checks.modals ? 'x' : ' '}] **Общие модалки.** Опции \`reasonMinLength\` — проверка: \`vitest run\`

## tasks.md 2.3 — Экран «Внешние биржи»

- [${checks.screen ? 'x' : ' '}] \`QLiquidityVenues.vue\` — проверка: unit
`

describe('parsePlan: разделы', () => {
  it('разделы без tasks.md называются по заголовку, а не «Без привязки»', () => {
    expect(parsePlan(plan()).tasks.map((task) => [task.id, task.title])).toEqual([
      ['', '0. Дизайн'],
      ['', 'Общее (для 2.1–2.3)'],
      ['2.3', 'Экран «Внешние биржи»'],
    ])
  })
})

describe('stepKey', () => {
  it('сравнивает шаги без разметки и без проверки', () => {
    expect(stepKey('**Основа раздела.** Сервис — проверка: `pnpm verify`')).toBe('основа раздела. сервис')
    expect(stepKey('**Основа раздела.** Сервис — проверка: другое')).toBe(stepKey('Основа раздела. Сервис'))
  })
})

describe('mergePlan', () => {
  it('новая ветка от develop: шаги из других веток не «сбрасываются»', () => {
    const merged = mergePlan(
      parsePlan(plan()),
      { develop: plan(), branches: [{ name: 'feat/TN-1485-liquidity-base', text: plan({ design: true, base: true }) }] },
      true,
    )
    const states = merged.tasks.flatMap((task) => task.steps.map((step) => [step.state, step.branch ?? null]))
    expect(states).toEqual([
      ['merged', null], // дизайн смержен, хоть галочку и не поставили
      ['review', 'feat/TN-1485-liquidity-base'],
      ['todo', null],
      ['todo', null],
    ])
    expect(merged.done).toBe(2)
  })

  it('отмеченное в develop — merged, отмеченное здесь — local', () => {
    const merged = mergePlan(parsePlan(plan({ base: true, modals: true })), { develop: plan({ base: true }), branches: [] }, null)
    const states = merged.tasks.flatMap((task) => task.steps.map((step) => step.state))
    expect(states).toEqual(['todo', 'merged', 'local', 'todo'])
  })
})

describe('mergePlan: шаг переформулирован в своей ветке', () => {
  it('находит его по разделу и позиции', () => {
    const renamed = plan({ base: true }).replace('**Основа раздела.** Сервис и роуты', '**API-слой и права.** Сервис')
    const merged = mergePlan(parsePlan(plan()), { develop: plan(), branches: [{ name: 'feat/x', text: renamed }] }, null)
    expect(merged.tasks[1].steps[0]).toMatchObject({ state: 'review', branch: 'feat/x' })
    expect(merged.tasks[1].steps[1].state).toBe('todo')
  })
})

describe('план в ленте с несколькими ветками', () => {
  it('прогресс, «ждут мержа» и следующий свободный шаг', async () => {
    const probe: IGitProbe = {
      branchChanges: async () => [],
      isDesignMerged: async () => true,
      planSources: async () => ({
        develop: plan(),
        branches: [{ name: 'feat/TN-130-liquidity-base', text: plan({ design: true, base: true }) }],
      }),
    }
    const model = await loadFlowModel({
      root: makeProject({ ...SPEC_FILES, [`${DESIGN}/design.md`]: '# Design', [`${DESIGN}/plan.md`]: plan() }),
      branch: 'feat/TN-130-modal-test-ids',
      remoteUrl: null,
      repoSetting: 'client-fe',
      overrideChange: null,
      git: probe,
    })
    if (model.kind !== 'change') throw new Error('ожидался change')
    expect(model.plan).toMatchObject({ done: 2, total: 4, merged: 1, review: 1, local: 0 })
    expect(model.plan?.inReview).toEqual([{ branch: 'feat/TN-130-liquidity-base', steps: 1 }])
    expect(model.next).toContain('Следующий свободный шаг плана: **Общие модалки.**')
    expect(CHANGE).toBeTruthy()
  })
})
