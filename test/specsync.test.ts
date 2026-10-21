import { afterEach, describe, expect, it } from 'vitest'

import { loadFlowModel, type IGitProbe } from '../src/core/model'
import type { ISpecsSync } from '../src/core/specsync'
import type { IChangeFlow } from '../src/core/types'

import { CHANGE_NAME, DESIGN_FILES, SPEC_FILES, cleanupProjects, makeProject } from './fixtures'

afterEach(cleanupProjects)

async function load(sync: ISpecsSync | null, files: Record<string, string> = { ...SPEC_FILES, ...DESIGN_FILES }) {
  let asked: string | null | undefined
  const probe: IGitProbe = {
    branchChanges: async () => [],
    isDesignMerged: async () => true,
    specsSync: async (change) => {
      asked = change
      return sync
    },
  }
  const model = await loadFlowModel({
    root: makeProject(files),
    branch: 'feat/TN-130-limits-form',
    remoteUrl: 'git@example.com:org/client-frontend.git',
    repoSetting: 'auto',
    overrideChange: null,
    git: probe,
  })
  return { model, asked }
}

const flowOf = (model: Awaited<ReturnType<typeof load>>['model']): IChangeFlow => {
  if (model.kind !== 'change') throw new Error(`ожидался change, получен ${model.kind}`)
  return model
}
const SAME: ISpecsSync = { working: 'same', changeUpdated: false, pinnedBehind: false }

describe('состояние сабмодуля спек', () => {
  it('сверяет файлы своего change; кнопка «Обновить спеки» есть всегда', async () => {
    const { model, asked } = await load(SAME)
    const flow = flowOf(model)
    expect(asked).toBe(CHANGE_NAME)
    expect(flow.blockers.map((b) => b.id)).toEqual([])
    expect(flow.actions.map((a) => a.id)).toContain('update-specs')
  })

  it('рабочая копия отстаёт от ветки — предупреждение и кнопка синхронизации', async () => {
    const flow = flowOf((await load({ ...SAME, working: 'behind' })).model)
    const blocker = flow.blockers.find((b) => b.id === 'specs-behind')
    expect(blocker).toMatchObject({ severity: 'warning', action: { id: 'sync-specs', label: 'Синхронизировать спеки' } })
    expect(blocker?.todo).toContain('git submodule update --init')
  })

  it('спеки обновлены локально — инфо про отдельный коммит bump, без кнопки', async () => {
    const flow = flowOf((await load({ ...SAME, working: 'ahead' })).model)
    const blocker = flow.blockers.find((b) => b.id === 'specs-ahead')
    expect(blocker).toMatchObject({ severity: 'info' })
    expect(blocker?.todo).toContain('chore(TN-130): bump openspec')
    expect(blocker?.action).toBeUndefined()
  })

  it('change в main OpenSpec изменился — предупреждение и кнопка обновления', async () => {
    const flow = flowOf((await load({ working: 'same', changeUpdated: true, pinnedBehind: true })).model)
    expect(flow.blockers.find((b) => b.id === 'specs-change-updated')).toMatchObject({
      severity: 'warning',
      action: { id: 'bump-specs', label: 'Обновить спеки до main OpenSpec' },
    })
  })

  it('в OpenSpec новее только чужие changes или сверить не удалось — стоппера нет', async () => {
    for (const sync of [{ working: 'same', changeUpdated: false, pinnedBehind: true } as const, null]) {
      expect(flowOf((await load(sync)).model).blockers.filter((b) => b.id.startsWith('specs-'))).toEqual([])
    }
  })
})
