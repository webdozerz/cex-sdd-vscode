import { afterEach, describe, expect, it } from 'vitest'

import { loadFlowModel, type IGitProbe } from '../src/core/model'
import { buildSpecUpdatePrompt } from '../src/core/specupdate'
import type { IChangeFlow } from '../src/core/types'

import { CHANGE, CHANGE_NAME, DESIGN, DESIGN_FILES, PLAN_DONE, SPEC_FILES, cleanupProjects, makeProject } from './fixtures'

afterEach(cleanupProjects)

const PLANS = `${CHANGE}/plans/client-fe`

interface ILoadOptions {
  plansSetting?: string
  designMerged?: boolean | null
  planSources?: IGitProbe['planSources']
}

async function load(files: Record<string, string>, options: ILoadOptions = {}): Promise<IChangeFlow> {
  const probe: IGitProbe = {
    branchChanges: async () => [],
    isDesignMerged: async () => options.designMerged ?? null,
    ...(options.planSources ? { planSources: options.planSources } : {}),
  }
  const model = await loadFlowModel({
    root: makeProject(files),
    branch: 'feat/TN-130-limits-form',
    remoteUrl: 'git@example.com:org/client-frontend.git',
    repoSetting: 'auto',
    overrideChange: null,
    git: probe,
    ...(options.plansSetting ? { plansSetting: options.plansSetting } : {}),
  })
  if (model.kind !== 'change') throw new Error(`ожидался change, получен ${model.kind}`)
  return model
}

const GAPS_OPEN = `## 1. Окно подтверждения
- **Блокирует:** шаг 2.2
- **Решение:** <заполняет тимлид: обновить change / баг кода / вне рамок>
`

const ids = (flow: IChangeFlow): string[] => flow.blockers.map((blocker) => blocker.id)
const actionIds = (flow: IChangeFlow): string[] => flow.actions.map((action) => action.id)

describe('правка change в OpenSpec (/cex-sdd:spec-update)', () => {
  it('открытое расхождение: ждёт решения, кнопки нет', async () => {
    const flow = await load({ ...SPEC_FILES, ...DESIGN_FILES, [`${DESIGN}/spec-gaps.md`]: GAPS_OPEN }, { designMerged: true })
    expect(ids(flow)).toEqual(['spec-gap-1'])
    expect(flow.blockers[0].todo).toContain('Покажите запись тимлиду')
    expect(flow.blockers[0].action).toBeUndefined()
    expect(actionIds(flow)).not.toContain('spec-update')
    expect(flow.specUpdate).toEqual({ gaps: [], tasks: [] })
  })

  it('решено «обновить change», ссылки нет — предупреждение и кнопка', async () => {
    const gaps = '## 1. Нет прав\n- **Решение:** обновить change, вариант 1\n'
    const flow = await load({ ...SPEC_FILES, ...DESIGN_FILES, [`${DESIGN}/spec-gaps.md`]: gaps }, { designMerged: true })
    expect(ids(flow)).toEqual(['spec-update-missing-1'])
    expect(flow.blockers[0].todo).toContain('нажмите «Обновить change в OpenSpec»')
    expect(flow.blockers[0].todo).toContain('«→ OpenSpec #N»')
    expect(flow.blockers[0].action?.id).toBe('spec-update')
    expect(actionIds(flow)).toContain('spec-update')
    expect(flow.specUpdate.gaps).toEqual([{ n: '1', title: 'Нет прав' }])
  })

  it('«→ OpenSpec #N» в решении или старое поле «PR спеки» — правка есть, кнопки нет', async () => {
    const gaps =
      '## 1. Нет прав\n- **Решение:** обновить change → OpenSpec #57\n\n## 2. Окно\n- **Решение:** обновить change\n- **PR спеки:** https://github.com/CryptoExch/OpenSpec/pull/42\n'
    const flow = await load({ ...SPEC_FILES, ...DESIGN_FILES, [`${DESIGN}/spec-gaps.md`]: gaps }, { designMerged: true })
    expect(ids(flow)).toEqual([])
    expect(actionIds(flow)).not.toContain('spec-update')
  })

  const MERGED_SOURCES: IGitProbe['planSources'] = async () => ({
    develop: '# План\n\n## tasks.md 2.1 — Форма\n- [x] Каркас формы — проверка: vitest\n- [x] Валидация — проверка: vitest\n',
    branches: [],
    prs: null,
  })

  it('шаги раздела tasks.md 2.1 смержены, задача в спеке не отмечена — напоминание и кнопка', async () => {
    const flow = await load({ ...SPEC_FILES, ...DESIGN_FILES }, { designMerged: true, planSources: MERGED_SOURCES })
    expect(flow.specUpdate.tasks).toEqual(['2.1'])
    const blocker = flow.blockers.find((b) => b.id === 'tasks-unticked')
    expect(blocker).toMatchObject({ severity: 'info', title: 'Отметьте сданные задачи в OpenSpec: 2.1', action: { id: 'spec-update' } })
    expect(blocker?.todo).toContain('нажмите «Обновить change в OpenSpec»')
    // tasks.md в сабмодуле только читается: ссылка на него ничего не даёт.
    expect(blocker?.file).toBeUndefined()
    expect(actionIds(flow)).toContain('spec-update')
  })

  it('задача уже отмечена в tasks.md или шаги смержены не все — напоминания нет', async () => {
    const ticked = { ...SPEC_FILES, [`${CHANGE}/tasks.md`]: SPEC_FILES[`${CHANGE}/tasks.md`].replace('- [ ] 2.1', '- [x] 2.1') }
    expect((await load({ ...ticked, ...DESIGN_FILES }, { designMerged: true, planSources: MERGED_SOURCES })).specUpdate.tasks).toEqual([])
    expect((await load({ ...SPEC_FILES, ...DESIGN_FILES }, { designMerged: true })).specUpdate.tasks).toEqual([])
  })

  it('все шаги смержены — «Дальше» про отметку задач', async () => {
    const flow = await load(
      { ...SPEC_FILES, ...DESIGN_FILES },
      { designMerged: true, planSources: async () => ({ develop: PLAN_DONE, branches: [], prs: null }) },
    )
    expect(flow.specUpdate.tasks).toEqual(['2.1', '2.2'])
    expect(flow.next).toContain('Отметить сданные задачи в tasks.md OpenSpec (2.1, 2.2)')
  })
})

