import type { IAction, IBlocker, IChangeFlow, IFlowStep, TFlowModel, TStepStatus } from '../core/types'

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Инлайновая разметка из plan.md и спек: `код` и **жирный**. Сначала экранирование, потом теги,
 * поэтому HTML из текста не проходит. Внутри `кода` звёздочки не трогаем.
 */
export function renderInline(value: string): string {
  return value
    .split(/(`[^`]+`)/)
    .map((part) =>
      part.length > 2 && part.startsWith('`') && part.endsWith('`')
        ? `<code>${escapeHtml(part.slice(1, -1))}</code>`
        : escapeHtml(part).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>'),
    )
    .join('')
}

const CHECK_SEPARATOR = /\s+[—–-]\s+проверка:\s*/i

/** «Дальше»: шаг плана и его проверка — отдельными строками, чтобы длинный текст читался. */
function renderNext(next: string): string {
  const [main, check] = next.split(CHECK_SEPARATOR, 2)
  const checkLine = check ? `<div class="next__check">Проверка: ${renderInline(check)}</div>` : ''
  return `<h2>Дальше</h2><div class="next"><div>${renderInline(main)}</div>${checkLine}</div>`
}

const STEP_ICON: Record<TStepStatus, string> = { done: '✓', current: '●', todo: '○', unknown: '?' }
const SEVERITY_ICON = { error: '🛑', warning: '⚠️', info: 'ℹ️' } as const

function renderAction(action: IAction): string {
  const kind = action.primary ? 'primary' : 'secondary'
  return `<button class="${kind}" data-action="${escapeHtml(action.id)}">${escapeHtml(action.label)}</button>`
}

function renderActions(actions: IAction[]): string {
  return actions.length ? `<div class="actions">${actions.map(renderAction).join('')}</div>` : ''
}

function renderStep(step: IFlowStep): string {
  const note = step.note ? `<span class="step__note">${escapeHtml(step.note)}</span>` : ''
  return `<li class="step step_${step.status}">
    <span class="step__icon" aria-hidden="true">${STEP_ICON[step.status]}</span>
    <span class="step__body"><span class="step__title">${escapeHtml(step.title)}</span>${note}</span>
  </li>`
}

function renderBlocker(blocker: IBlocker): string {
  const hint = blocker.hint ? `<div class="blocker__hint">${escapeHtml(blocker.hint)}</div>` : ''
  const open = blocker.file
    ? `<button class="link" data-open="${escapeHtml(blocker.file)}">Открыть</button>`
    : ''
  return `<li class="blocker blocker_${blocker.severity}">
    <span class="blocker__icon" aria-hidden="true">${SEVERITY_ICON[blocker.severity]}</span>
    <div class="blocker__body">
      <div class="blocker__title">${escapeHtml(blocker.title)}</div>${hint}${open}
    </div>
  </li>`
}

function renderBar(label: string, done: number, total: number, strong: boolean, active = false): string {
  const badge = active ? '<span class="badge">в работе</span>' : ''
  return `<li class="progress${strong ? ' progress_current' : ''}${active ? ' progress_active' : ''}">
    <div class="progress__head"><span>${renderInline(label)}${badge}</span><span>${done}/${total}</span></div>
    <progress class="progress__bar" max="${total}" value="${done}"></progress>
  </li>`
}

function renderPlan(flow: IChangeFlow): string {
  if (!flow.plan) {
    return flow.scopeTasks !== null
      ? `<h2>План</h2><p class="muted">plan.md ещё нет. В tasks.md у этого репо задач: ${flow.scopeTasks}.</p>`
      : ''
  }
  const { plan } = flow
  const left = plan.total - plan.done
  const legend = [
    plan.merged ? `в develop: ${plan.merged}` : null,
    plan.review ? `в PR: ${plan.review}` : null,
    plan.local ? `в этой ветке: ${plan.local}` : null,
    `осталось: ${left}`,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')
  const tasks = plan.tasks
    .filter((task) => task.total > 0)
    .map((task) => renderBar(`${task.id ? `${task.id} · ` : ''}${task.title}`, task.done, task.total, false, task.active))
    .join('')
  const inReview = plan.inReview.length
    ? `<p class="muted plan__review">Ждут мержа: ${plan.inReview
        .map((item) => `<code>${escapeHtml(item.branch)}</code> (${item.steps})`)
        .join(', ')}</p>`
    : ''
  return `<h2>План: ${plan.done} из ${plan.total} шагов</h2>
    <p class="muted plan__legend">${escapeHtml(legend)}</p>
    ${inReview}
    <ul class="list">${renderBar('Всего', plan.done, plan.total, true)}${tasks}</ul>`
}

function renderCurrentStep(flow: IChangeFlow): string {
  const current = flow.currentStep
  if (!current) return ''
  const source = current.exact
    ? 'по PR этой ветки'
    : 'предположительно: первый свободный шаг, в ветке есть изменения. Точно будет видно, когда PR укажет «Шаги plan.md»'
  return `<h2>Сейчас в этой ветке</h2>
    <div class="current">
      <div class="current__title">${renderInline(current.title)}</div>
      <div class="current__section">${renderInline(current.section)}</div>
      <div class="current__source">${escapeHtml(source)}</div>
    </div>`
}

function renderTempMarkers(flow: IChangeFlow): string {
  if (flow.tempMarkers.length === 0) return ''
  const items = flow.tempMarkers
    .map((marker) => {
      const place = `${marker.file}:${marker.line}`
      return `<li class="temp"><button class="link" data-open="${escapeHtml(place)}">${escapeHtml(place)}</button>${
        marker.text ? `<div class="temp__text">${renderInline(marker.text)}</div>` : ''
      }</li>`
    })
    .join('')
  return `<h2>Временные исключения</h2><ul class="list">${items}</ul>`
}

function renderChange(flow: IChangeFlow): string {
  const tags = [
    flow.tier !== null ? `tier ${flow.tier}` : null,
    flow.jira && flow.jira !== flow.key ? `родитель ${flow.jira}` : null,
    ...flow.areas,
  ]
    .filter((tag): tag is string => tag !== null)
    .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
    .join('')

  const blockers = flow.blockers.length
    ? `<ul class="list">${flow.blockers.map(renderBlocker).join('')}</ul>`
    : '<p class="ok">Стопперов нет ✓</p>'

  const next = flow.next ? renderNext(flow.next) : ''

  return `<header class="head">
      <div class="head__key">${escapeHtml(flow.key || 'Без ключа')}</div>
      ${flow.changeName ? `<div class="head__name">${escapeHtml(flow.changeName)}</div>` : ''}
      <div class="tags">${tags}</div>
    </header>
    ${renderActions(flow.actions)}
    <ol class="steps">${flow.steps.map(renderStep).join('')}</ol>
    <h2>Что блокирует</h2>${blockers}
    ${renderCurrentStep(flow)}
    ${renderPlan(flow)}
    ${renderTempMarkers(flow)}
    ${next}`
}

export function renderBody(model: TFlowModel): string {
  switch (model.kind) {
    case 'no-workspace':
      return '<p class="muted">Откройте папку проекта.</p>'
    case 'no-key':
      return `<p class="muted">${
        model.branch
          ? `В ветке <b>${escapeHtml(model.branch)}</b> нет ключа задачи SE-NNN.`
          : 'Не удалось определить ветку.'
      }</p>
      ${renderActions(model.actions)}
      ${model.blockers.length ? `<h2>Что блокирует</h2><ul class="list">${model.blockers.map(renderBlocker).join('')}</ul>` : ''}
      <p class="muted">Задача без спеки (старый процесс): PR получает метку <b>no-spec</b> и строку «Без спеки: причина».</p>`
    case 'change':
      return renderChange(model)
  }
}

const STYLE = `
  body { padding: 0 12px 16px; color: var(--vscode-foreground); font: var(--vscode-font-size) var(--vscode-font-family); }
  h2 { margin: 18px 0 8px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
  ul, ol { list-style: none; margin: 0; padding: 0; }
  .muted { color: var(--vscode-descriptionForeground); line-height: 1.5; }
  .head { padding-top: 12px; }
  .head__key { font-size: 18px; font-weight: 600; }
  .head__name { margin-top: 2px; color: var(--vscode-descriptionForeground); word-break: break-all; }
  .tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
  .tag { padding: 1px 8px; border-radius: 10px; font-size: 11px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .actions { display: flex; flex-direction: column; gap: 6px; margin-top: 14px; }
  .steps { margin-top: 16px; }
  .step { display: flex; gap: 10px; padding: 5px 0; position: relative; }
  .step:not(:last-child)::before { content: ''; position: absolute; left: 7px; top: 24px; bottom: -5px; width: 1px; background: var(--vscode-editorGroup-border); }
  .step__icon { flex: none; width: 15px; text-align: center; line-height: 1.5; }
  .step__body { display: flex; flex-direction: column; }
  .step__note { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .step_done .step__icon { color: var(--vscode-testing-iconPassed); }
  .step_done .step__title { color: var(--vscode-descriptionForeground); }
  .step_current .step__icon { color: var(--vscode-charts-blue); }
  .step_current .step__title { font-weight: 600; }
  .step_todo, .step_unknown { opacity: .65; }
  .blocker { display: flex; gap: 8px; padding: 8px 10px; margin-bottom: 6px; border-radius: 4px; border-left: 3px solid; background: var(--vscode-editor-inactiveSelectionBackground); }
  .blocker_error { border-color: var(--vscode-errorForeground); }
  .blocker_warning { border-color: var(--vscode-editorWarning-foreground); }
  .blocker_info { border-color: var(--vscode-editorInfo-foreground); }
  .blocker__title { font-weight: 600; line-height: 1.4; }
  .blocker__hint { margin-top: 2px; font-size: 12px; color: var(--vscode-descriptionForeground); line-height: 1.4; }
  .ok { color: var(--vscode-testing-iconPassed); margin: 0; }
  .progress { margin-bottom: 10px; }
  .progress__head { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; margin-bottom: 4px; }
  .progress_current .progress__head { font-weight: 600; }
  .progress__bar { display: block; width: 100%; height: 4px; appearance: none; border: 0; border-radius: 2px; background: var(--vscode-editorGroup-border); overflow: hidden; }
  .progress__bar::-webkit-progress-bar { background: var(--vscode-editorGroup-border); }
  .progress__bar::-webkit-progress-value { background: var(--vscode-charts-blue); border-radius: 2px; }
  .next { margin: 0; padding: 8px 10px; border-radius: 4px; background: var(--vscode-editor-inactiveSelectionBackground); line-height: 1.45; overflow-wrap: anywhere; }
  .current { padding: 8px 10px; border-radius: 4px; border-left: 3px solid var(--vscode-charts-blue); background: var(--vscode-editor-inactiveSelectionBackground); }
  .current__title { font-weight: 600; line-height: 1.4; }
  .current__section, .current__source { margin-top: 2px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .badge { margin-inline-start: 6px; padding: 0 6px; border-radius: 8px; font-size: 10px; font-weight: 600; background: var(--vscode-charts-blue); color: var(--vscode-button-foreground); }
  .progress_active .progress__head { font-weight: 600; }
  .temp { margin-bottom: 6px; }
  .temp__text { font-size: 12px; color: var(--vscode-descriptionForeground); }
  .plan__legend, .plan__review { margin: 0 0 8px; font-size: 12px; }
  .next__check { margin-top: 6px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  code { padding: 0 3px; border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: .92em; background: var(--vscode-textCodeBlock-background); }
  button { font: inherit; cursor: pointer; }
  .link { margin-top: 4px; padding: 0; border: 0; background: none; color: var(--vscode-textLink-foreground); }
  .link:hover { text-decoration: underline; }
  .primary, .secondary { padding: 5px 12px; border: 0; border-radius: 2px; text-align: center; }
  .primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .primary:hover { background: var(--vscode-button-hoverBackground); }
  .secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
`

const SCRIPT = `
  const vscode = acquireVsCodeApi()
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button') : null
    if (!target) return
    if (target.dataset.open) vscode.postMessage({ type: 'open', path: target.dataset.open })
    if (target.dataset.action) vscode.postMessage({ type: 'action', id: target.dataset.action })
  })
`

export function renderDocument(body: string, nonce: string, cspSource: string): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}' ${cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>${body}<script nonce="${nonce}">${SCRIPT}</script></body>
</html>`
}
