import { afterEach, describe, expect, it } from 'vitest'

import { loadFlowModel, type IGitProbe } from '../src/core/model'
import { parsePlan } from '../src/core/plan'
import { mergePlan, type IPlanSources } from '../src/core/planmerge'
import { buildStack } from '../src/core/stack'
import type { IChangeFlow, IPrSteps } from '../src/core/types'
import { renderBody } from '../src/ui/render'

import { DESIGN, SPEC_FILES, cleanupProjects, makeProject } from './fixtures'

afterEach(cleanupProjects)

const A = 'feat/TN-130-form'
const B = 'feat/TN-130-validation'
const C = 'feat/TN-130-errors'
const pr = (number: number, branch: string, base: string, state: IPrSteps['state'] = 'OPEN', steps: string[] = []): IPrSteps => ({
  number,
  state,
  branch,
  base,
  steps,
})

describe('buildStack', () => {
  it('цепочка открытых PR: нижний в develop, каждый следующий — с базой предыдущей ветки', () => {
    const stack = buildStack([pr(103, C, B), pr(101, A, 'develop'), pr(102, B, A)], B)
    expect(stack?.items).toEqual([
      { pr: 101, branch: A, current: false },
      { pr: 102, branch: B, current: true },
      { pr: 103, branch: C, current: false },
    ])
    expect(stack?.retarget).toEqual([])
  })

  it('текущая ветка без PR поверх верха стека дописывается наверх', () => {
    const stack = buildStack([pr(101, A, 'develop'), pr(102, B, A)], C, [A, B])
    expect(stack?.items.at(-1)).toEqual({ pr: null, branch: C, current: true })
  })

  it('все PR в develop — стека нет', () => {
    expect(buildStack([pr(101, A, 'develop'), pr(102, B, 'develop')], B)).toBeNull()
    expect(buildStack(null, B)).toBeNull()
  })

  it('нижний PR смержен, следующий всё ещё нацелен на его ветку — перенацелить', () => {
    const stack = buildStack([pr(101, A, 'develop', 'MERGED'), pr(102, B, A), pr(103, C, B)], C)
    expect(stack?.retarget).toEqual([{ pr: 102, base: A }])
    expect(stack?.items.map((item) => item.pr)).toEqual([102, 103])
  })
})

const PLAN = (checks: [boolean, boolean, boolean]): string =>
  `# План\n\n## tasks.md 2.1 — Форма\n- [${checks[0] ? 'x' : ' '}] Каркас формы — проверка: vitest\n- [${checks[1] ? 'x' : ' '}] Валидация — проверка: vitest\n\n## tasks.md 2.2 — Ошибки\n- [${checks[2] ? 'x' : ' '}] Тексты — проверка: e2e\n`

describe('mergePlan в стеке веток', () => {
  it('галочки, унаследованные от веток ниже, — «в PR» этих веток, а не «в этой ветке»', () => {
    const sources: IPlanSources = {
      develop: PLAN([false, false, false]),
      branches: [
        { name: A, text: PLAN([true, false, false]), below: true },
        { name: B, text: PLAN([true, true, false]), below: true },
      ],
    }
    const steps = mergePlan(parsePlan(PLAN([true, true, true])), sources, true, C).tasks.flatMap((task) => task.steps)
    expect(steps.map((step) => [step.state, step.branch])).toEqual([
      ['review', A],
      ['review', B],
      ['local', undefined],
    ])
  })

  it('без стека отмеченное здесь — «в этой ветке», как раньше', () => {
    const sources: IPlanSources = { develop: PLAN([false, false, false]), branches: [{ name: A, text: PLAN([true, false, false]) }] }
    const steps = mergePlan(parsePlan(PLAN([true, false, false])), sources, true, B).tasks.flatMap((task) => task.steps)
    expect(steps[0].state).toBe('local')
  })

  it('PR смержен в ветку стека, а не в develop, — шаг ещё не в develop', () => {
    const plan = parsePlan('# План\n\n## Общее\n- [ ] <!-- step: base --> Основа\n')
    const sources: IPlanSources = { develop: null, branches: [], prs: [pr(102, B, A, 'MERGED', ['base'])] }
    expect(mergePlan(plan, sources, true, C).tasks[0].steps[0]).toMatchObject({ state: 'review', branch: `#102 → ${A}` })
  })
})

describe('стек веток в панели', () => {
  async function load(): Promise<IChangeFlow> {
    const probe: IGitProbe = {
      branchChanges: async () => [],
      isDesignMerged: async () => true,
      isBranchActive: async () => true,
      planSources: async () => ({
        develop: PLAN([false, false, false]),
        branches: [{ name: A, text: PLAN([true, false, false]), below: true }],
        prs: [pr(101, A, 'develop'), pr(102, B, A)],
      }),
    }
    const model = await loadFlowModel({
      root: makeProject({ ...SPEC_FILES, [`${DESIGN}/design.md`]: '# Design\n', [`${DESIGN}/plan.md`]: PLAN([true, true, false]) }),
      branch: B,
      remoteUrl: 'git@example.com:org/client-frontend.git',
      repoSetting: 'auto',
      overrideChange: null,
      git: probe,
    })
    if (model.kind !== 'change') throw new Error(`ожидался change, получен ${model.kind}`)
    return model
  }

  it('PR нацелен на смерженную ветку — стоппер с командой перенацеливания', async () => {
    const probe: IGitProbe = {
      branchChanges: async () => [],
      isDesignMerged: async () => true,
      planSources: async () => ({ develop: null, branches: [], prs: [pr(101, A, 'develop', 'MERGED'), pr(102, B, A)] }),
    }
    const model = await loadFlowModel({
      root: makeProject({ ...SPEC_FILES, [`${DESIGN}/design.md`]: '# Design\n', [`${DESIGN}/plan.md`]: PLAN([true, true, false]) }),
      branch: B,
      remoteUrl: 'git@example.com:org/client-frontend.git',
      repoSetting: 'auto',
      overrideChange: null,
      git: probe,
    })
    const blocker = model.kind === 'change' ? model.blockers.find((b) => b.id === 'stack-retarget-102') : undefined
    expect(blocker?.title).toBe(`PR #102 нацелен на уже смерженную ветку ${A}`)
    expect(blocker?.todo).toContain('gh pr edit 102 --base develop')
  })

  it('стек, текущий шаг и «Дальше» — новая ветка от верха стека', async () => {
    const flow = await load()
    expect(flow.stack?.items.map((item) => [item.pr, item.current])).toEqual([
      [101, false],
      [102, true],
    ])
    expect(flow.currentStep?.title).toBe('Валидация')
    expect(flow.next).toBe(`Следующий шаг — новая ветка от этой ветки (верх стека), PR с базой ${B}: Тексты — проверка: e2e`)
    const html = renderBody(flow)
    expect(html).toContain('<h2>Стек веток</h2>')
    expect(html).toContain(`<code>${B}</code> · #102<span class="badge">эта ветка</span>`)
  })
})
