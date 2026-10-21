import { afterEach, describe, expect, it } from 'vitest'

import { AI_REVIEW_WORKFLOW_FILE, aiReviewStatus, type IPrInfo } from '../src/core/aireview'
import { loadFlowModel, type IGitProbe } from '../src/core/model'
import type { IChangeFlow } from '../src/core/types'
import { renderBody } from '../src/ui/render'

import { DESIGN_FILES, SPEC_FILES, cleanupProjects, makeProject } from './fixtures'

afterEach(cleanupProjects)

const PR: IPrInfo = {
  number: 42,
  url: 'https://github.com/org/client-frontend/pull/42',
  isDraft: false,
  state: 'OPEN',
  checks: [{ workflowName: 'PR size', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/x/size' }],
  comments: [],
}
const LOG = 'https://github.com/org/client-frontend/actions/runs/1'
const check = (status: string, conclusion = '') => [{ workflowName: 'AI review', status, conclusion, detailsUrl: LOG }]
const COMMENT = { author: 'claude', url: 'https://github.com/org/client-frontend/pull/42#issuecomment-1' }

describe('aiReviewStatus', () => {
  it('PR нет или он закрыт — статуса нет', () => {
    expect(aiReviewStatus(null)).toBeNull()
    expect(aiReviewStatus({ ...PR, state: 'MERGED' })).toBeNull()
  })

  it.each<[string, Partial<IPrInfo>, string, string | null]>([
    ['черновик', { isDraft: true, checks: check('COMPLETED', 'SKIPPED') }, 'draft', null],
    ['прогон идёт, даже если старый комментарий есть', { checks: check('IN_PROGRESS'), comments: [COMMENT] }, 'running', LOG],
    ['комментарий Claude — ревью готово, хотя последний прогон пропущен', { checks: check('COMPLETED', 'SKIPPED'), comments: [{ author: 'dev', url: 'x' }, COMMENT] }, 'done', COMMENT.url],
    ['прогон упал', { checks: check('COMPLETED', 'FAILURE') }, 'failed', LOG],
    ['прогон прошёл, комментария нет — секрета нет', { checks: check('COMPLETED', 'SUCCESS') }, 'no-comment', LOG],
    ['прогона не было', {}, 'not-run', null],
    ['последний прогон пропущен (другая метка), комментария нет', { checks: check('COMPLETED', 'SKIPPED') }, 'not-run', null],
  ])('%s', (_name, patch, state, url) => {
    expect(aiReviewStatus({ ...PR, ...patch })).toEqual({ pr: 42, prUrl: PR.url, state, url })
  })
})

async function load(files: Record<string, string>, pr: IPrInfo | null): Promise<IChangeFlow> {
  const probe: IGitProbe = {
    branchChanges: async () => [],
    isDesignMerged: async () => true,
    currentPr: async () => pr,
  }
  const model = await loadFlowModel({
    root: makeProject(files),
    branch: 'feat/TN-130-limits-form',
    remoteUrl: 'git@example.com:org/client-frontend.git',
    repoSetting: 'auto',
    overrideChange: null,
    git: probe,
  })
  if (model.kind !== 'change') throw new Error(`ожидался change, получен ${model.kind}`)
  return model
}

describe('AI-ревью в панели', () => {
  const WITH_WORKFLOW = { ...SPEC_FILES, ...DESIGN_FILES, [AI_REVIEW_WORKFLOW_FILE]: 'name: AI review\n' }
  const actionIds = (flow: IChangeFlow) => flow.actions.map((action) => action.id)

  it('без workflow в репозитории — ни статуса, ни кнопки', async () => {
    const flow = await load({ ...SPEC_FILES, ...DESIGN_FILES }, PR)
    expect(flow.aiReview).toBeNull()
    expect(actionIds(flow)).not.toContain('ai-review')
  })

  it('ревью готово — ссылка на комментарий и кнопка перезапуска', async () => {
    const flow = await load(WITH_WORKFLOW, { ...PR, comments: [COMMENT] })
    expect(flow.aiReview?.state).toBe('done')
    expect(flow.actions.find((action) => action.id === 'ai-review')?.label).toBe('Перезапустить AI-ревью')
    const html = renderBody(flow)
    expect(html).toContain('<h2>AI-ревью</h2>')
    expect(html).toContain(`data-url="${COMMENT.url}">Открыть комментарий`)
  })

  it('не запускалось — кнопка «Запустить»; идёт прогон или черновик — кнопки нет', async () => {
    expect((await load(WITH_WORKFLOW, PR)).actions.find((a) => a.id === 'ai-review')?.label).toBe('Запустить AI-ревью')
    expect(actionIds(await load(WITH_WORKFLOW, { ...PR, checks: check('QUEUED') }))).not.toContain('ai-review')
    expect(actionIds(await load(WITH_WORKFLOW, { ...PR, isDraft: true }))).not.toContain('ai-review')
  })

  it('у ветки нет PR — ни статуса, ни кнопки', async () => {
    const flow = await load(WITH_WORKFLOW, null)
    expect(flow.aiReview).toBeNull()
    expect(actionIds(flow)).not.toContain('ai-review')
  })
})
