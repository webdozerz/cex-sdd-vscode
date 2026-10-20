import { isFixBranch } from './branch'
import { MIN_PLUGIN_VERSION, PLUGIN_NAME, PLUGIN_OK, type IPluginStatus } from './plugin'
import type {
  IAction,
  IBlocker,
  IChangeFlow,
  IChangeState,
  IFlowStep,
  ITasksGroup,
  TRepoId,
  TStepId,
  TStepStatus,
} from './types'

const STEP_TITLES: Record<TStepId, string> = {
  spec: 'Спека (Gate 1 пройден)',
  design: 'Дизайн и план',
  code: 'Реализация',
  pr: 'PR в develop',
  dev: 'Dev',
  rc: 'Релизный срез (rc)',
  acceptance: 'Приёмка QA',
  archive: 'Архив и тег',
}

const STEP_ORDER: TStepId[] = ['spec', 'design', 'code', 'pr', 'dev', 'rc', 'acceptance', 'archive']

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const

const ACTION_VERIFY_FAST: IAction = { id: 'verify-fast', label: 'Быстрая проверка' }
const ACTION_VERIFY: IAction = { id: 'verify', label: 'Полная проверка (verify)' }
const ACTION_SPEC_GAP: IAction = { id: 'spec-gap', label: 'Расхождение со спекой' }

interface IFlowContext {
  repoId: TRepoId | null
  branch: string | null
  /** Состояние плагина cex-sdd; по умолчанию считается исправным. */
  plugin?: IPluginStatus
  /** В ветке задачи есть изменения относительно develop. */
  branchActive?: boolean
}

/** Для tier 1–2 design.md и plan.md уходят отдельным PR до кода; tier 3 — в одном PR с кодом. */
function needsDesignPr(state: IChangeState): boolean {
  return state.tier === 1 || state.tier === 2
}

function findGroup(state: IChangeState, repoId: TRepoId | null): ITasksGroup | null {
  return repoId ? (state.tasks.find((group) => group.repo === repoId) ?? null) : null
}

function isDesignDone(state: IChangeState): boolean {
  return state.hasDesign && !(needsDesignPr(state) && state.designMerged === false)
}

function isCodeDone(state: IChangeState): boolean {
  return (
    state.plan !== null && state.plan.total > 0 && state.plan.done === state.plan.total && state.tempMarkers.length === 0
  )
}

const INTEGRATION_RE = /интеграц/i

/** Пора интегрироваться: вне раздела «Интеграция» не осталось несделанных шагов плана. */
function isIntegrationTime(state: IChangeState): boolean {
  if (!state.plan || state.plan.total === 0) return false
  return state.plan.tasks
    .filter((task) => !INTEGRATION_RE.test(task.title))
    .every((task) => task.steps.every((step) => step.done))
}

function tempExceptionBlockers(state: IChangeState): IBlocker[] {
  const blockers: IBlocker[] = []
  const markers = state.tempMarkers
  if (markers.length > 0) {
    const integration = isIntegrationTime(state)
    blockers.push({
      id: 'temp-exceptions',
      severity: integration ? 'error' : 'info',
      title: integration ? `Не сняты временные исключения: ${markers.length}` : `Временные исключения: ${markers.length}`,
      hint: integration
        ? 'До закрытия шага «Интеграция» все метки sdd-temp в коде и строки таблицы в design.md должны быть сняты'
        : 'Снять до шага «Интеграция». Список меток — ниже',
      file: `${markers[0].file}:${markers[0].line}`,
    })
  }
  const rows = state.tempTableRows
  if (markers.length > 0 && rows === null && state.hasDesign) {
    blockers.push({
      id: 'temp-table-missing',
      severity: 'warning',
      title: 'В design.md нет раздела «Временные исключения»',
      hint: 'Каждая метка sdd-temp в коде записывается строкой таблицы: что, где, почему, когда снять',
      ...(state.designDir ? { file: `${state.designDir}/design.md` } : {}),
    })
  } else if (rows !== null && rows !== markers.length) {
    blockers.push({
      id: 'temp-table-mismatch',
      severity: 'warning',
      title: `Временные исключения расходятся: в design.md ${rows}, в коде ${markers.length} меток sdd-temp`,
      hint: 'Таблица в design.md и метки в коде описывают одни и те же исключения: добавьте недостающее или уберите снятое',
      ...(state.designDir ? { file: `${state.designDir}/design.md` } : {}),
    })
  }
  return blockers
}

