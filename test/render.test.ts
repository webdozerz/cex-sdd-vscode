import { describe, expect, it } from 'vitest'

import type { IChangeFlow } from '../src/core/types'
import { escapeHtml, renderBody, renderDocument, renderInline } from '../src/ui/render'

const FLOW: IChangeFlow = {
  kind: 'change',
  key: 'TN-130',
  jira: 'TN-123',
  branch: 'feat/TN-130-x',
  changeName: 'tn-123-<b>x</b>',
  tier: 1,
  repoId: 'client-fe',
  areas: ['client-fe'],
  plansLocation: 'code',
  plansDir: 'docs/changes/tn-123-x',
  specUpdate: { gaps: [], tasks: [] },
  steps: [{ id: 'spec', title: 'Спека', status: 'done' }],
  blockers: [{ id: 'b', severity: 'error', title: '<script>alert(1)</script>', file: 'a"b.md' }],
  plan: {
    done: 1,
    total: 2,
    merged: 0,
    review: 0,
    local: 1,
    tasks: [{ id: '2.1', title: 'Форма', done: 1, total: 2 }],
    inReview: [],
  },
  scopeTasks: 2,
  tempMarkers: [],
  currentStep: null,
  aiReview: null,
  actions: [
    { id: 'continue', label: 'Продолжить по плану', primary: true },
    { id: 'spec-gap', label: 'Расхождение со спекой' },
  ],
  next: 'Дальше',
}

describe('render', () => {
  it('экранирует пользовательские строки', () => {
    const html = renderBody(FLOW)
    expect(html).not.toContain('<script>alert')
    expect(html).not.toContain('<b>x</b>')
    expect(html).toContain('data-open="a&quot;b.md"')
  })

  it('рисует кнопки действий и родителя в тегах', () => {
    const html = renderBody(FLOW)
    expect(html).toContain('class="primary" data-action="continue"')
    expect(html).toContain('class="secondary" data-action="spec-gap"')
    expect(html).toContain('родитель TN-123')
  })

  it('показывает прогресс плана', () => {
    expect(renderBody(FLOW)).toContain('План: 1 из 2 шагов')
  })

  it('показывает «Стопперов нет», когда блокеров нет', () => {
    expect(renderBody({ ...FLOW, blockers: [] })).toContain('Стопперов нет')
  })

  it('для ветки без ключа показывает кнопки', () => {
    const html = renderBody({
      kind: 'no-key',
      branch: 'develop',
      actions: [{ id: 'start', label: 'Начать задачу', primary: true }],
      blockers: [],
    })
    expect(html).toContain('develop')
    expect(html).toContain('data-action="start"')
  })

  it('документ ограничен CSP с nonce и без inline-стилей в разметке', () => {
    const html = renderDocument(renderBody(FLOW), 'abc', 'vscode-webview:')
    expect(html).toContain("script-src 'nonce-abc'")
    expect(renderBody(FLOW)).not.toContain('style="')
  })

  it('escapeHtml', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;')
  })

  it('renderInline: код и жирный, без пропуска HTML', () => {
    expect(renderInline('**Общие модалки.** Опции `reasonMinLength` в `ModalReason`')).toBe(
      '<strong>Общие модалки.</strong> Опции <code>reasonMinLength</code> в <code>ModalReason</code>',
    )
    expect(renderInline('`<script>` и **<b>x</b>**')).toBe('<code>&lt;script&gt;</code> и <strong>&lt;b&gt;x&lt;/b&gt;</strong>')
    expect(renderInline('`a**b**c`')).toBe('<code>a**b**c</code>')
    expect(renderInline('одинокая ` кавычка')).toBe('одинокая ` кавычка')
  })

  it('«Дальше»: проверка шага выносится отдельной строкой', () => {
    const html = renderBody({ ...FLOW, next: 'Следующий шаг плана: **Модалки** — проверка: `pnpm verify`' })
    expect(html).toContain('<div>Следующий шаг плана: <strong>Модалки</strong></div>')
    expect(html).toContain('<div class="next__check">Проверка: <code>pnpm verify</code></div>')
  })

  it('временные исключения: список с переходом к строке', () => {
    const html = renderBody({
      ...FLOW,
      tempMarkers: [{ file: 'src/a.ts', line: 12, key: 'TN-130', text: 'право не проверяется до `TN-131`' }],
    })
    expect(html).toContain('<h2>Временные исключения</h2>')
    expect(html).toContain('data-open="src/a.ts:12"')
    expect(html).toContain('<code>TN-131</code>')
  })

  it('«Сейчас в этой ветке» и отметка раздела', () => {
    const html = renderBody({
      ...FLOW,
      currentStep: { title: 'Форма лимитов', section: '2.2 · Изменения', exact: false },
      plan: { ...FLOW.plan!, tasks: [{ id: '2.2', title: 'Изменения', done: 1, total: 2, active: true }] },
    })
    expect(html).toContain('<h2>Сейчас в этой ветке</h2>')
    expect(html).toContain('Форма лимитов')
    expect(html).toContain('предположительно')
    expect(html).toContain('<span class="badge">в работе</span>')
  })
})

describe('место плана', () => {
  it('план в спеке — тег в шапке', () => {
    expect(renderBody({ ...FLOW, plansLocation: 'spec' })).toContain('<span class="tag">план в спеке</span>')
    expect(renderBody(FLOW)).not.toContain('план в спеке')
  })
})
