import { afterEach, describe, expect, it } from 'vitest'

import { loadFlowModel, type IGitProbe } from '../src/core/model'
import type { IChangeFlow, TActionId, TStepId } from '../src/core/types'

import { CHANGE, CHANGE_NAME, DESIGN, DESIGN_FILES, PLAN_DONE, SPEC_FILES, cleanupProjects, makeProject } from './fixtures'

afterEach(cleanupProjects)

interface ILoadOptions {
  branch?: string
  override?: string | null
  branchChanges?: string[]
  designMerged?: boolean | null
}

async function load(files: Record<string, string>, options: ILoadOptions = {}): Promise<IChangeFlow> {
  const probe: IGitProbe = {
    branchChanges: async () => options.branchChanges ?? [],
    isDesignMerged: async () => options.designMerged ?? null,
  }
  const model = await loadFlowModel({
    root: makeProject(files),
    branch: options.branch ?? 'feat/TN-130-limits-form',
    remoteUrl: 'git@github.com:CryptoExch/client-frontend-v2.git',
    repoSetting: 'auto',
    overrideChange: options.override ?? null,
    git: probe,
  })
  if (model.kind !== 'change') throw new Error(`ожидался change, получен ${model.kind}`)
  return model
}

const statusOf = (flow: IChangeFlow, id: TStepId) => flow.steps.find((step) => step.id === id)?.status
const blockerIds = (flow: IChangeFlow) => flow.blockers.map((blocker) => blocker.id)
const actionIds = (flow: IChangeFlow): TActionId[] => flow.actions.map((action) => action.id)

describe('определение change по ветке', () => {
  it('ключ подзадачи из tasks.md: TN-130 → tn-123-…', async () => {
    const flow = await load({ ...SPEC_FILES })
    expect(flow.changeName).toBe(CHANGE_NAME)
    expect(flow.key).toBe('TN-130')
    expect(flow.jira).toBe('TN-123')
  })

  it('ключ родителя совпадает с префиксом имени change', async () => {
    const flow = await load({ ...SPEC_FILES }, { branch: 'feat/TN-123-limits' })
    expect(flow.changeName).toBe(CHANGE_NAME)
  })

  it('файлы ветки в docs/changes указывают на change, когда ключ ничего не даёт', async () => {
    const files = { ...SPEC_FILES, [`${CHANGE}/tasks.md`]: '## 2. client-fe\n\n- [ ] 2.1 Форма\n' }
    const flow = await load(files, { branch: 'feat/TN-777-x', branchChanges: [CHANGE_NAME] })
    expect(flow.changeName).toBe(CHANGE_NAME)
  })

  it('несколько changes в файлах ветки — не гадаем', async () => {
    const files = { ...SPEC_FILES, [`${CHANGE}/tasks.md`]: '## 2. client-fe\n\n- [ ] 2.1 Форма\n' }
    const flow = await load(files, { branch: 'feat/TN-777-x', branchChanges: [CHANGE_NAME, 'tn-9-other'] })
    expect(blockerIds(flow)).toEqual(['change-not-found'])
  })

  it('ручной выбор приоритетнее остального', async () => {
    const flow = await load({ ...SPEC_FILES }, { branch: 'feat/TN-999-x', override: CHANGE_NAME })
    expect(flow.changeName).toBe(CHANGE_NAME)
  })

  it('ветка без ключа и без выбора → no-key с кнопкой «Начать задачу»', async () => {
    const model = await loadFlowModel({
      root: makeProject(SPEC_FILES),
      branch: 'develop',
      remoteUrl: null,
      repoSetting: 'auto',
      overrideChange: null,
    })
    expect(model.kind).toBe('no-key')
    expect(model.kind === 'no-key' && model.actions.map((a) => a.id)).toEqual(['start', 'pick-change', 'update-specs'])
  })

  it('ветка без ключа, но change выбран вручную — берём ключ из meta.yaml', async () => {
    const flow = await load({ ...SPEC_FILES }, { branch: 'chore/misc', override: CHANGE_NAME })
    expect(flow.key).toBe('TN-123')
  })
})