function isRepoOutside(state: IChangeState, repoId: TRepoId | null): boolean {
  return repoId !== null && state.affectedAreas.length > 0 && !state.affectedAreas.includes(repoId)
}

function computeStatuses(state: IChangeState, ctx: IFlowContext): Record<TStepId, TStepStatus> {
  const statuses = Object.fromEntries(STEP_ORDER.map((id) => [id, 'todo'])) as Record<TStepId, TStepStatus>

  if (state.archived) {
    for (const id of STEP_ORDER) statuses[id] = 'done'
    return statuses
  }

  const codeDone = isCodeDone(state)
  // Локально известная часть цепочки идёт строго по порядку: первый невыполненный шаг — текущий.
  const local: Array<[TStepId, boolean]> = [
    ['spec', state.specDir !== null],
    ['design', isDesignDone(state)],
    ['code', codeDone],
  ]
  let currentAssigned = false
  for (const [id, done] of local) {
    if (done) statuses[id] = 'done'
    else if (id === 'code' && isRepoOutside(state, ctx.repoId)) statuses[id] = 'unknown'
    else if (!currentAssigned) {
      statuses[id] = 'current'
      currentAssigned = true
    }
  }

  if (state.acceptance.accepted) {
    for (const id of ['spec', 'design', 'code', 'pr', 'dev', 'rc', 'acceptance'] as const) statuses[id] = 'done'
    statuses.archive = 'current'
    return statuses
  }

  if (codeDone) {
    // Дальше — GitHub и среды; без интеграции честно показываем «неизвестно».
    statuses.pr = 'current'
    statuses.dev = 'unknown'
    statuses.rc = 'unknown'
    if (state.acceptance.exists) statuses.acceptance = 'current'
  }
  return statuses
}

function stepNote(id: TStepId, status: TStepStatus, state: IChangeState): string | undefined {
  if (id === 'design' && status === 'current' && state.hasDesign && needsDesignPr(state)) {
    return 'design PR ещё не смержен в develop'
  }
  if (id === 'pr' && status === 'current') return 'статус PR появится с интеграцией GitHub'
  if ((id === 'dev' || id === 'rc') && status === 'unknown') return 'определяется по GitHub'
  if (id === 'code' && status === 'unknown') return 'репозиторий не затронут этим change'
  if (id === 'acceptance' && status === 'current' && state.acceptance.exists) return 'не принято'
  if (id === 'archive' && status === 'current') return 'выполняет аналитик: /opsx:archive'
  return undefined
}