describe('buildSpecUpdatePrompt', () => {
  it('скилл, ключ подзадачи и что нашла панель', () => {
    expect(
      buildSpecUpdatePrompt({
        change: CHANGE_NAME,
        key: 'TN-130',
        jira: 'TN-123',
        gaps: [{ n: '1', title: 'Нет прав' }],
        tasks: ['2.1'],
        plansLocation: 'code',
        plansDir: DESIGN,
      }),
    ).toBe(
      `/cex-sdd:spec-update ${CHANGE_NAME} Ключ моей задачи — TN-130 (подзадача, родитель TN-123). Решения «обновить change» без правки: №1 «Нет прав». Шаги плана смержены, в tasks.md не отмечены задачи: 2.1.`,
    )
  })

  it('план в спеке — подсказка, где spec-gaps.md; ключ совпадает с родителем — без пояснения', () => {
    const prompt = buildSpecUpdatePrompt({
      change: CHANGE_NAME,
      key: 'TN-123',
      jira: 'TN-123',
      gaps: [],
      tasks: [],
      plansLocation: 'spec',
      plansDir: PLANS,
    })
    expect(prompt).toBe(`/cex-sdd:spec-update ${CHANGE_NAME} План и spec-gaps.md ведутся в спеке: ${PLANS}/.`)
  })
})

describe('план в репозитории спек', () => {
  const SPEC_PLAN_FILES: Record<string, string> = {
    [`${PLANS}/design.md`]: '# Design\n',
    [`${PLANS}/plan.md`]: '# План\n\n## tasks.md 2.1 — Форма\n- [x] Каркас — проверка: vitest\n- [ ] Валидация — проверка: vitest\n',
    [`${PLANS}/spec-gaps.md`]: GAPS_OPEN,
  }

  it('каталог plans/<репозиторий>/ у change — план читается из спеки, дизайн считается смерженным', async () => {
    const flow = await load({ ...SPEC_FILES, ...SPEC_PLAN_FILES }, { designMerged: false })
    expect(flow.plansLocation).toBe('spec')
    expect(flow.plansDir).toBe(PLANS)
    expect(flow.plan).toMatchObject({ done: 1, total: 2 })
    expect(flow.blockers.map((b) => b.id)).toEqual(['spec-gap-1'])
    expect(flow.blockers[0].file).toBe(`${PLANS}/spec-gaps.md`)
    expect(flow.steps.find((step) => step.id === 'design')?.status).toBe('done')
  })

  it('прогресс сводится с планом из main спек-репо', async () => {
    let asked: string | undefined
    const flow = await load(
      { ...SPEC_FILES, ...SPEC_PLAN_FILES },
      {
        planSources: async (_change, _key, _branch, specPlanPath) => {
          asked = specPlanPath
          return { develop: SPEC_PLAN_FILES[`${PLANS}/plan.md`].replace('- [ ] Валидация', '- [x] Валидация'), branches: [], prs: null }
        },
      },
    )
    expect(asked).toBe(`${PLANS}/plan.md`)
    expect(flow.plan).toMatchObject({ done: 2, merged: 2 })
  })

  it('.cex-sdd.yaml plans: spec без плана — подсказка про PR в спеку', async () => {
    const flow = await load({ ...SPEC_FILES, '.cex-sdd.yaml': 'plans: spec\n' })
    expect(flow.plansLocation).toBe('spec')
    expect(flow.blockers.find((b) => b.id === 'no-design')?.hint).toContain('уходят PR в репозиторий спек')
  })

  it('настройка plansLocation: code перекрывает каталог в спеке', async () => {
    const flow = await load({ ...SPEC_FILES, ...SPEC_PLAN_FILES, ...DESIGN_FILES }, { plansSetting: 'code', designMerged: true })
    expect(flow.plansLocation).toBe('code')
    expect(flow.plansDir).toBe(DESIGN)
  })

  it('без каталога и настроек — по-прежнему кодовый репо', async () => {
    const flow = await load({ ...SPEC_FILES, ...DESIGN_FILES }, { designMerged: true })
    expect(flow.plansLocation).toBe('code')
  })
})