describe('стопперы', () => {
  it('сабмодуль не инициализирован', async () => {
    const flow = await load({})
    expect(blockerIds(flow)).toEqual(['specs-missing'])
    expect(actionIds(flow)).toEqual(['init-specs'])
  })

  it('change не найден в feat-ветке — ошибка, предлагает выбрать или обновить спеки', async () => {
    const flow = await load({ 'openspec/changes/tn-999-other/.openspec.yaml': 'affected_areas: [exchange]\n' })
    expect(flow.blockers[0]).toMatchObject({ id: 'change-not-found', severity: 'error' })
    expect(actionIds(flow)).toEqual(['pick-change', 'bump-specs'])
  })

  it('change не найден в fix-ветке — только инфо про no-spec', async () => {
    const flow = await load({ 'openspec/changes/tn-999-other/.openspec.yaml': 'affected_areas: [exchange]\n' }, { branch: 'fix/TN-124-btn' })
    expect(flow.blockers[0]).toMatchObject({ id: 'change-not-found', severity: 'info' })
    expect(flow.blockers[0].todo).toContain('no-spec')
  })

  it('нет design.md — предупреждение и подсказка про /cex-sdd:apply', async () => {
    const flow = await load({ ...SPEC_FILES })
    expect(blockerIds(flow)).toEqual(['no-design'])
    expect(flow.next).toContain('/cex-sdd:apply')
    expect(statusOf(flow, 'design')).toBe('current')
    expect(flow.actions[0]).toMatchObject({ id: 'continue', label: 'Спроектировать и спланировать', primary: true })
  })

  it('tier 1–2: дизайн написан, но design PR не смержен — код ждёт', async () => {
    const flow = await load({ ...SPEC_FILES, ...DESIGN_FILES }, { designMerged: false })
    expect(blockerIds(flow)).toEqual(['design-not-merged'])
    expect(statusOf(flow, 'design')).toBe('current')
    expect(statusOf(flow, 'code')).toBe('todo')
    expect(flow.next).toContain('PR с дизайном')
  })

  it('tier 1–2: дизайн в develop — можно кодить', async () => {
    const flow = await load({ ...SPEC_FILES, ...DESIGN_FILES }, { designMerged: true })
    expect(blockerIds(flow)).toEqual([])
    expect(statusOf(flow, 'design')).toBe('done')
    expect(statusOf(flow, 'code')).toBe('current')
  })

  it('tier 3: дизайн идёт в одном PR с кодом, мерж дизайна не требуется', async () => {
    const files = { ...SPEC_FILES, ...DESIGN_FILES, [`${CHANGE}/meta.yaml`]: 'jira: TN-123\ntier: 3\nbreaking: false\n' }
    const flow = await load(files, { designMerged: false })
    expect(blockerIds(flow)).toEqual([])
    expect(statusOf(flow, 'design')).toBe('done')
  })

  it('открытое расхождение со спекой блокирует, закрытое — нет', async () => {
    const gaps =
      '## 1. Граница\n- **Блокирует:** шаг 2.1\n- **Решение:** <заполняет тимлид>\n\n## 2. Имя\n- **Блокирует:** шаг 2.2\n- **Решение:** баг кода\n'
    const flow = await load({ ...SPEC_FILES, ...DESIGN_FILES, [`${DESIGN}/spec-gaps.md`]: gaps }, { designMerged: true })
    expect(blockerIds(flow)).toEqual(['spec-gap-1'])
    expect(flow.blockers[0].hint).toContain('шаг 2.1')
  })

  it('приёмка «не принято» — ошибка, кнопка «продолжить» не главная', async () => {
    const flow = await load(
      {
        ...SPEC_FILES,
        ...DESIGN_FILES,
        [`${DESIGN}/plan.md`]: PLAN_DONE,
        [`${CHANGE}/acceptance.md`]: '- **Результат:** не принято\n- **Сборка:** v1.4.0-rc.1\n',
      },
      { designMerged: true },
    )
    expect(flow.blockers[0]).toMatchObject({ id: 'acceptance-rejected', severity: 'error' })
    expect(flow.actions.find((a) => a.id === 'continue')?.primary).toBe(false)
    expect(statusOf(flow, 'acceptance')).toBe('current')
  })

  it('репозиторий не затронут change', async () => {
    const files = { ...SPEC_FILES, [`${CHANGE}/.openspec.yaml`]: 'affected_areas: [exchange]\n', ...DESIGN_FILES }
    const flow = await load(files, { designMerged: true })
    expect(blockerIds(flow)).toContain('repo-not-affected')
    expect(statusOf(flow, 'code')).toBe('unknown')
  })
})

describe('прогресс и подсказки', () => {
  it('прогресс по plan.md, а не по tasks.md', async () => {
    const flow = await load({ ...SPEC_FILES, ...DESIGN_FILES }, { designMerged: true })
    expect(flow.plan).toMatchObject({
      done: 1,
      total: 3,
      local: 1,
      tasks: [
        { id: '2.1', title: 'Форма', done: 1, total: 2 },
        { id: '2.2', title: 'Ошибки', done: 0, total: 1 },
      ],
    })
    expect(flow.scopeTasks).toBe(2)
    expect(flow.next).toBe('Следующий свободный шаг плана: Валидация — проверка: vitest')
    expect(flow.actions.map((a) => a.label)).toContain('Продолжить по плану')
  })

  it('все шаги плана закрыты: дальше PR, остальное неизвестно', async () => {
    const flow = await load({ ...SPEC_FILES, ...DESIGN_FILES, [`${DESIGN}/plan.md`]: PLAN_DONE }, { designMerged: true })
    expect(statusOf(flow, 'code')).toBe('done')
    expect(statusOf(flow, 'pr')).toBe('current')
    expect(statusOf(flow, 'dev')).toBe('unknown')
    expect(flow.next).toContain('Открыть PR в develop: заголовок «TN-130')
  })

  it('приёмка принята: ждёт архивации, кнопок нет', async () => {
    const flow = await load(
      { ...SPEC_FILES, ...DESIGN_FILES, [`${CHANGE}/acceptance.md`]: '- **Результат:** принято\n- **Сборка:** v1.4.0-rc.2\n' },
      { designMerged: true },
    )
    expect(statusOf(flow, 'archive')).toBe('current')
    expect(flow.actions).toEqual([])
  })

  it('change в архиве: всё выполнено', async () => {
    const flow = await load(
      { [`openspec/changes/archive/2026-10-01-${CHANGE_NAME}/.openspec.yaml`]: 'affected_areas: [client-fe]\n' },
      { branch: 'feat/TN-123-x' },
    )
    expect(flow.steps.every((step) => step.status === 'done')).toBe(true)
    expect(flow.changeName).toBe(CHANGE_NAME)
  })

  it('читает tier и области из спеки', async () => {
    const flow = await load({ ...SPEC_FILES })
    expect(flow.tier).toBe(1)
    expect(flow.areas).toEqual(['exchange', 'client-fe'])
    expect(flow.repoId).toBe('client-fe')
  })
})