function computeBlockers(state: IChangeState, ctx: IFlowContext): IBlocker[] {
  const blockers: IBlocker[] = []
  const { repoId } = ctx

  if (!state.specsAvailable) {
    blockers.push({
      id: 'specs-missing',
      severity: 'error',
      title: 'Спека не подключена: нет openspec/changes',
      hint: 'Подключите сабмодуль OpenSpec кнопкой «Подключить спеки» (нужен доступ на чтение к CryptoExch/OpenSpec)',
    })
    return blockers
  }

  if (state.specDir === null) {
    const fix = isFixBranch(ctx.branch)
    blockers.push({
      id: 'change-not-found',
      severity: fix ? 'info' : 'error',
      title: `Не найден change для ${state.key}`,
      hint: fix
        ? 'Если задача без спеки — PR получает метку no-spec и строку «Без спеки: причина». Если change есть, выберите его вручную'
        : 'Ключ подзадачи с change связан через родителя в Jira, по имени change его не найти: выберите change вручную. Если change нет в списке, подтяните спеку: нужен отдельный коммит chore(TN-…): bump openspec',
    })
    return blockers
  }

  if (state.archived) return blockers

  if (isRepoOutside(state, repoId)) {
    blockers.push({
      id: 'repo-not-affected',
      severity: 'info',
      title: `Репозитория ${repoId} нет в affected_areas этого change`,
      hint: `Затронуты: ${state.affectedAreas.join(', ')}. Если работа нужна и здесь, change правит аналитик через /opsx:update`,
      file: `${state.specDir}/.openspec.yaml`,
    })
  }

  if (!state.hasTasksFile) {
    blockers.push({ id: 'no-tasks', severity: 'warning', title: 'В change нет tasks.md', file: state.specDir })
  } else if (repoId && state.affectedAreas.includes(repoId) && !state.tasks.some((group) => group.repo === repoId)) {
    blockers.push({
      id: 'no-task-group',
      severity: 'warning',
      title: `В tasks.md нет группы «${repoId}»`,
      hint: 'Репозиторий есть в affected_areas, но задач для него не описано',
      file: `${state.specDir}/tasks.md`,
    })
  }

  if (!state.hasDesign) {
    blockers.push({
      id: 'no-design',
      severity: 'warning',
      title: 'Нет design.md и plan.md',
      hint: `Их создаёт /cex-sdd:apply в docs/changes/${state.changeName}/ и ждёт вашего согласия`,
    })
  } else if (needsDesignPr(state) && state.designMerged === false) {
    blockers.push({
      id: 'design-not-merged',
      severity: 'warning',
      title: 'Дизайн ещё не в develop',
      hint: `Для tier ${state.tier} код начинается после мержа design PR (ветка feat/${state.key}-<slug>-design, ревью тимлида)`,
      ...(state.designDir ? { file: `${state.designDir}/design.md` } : {}),
    })
  }

  for (const gap of state.gaps.filter((item) => !item.resolved)) {
    blockers.push({
      id: `spec-gap-${gap.n}`,
      severity: 'warning',
      title: `Расхождение со спекой №${gap.n}: ${gap.title}`,
      hint: `${gap.blocks ? `Блокирует: ${gap.blocks}. ` : ''}Ждёт решения тимлида (поле «Решение» в spec-gaps.md)`,
      file: `${state.designDir}/spec-gaps.md`,
    })
  }

  blockers.push(...tempExceptionBlockers(state))

  if (state.acceptance.exists && !state.acceptance.accepted) {
    blockers.push({
      id: 'acceptance-rejected',
      severity: 'error',
      title: 'Приёмка QA: не принято',
      hint: 'Разберите дефекты в acceptance.md, исправьте код и подготовьте новый rc',
      file: `${state.specDir}/acceptance.md`,
    })
  }

  return blockers.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}

/** Короткое название шага: жирная часть («**Форма лимитов.**») или начало текста до «— проверка». */
export function stepTitle(text: string): string {
  const bold = text.match(/^\*\*(.+?)\*\*/)?.[1]
  const plain = bold ?? text.split(/\s+[—–-]\s+проверка:/i)[0]
  const trimmed = plain.replace(/[.:]\s*$/, '').trim()
  return trimmed.length > 90 ? `${trimmed.slice(0, 89)}…` : trimmed
}

interface ILocatedStep {
  text: string
  section: string
  taskIndex: number
  stepIndex: number
}

function sectionLabel(task: { id: string; title: string }): string {
  return `${task.id ? `${task.id} · ` : ''}${task.title}`
}

/**
 * Какой шаг делается в текущей ветке. Точно — по PR этой ветки или отметке в ней (state local).
 * Иначе, если в ветке задачи есть изменения, — предположительно первый свободный шаг.
 */
function findCurrentStep(state: IChangeState, ctx: IFlowContext): (ILocatedStep & { exact: boolean }) | null {
  if (!state.plan) return null
  const located: Array<ILocatedStep & { done: boolean; local: boolean }> = state.plan.tasks.flatMap((task, taskIndex) =>
    task.steps.map((step, stepIndex) => ({
      text: step.text,
      section: sectionLabel(task),
      taskIndex,
      stepIndex,
      done: step.done,
      local: step.state === 'local',
    })),
  )
  const local = located.find((step) => step.local)
  if (local) return { ...local, exact: true }
  if (!ctx.branchActive || /-design$/.test(ctx.branch ?? '')) return null
  const firstFree = located.find((step) => !step.done)
  return firstFree ? { ...firstFree, exact: false } : null
}

