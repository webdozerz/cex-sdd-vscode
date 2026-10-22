import { afterEach, describe, expect, it } from 'vitest'

import { loadFlowModel, type IGitProbe } from '../src/core/model'
import { countTempTableRows, parsePlan, parseTempMarkers } from '../src/core/plan'
import { mergePlan } from '../src/core/planmerge'
import type { IChangeFlow, IPrSteps, ITempMarker } from '../src/core/types'
import { parsePrSteps } from '../src/gitprobe'

import { DESIGN, SPEC_FILES, cleanupProjects, makeProject } from './fixtures'

afterEach(cleanupProjects)

const PLAN = `# План

## Общее

- [ ] <!-- step: base --> **Основа раздела.** Сервис — проверка: \`pnpm verify\`
- [ ] <!-- step: modals --> **Общие модалки.** — проверка: vitest

## Интеграция

- [ ] <!-- step: integration --> \`pnpm api:sync:dev\`, моки удалены — проверка: стенд
`

describe('id шагов и PR (решение 1В)', () => {
  it('id шага читается и убирается из текста', () => {
    const [step] = parsePlan(PLAN).tasks[0].steps
    expect(step.stepId).toBe('base')
    expect(step.text).toBe('**Основа раздела.** Сервис — проверка: `pnpm verify`')
  })

  it('шаги из описания PR', () => {
    expect(parsePrSteps('## Задача\nШаги plan.md: base, `modals`\n')).toEqual(['base', 'modals'])
    expect(parsePrSteps('без шагов')).toEqual([])
  })

  it('состояние шага берётся из PR, plan.md не правится', () => {
    const prs: IPrSteps[] = [
      { number: 370, state: 'MERGED', branch: 'feat/TN-1485-liquidity-base', base: 'develop', steps: ['base'] },
      { number: 371, state: 'OPEN', branch: 'feat/TN-1485-modal-test-ids', base: 'develop', steps: ['modals'] },
      { number: 360, state: 'CLOSED', branch: 'feat/TN-1485-old', base: 'develop', steps: ['integration'] },
    ]
    const other = mergePlan(parsePlan(PLAN), { develop: PLAN, branches: [], prs }, null, 'feat/TN-1485-venues')
    expect(other.tasks.flatMap((t) => t.steps.map((s) => [s.stepId, s.state, s.branch ?? null]))).toEqual([
      ['base', 'merged', null],
      ['modals', 'review', '#371 feat/TN-1485-modal-test-ids'],
      ['integration', 'todo', null], // закрытый без мержа PR не засчитывается
    ])
    const own = mergePlan(parsePlan(PLAN), { develop: PLAN, branches: [], prs }, null, 'feat/TN-1485-modal-test-ids')
    expect(own.tasks[0].steps[1].state).toBe('local')
  })

  it('без gh — прежний расчёт по галочкам', () => {
    const merged = mergePlan(parsePlan(PLAN), { develop: PLAN.replace('[ ] <!-- step: base', '[x] <!-- step: base'), branches: [], prs: null }, null)
    expect(merged.tasks[0].steps[0].state).toBe('merged')
  })
})

