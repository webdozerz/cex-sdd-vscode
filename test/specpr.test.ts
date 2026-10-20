import { afterEach, describe, expect, it } from 'vitest'

import { loadFlowModel, type IGitProbe } from '../src/core/model'
import { buildSpecPrPrompt, type ISpecPrInput } from '../src/core/specpr'
import type { IChangeFlow } from '../src/core/types'

import { CHANGE, CHANGE_NAME, DESIGN, DESIGN_FILES, SPEC_FILES, cleanupProjects, makeProject } from './fixtures'

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
- **Правка спеки:** ui.md — окно в два шага
- **Решение:** <заполняет тимлид>
- **PR спеки:** —
`

describe('PR с правкой спеки', () => {
  it('открытое расхождение с правкой спеки: кнопка и подсказка в стоппере', async () => {
    const flow = await load({ ...SPEC_FILES, ...DESIGN_FILES, [`${DESIGN}/spec-gaps.md`]: GAPS_OPEN }, { designMerged: true })
    expect(flow.actions.map((action) => action.id)).toContain('spec-pr')
    expect(flow.specPrCandidates).toEqual([{ n: '1', title: 'Окно подтверждения' }])
    expect(flow.blockers.find((b) => b.id === 'spec-gap-1')?.hint).toContain('Можно предложить PR')
  })

  it('решено «обновить change», PR нет — предупреждение', async () => {
    const gaps = '## 1. Нет прав\n- **Решение:** обновить change, вариант 1\n'
    const flow = await load({ ...SPEC_FILES, ...DESIGN_FILES, [`${DESIGN}/spec-gaps.md`]: gaps }, { designMerged: true })
    expect(flow.blockers.map((b) => b.id)).toEqual(['spec-pr-missing-1'])
    expect(flow.actions.map((action) => action.id)).toContain('spec-pr')
  })

  it('PR уже есть или правка не нужна — кнопки нет', async () => {
    const gaps =
      '## 1. Нет прав\n- **Решение:** обновить change\n- **PR спеки:** #42\n\n## 2. Сохранение\n- **Правка спеки:** не нужна\n- **Решение:** <заполняет тимлид>\n'
    const flow = await load({ ...SPEC_FILES, ...DESIGN_FILES, [`${DESIGN}/spec-gaps.md`]: gaps }, { designMerged: true })
    expect(flow.actions.map((action) => action.id)).not.toContain('spec-pr')
    expect(flow.blockers.map((b) => b.id)).toEqual(['spec-gap-2'])
  })

  it('запрос: сабмодуль только читается, отдельный клон, push после подтверждения, ссылка в запись', () => {
    const input: ISpecPrInput = {
      change: CHANGE_NAME,
      key: 'TN-130',
      gap: { n: '1', title: 'Окно подтверждения' },
      gapsFile: `${DESIGN}/spec-gaps.md`,
      submodulePath: 'vendor/openspec',
      specRepoUrl: 'git@example.com:org/specs.git',
      plansLocation: 'code',
      repoId: 'client-fe',
      variant: '',
    }
    const prompt = buildSpecPrPrompt(input)
    expect(prompt).toContain(`с правкой change ${CHANGE_NAME} по расхождению №1`)
    expect(prompt).toContain('Сабмодуль vendor/openspec и симлинк openspec/ — только для чтения')
    expect(prompt).toContain('git clone git@example.com:org/specs.git')
    expect(prompt).toContain(`Ветка от свежего origin/main: ${CHANGE_NAME}-gap-1`)
    expect(prompt).toContain('npm run check, npm run lint:contracts')
    expect(prompt).toContain('только после моего подтверждения')
    expect(prompt).toContain(`в поле «PR спеки» записи №1 в ${DESIGN}/spec-gaps.md`)
    expect(prompt).not.toContain('/cex-sdd:')
  })

  it('запрос для плана в спеке: ссылка в журнал в спеке тем же PR', () => {
    const prompt = buildSpecPrPrompt({
      change: CHANGE_NAME,
      key: 'TN-130',
      gap: { n: '2', title: 'X' },
      gapsFile: `${PLANS}/spec-gaps.md`,
      submodulePath: 'vendor/openspec',
      specRepoUrl: null,
      plansLocation: 'spec',
      repoId: 'client-fe',
      variant: 'вариант 2',
    })
    expect(prompt).toContain('За основу возьми: вариант 2')
    expect(prompt).toContain(', plans/client-fe/')
    expect(prompt).toContain('plans/client-fe/spec-gaps.md — в том же PR')
    expect(prompt).toContain('адрес — в .gitmodules')
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
    expect(flow.blockers.find((b) => b.id === 'no-design')?.hint).toContain('отдельным PR в репозиторий спек')
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