function computeNext(state: IChangeState, blockers: IBlocker[], current: ILocatedStep | null = null): string | null {
  const firstError = blockers.find((blocker) => blocker.severity === 'error')
  if (firstError) return `Снять стоппер: ${firstError.title}`
  if (state.archived) return 'Change в архиве, работа завершена'
  if (state.acceptance.accepted) return 'Приёмка пройдена, change ждёт архивации'
  if (!state.hasDesign) return 'Спроектировать: /cex-sdd:apply напишет design.md и plan.md и спросит согласия'
  if (needsDesignPr(state) && state.designMerged === false) {
    return 'Открыть PR с дизайном (заголовок «TN-…: design …») и дождаться мержа'
  }
  if (state.tempMarkers.length > 0 && isIntegrationTime(state)) {
    return 'Снять временные исключения: метки sdd-temp в коде и строки таблицы в design.md'
  }
  const planSteps = state.plan?.tasks.flatMap((task) => task.steps) ?? []
  const openStep = planSteps.find((step) => !step.done && step.text !== current?.text)
  if (openStep) return `${current ? 'Следующий шаг после текущего' : 'Следующий свободный шаг плана'}: ${openStep.text}`
  if (current) return `Закончить текущий шаг и открыть PR: в описании «Шаги plan.md» с id этого шага`
  const waiting = [...new Set(planSteps.filter((step) => step.state === 'review').map((step) => step.branch))]
  if (waiting.length > 0) return `Все шаги взяты в работу, ждут мержа PR: ${waiting.join(', ')}`
  if (isCodeDone(state)) return `Открыть PR в develop: заголовок «${state.key}: …», метка ai-assisted`
  return null
}

function computeActions(state: IChangeState, blockers: IBlocker[]): IAction[] {
  if (!state.specsAvailable) return [{ id: 'init-specs', label: 'Подключить спеки', primary: true }]
  if (state.specDir === null) {
    return [
      { id: 'pick-change', label: 'Выбрать change', primary: true },
      { id: 'bump-specs', label: 'Обновить спеки' },
    ]
  }
  if (state.archived || state.acceptance.accepted) return []

  const hasOpenStep = state.plan !== null && state.plan.done < state.plan.total
  const label = !state.hasDesign
    ? 'Спроектировать и спланировать'
    : hasOpenStep
      ? 'Продолжить по плану'
      : 'Продолжить change'
  const actions: IAction[] = [{ id: 'continue', label, primary: !blockers.some((b) => b.severity === 'error') }]
  actions.push(ACTION_SPEC_GAP, ACTION_VERIFY_FAST, ACTION_VERIFY)
  return actions
}

/** Стоппер про плагин: без него нет команд /cex-sdd:*, на которых держатся «Спроектировать», «Продолжить» и spec-gap. */
export function pluginBlockers(plugin: IPluginStatus = PLUGIN_OK): IBlocker[] {
  switch (plugin.state) {
    case 'missing':
      return [
        {
          id: 'plugin-missing',
          severity: 'error',
          title: `Не установлен плагин ${PLUGIN_NAME}`,
          hint: 'Без него нет команд /cex-sdd:apply и /cex-sdd:spec-gap. Нужны маркетплейс crypton и плагин cex-sdd',
        },
      ]
    case 'disabled':
      return [
        {
          id: 'plugin-disabled',
          severity: 'error',
          title: `Плагин ${PLUGIN_NAME} отключён`,
          hint: 'Команды /cex-sdd:* недоступны, пока плагин выключен в настройках Claude Code',
        },
      ]
    case 'outdated':
      return [
        {
          id: 'plugin-outdated',
          severity: 'warning',
          title: `Плагин ${PLUGIN_NAME} ${plugin.version ?? ''} устарел (нужна ${MIN_PLUGIN_VERSION} или новее)`,
          hint: 'Старые версии берут в ветку, коммиты и PR ключ родителя вместо ключа подзадачи своего репозитория',
        },
      ]
    default:
      return []
  }
}