describe('временные исключения (решение 4А)', () => {
  it('таблица в design.md: строки без заголовка и разделителя', () => {
    const design = '# Design\n\n## Временные исключения\n\n| Что | Где |\n| --- | --- |\n| право | a.ts |\n| мок | b.ts |\n\n## Риски\n| x | y |\n'
    expect(countTempTableRows(design)).toBe(2)
    expect(countTempTableRows('# Design\n\n## Временные исключения\n\nНет.\n')).toBe(0)
    expect(countTempTableRows('# Design\n')).toBeNull()
  })

  it('метки из git grep для любого языка', () => {
    const output = [
      'src/a.ts:12:  // sdd-temp(TN-1485): право не проверяется до TN-1484',
      'internal/x.go:7:\t// sdd-temp(tn-1484): заглушка',
      'src/b.vue:3:<!-- sdd-temp(TN-1485): моки -->',
    ].join('\n')
    expect(parseTempMarkers(output)).toEqual([
      { file: 'src/a.ts', line: 12, key: 'TN-1485', text: 'право не проверяется до TN-1484' },
      { file: 'internal/x.go', line: 7, key: 'TN-1484', text: 'заглушка' },
      { file: 'src/b.vue', line: 3, key: 'TN-1485', text: 'моки' },
    ])
  })

  const load = async (plan: string, design: string, markers: ITempMarker[]): Promise<IChangeFlow> => {
    const probe: IGitProbe = {
      branchChanges: async () => [],
      isDesignMerged: async () => true,
      tempMarkers: async () => markers,
    }
    const model = await loadFlowModel({
      root: makeProject({ ...SPEC_FILES, [`${DESIGN}/design.md`]: design, [`${DESIGN}/plan.md`]: plan }),
      branch: 'feat/TN-130-x',
      remoteUrl: null,
      repoSetting: 'client-fe',
      overrideChange: null,
      git: probe,
    })
    if (model.kind !== 'change') throw new Error('ожидался change')
    return model
  }
  const marker = (key: string): ITempMarker => ({ file: 'src/a.ts', line: 3, key, text: 'право' })
  const TABLE = '# Design\n\n## Временные исключения\n\n| Что | Где |\n| --- | --- |\n| право | src/a.ts |\n'

  it('в работе — инфо со ссылкой на строку; чужие ключи не учитываются', async () => {
    const flow = await load(PLAN, TABLE, [marker('TN-130'), marker('TN-999')])
    expect(flow.tempMarkers).toHaveLength(1)
    expect(flow.blockers.find((b) => b.id === 'temp-exceptions')).toMatchObject({ severity: 'info', file: 'src/a.ts:3' })
    expect(flow.blockers.some((b) => b.id.startsWith('temp-table'))).toBe(false)
  })

  it('перед «Интеграцией» — ошибка и подсказка снять', async () => {
    const plan = PLAN.replace(/\[ \] <!-- step: (base|modals)/g, '[x] <!-- step: $1')
    const flow = await load(plan, TABLE, [marker('TN-130')])
    expect(flow.blockers[0]).toMatchObject({ id: 'temp-exceptions', severity: 'error' })
    expect(flow.next).toContain('Снять стоппер')
  })

  it('таблица и метки расходятся или таблицы нет', async () => {
    expect((await load(PLAN, TABLE, [])).blockers.map((b) => b.id)).toContain('temp-table-mismatch')
    expect((await load(PLAN, '# Design\n', [marker('TN-130')])).blockers.map((b) => b.id)).toContain('temp-table-missing')
  })
})

describe('текущий шаг ветки', () => {
  const plan = `# План

## 2.2 Изменения

- [x] **Рубильники.** — проверка: a
- [ ] **Форма лимитов.** Схема — проверка: b
- [ ] **Ещё шаг.** — проверка: c
`
  const load = async (branch: string, active: boolean, prsLocal = false): Promise<IChangeFlow> => {
    const probe: IGitProbe = {
      branchChanges: async () => [],
      isDesignMerged: async () => true,
      isBranchActive: async () => active,
      planSources: async () => ({
        develop: plan,
        branches: [],
        prs: null,
      }),
    }
    const files = {
      ...SPEC_FILES,
      [`${DESIGN}/design.md`]: '# Design',
      [`${DESIGN}/plan.md`]: prsLocal ? plan.replace('[ ] **Ещё', '[x] **Ещё') : plan,
    }
    const model = await loadFlowModel({ root: makeProject(files), branch, remoteUrl: null, repoSetting: 'client-fe', overrideChange: null, git: probe })
    if (model.kind !== 'change') throw new Error('ожидался change')
    return model
  }

  it('в ветке есть изменения → предположительно первый свободный шаг, «Дальше» — следующий за ним', async () => {
    const flow = await load('feat/TN-130-limits-form', true)
    expect(flow.currentStep).toEqual({ title: 'Форма лимитов', section: '2.2 Изменения', exact: false })
    expect(flow.next).toContain('Следующий шаг после текущего: **Ещё шаг.**')
    expect(flow.plan?.tasks[0].active).toBe(true)
  })

  it('шаг отмечен в этой ветке → точно он', async () => {
    const flow = await load('feat/TN-130-x', false, true)
    expect(flow.currentStep).toMatchObject({ title: 'Ещё шаг', exact: true })
  })

  it('ветка без изменений или design-ветка → текущего шага нет', async () => {
    expect((await load('feat/TN-130-x', false)).currentStep).toBeNull()
    expect((await load('feat/TN-130-x-design', true)).currentStep).toBeNull()
  })
})