const PLUGIN_ACTION_LABEL: Partial<Record<IPluginStatus['state'], string>> = {
  missing: `Установить плагин ${PLUGIN_NAME}`,
  disabled: `Включить плагин ${PLUGIN_NAME}`,
  outdated: `Обновить плагин ${PLUGIN_NAME}`,
}

/** Добавляет кнопку починки плагина. Если плагина нет совсем, она главная, а остальные кнопки перестают быть главными. */
export function withPluginAction(actions: IAction[], plugin: IPluginStatus = PLUGIN_OK): IAction[] {
  const label = PLUGIN_ACTION_LABEL[plugin.state]
  if (!label) return actions
  const blocking = plugin.state === 'missing' || plugin.state === 'disabled'
  const action: IAction = { id: 'install-plugin', label, ...(blocking ? { primary: true } : {}) }
  return blocking ? [action, ...actions.map((item) => ({ id: item.id, label: item.label }))] : [...actions, action]
}

export function noKeyActions(specsAvailable: boolean, plugin: IPluginStatus = PLUGIN_OK): IAction[] {
  const actions: IAction[] = specsAvailable
    ? [
        { id: 'start', label: 'Начать задачу', primary: true },
        { id: 'pick-change', label: 'Выбрать change' },
      ]
    : [{ id: 'init-specs', label: 'Подключить спеки', primary: true }]
  return withPluginAction(actions, plugin)
}

function countPlanStates(state: IChangeState): {
  merged: number
  review: number
  local: number
  inReview: Array<{ branch: string; steps: number }>
} {
  const steps = state.plan?.tasks.flatMap((task) => task.steps) ?? []
  const count = (wanted: string): number => steps.filter((step) => step.state === wanted).length
  const byBranch = new Map<string, number>()
  for (const step of steps) {
    if (step.state === 'review' && step.branch) byBranch.set(step.branch, (byBranch.get(step.branch) ?? 0) + 1)
  }
  // Без сведений из других веток (нет git) отмеченное в текущем plan.md считаем сделанным здесь.
  const hasStates = steps.some((step) => step.state !== undefined)
  return {
    merged: count('merged'),
    review: count('review'),
    local: hasStates ? count('local') : steps.filter((step) => step.done).length,
    inReview: [...byBranch].map(([branch, count]) => ({ branch, steps: count })),
  }
}

export function buildFlow(state: IChangeState, context: IFlowContext): IChangeFlow {
  const statuses = computeStatuses(state, context)
  const steps: IFlowStep[] = STEP_ORDER.map((id) => {
    const note = stepNote(id, statuses[id], state)
    return { id, title: STEP_TITLES[id], status: statuses[id], ...(note ? { note } : {}) }
  })
  const current = findCurrentStep(state, context)
  const blockers = [...pluginBlockers(context.plugin), ...computeBlockers(state, context)].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  )
  const group = findGroup(state, context.repoId)

  return {
    kind: 'change',
    key: state.key,
    jira: state.jira,
    branch: context.branch,
    changeName: state.changeName,
    tier: state.tier,
    repoId: context.repoId,
    areas: state.affectedAreas,
    steps,
    blockers,
    plan: state.plan
      ? {
          done: state.plan.done,
          total: state.plan.total,
          ...countPlanStates(state),
          tasks: state.plan.tasks.map((task, taskIndex) => ({
            ...(current?.taskIndex === taskIndex ? { active: true } : {}),
            id: task.id,
            title: task.title,
            done: task.steps.filter((step) => step.done).length,
            total: task.steps.length,
          })),
        }
      : null,
    scopeTasks: group ? group.items.length : null,
    tempMarkers: state.tempMarkers,
    currentStep: current ? { title: stepTitle(current.text), section: current.section, exact: current.exact } : null,
    actions: withPluginAction(computeActions(state, blockers), context.plugin),
    next: computeNext(state, blockers, current),
  }
}
