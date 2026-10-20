export const REPO_IDS = ['exchange', 'client-fe', 'admin-fe', 'qa-tests'] as const

export type TRepoId = (typeof REPO_IDS)[number]

export type TStepId = 'spec' | 'design' | 'code' | 'pr' | 'dev' | 'rc' | 'acceptance' | 'archive'

/** unknown — шаг зависит от GitHub/сред, локально его не определить. */
export type TStepStatus = 'done' | 'current' | 'todo' | 'unknown'

export type TBlockerSeverity = 'error' | 'warning' | 'info'

export type TActionId =
  | 'init-specs'
  | 'bump-specs'
  | 'start'
  | 'continue'
  | 'spec-gap'
  | 'verify'
  | 'verify-fast'
  | 'pick-change'
  | 'install-plugin'

export interface IAction {
  id: TActionId
  label: string
  primary?: boolean
}

export interface ITaskItem {
  /** Номер из tasks.md: «1.2». */
  id: string
  text: string
  done: boolean
}

/** Группа задач одного репозитория в tasks.md: `## 2. client-fe (TN-130)`. */
export interface ITasksGroup {
  repo: string
  /** Ключ подзадачи Jira из заголовка группы, если он там записан. */
  key: string | null
  items: ITaskItem[]
}

/**
 * Где сделан шаг плана: merged — отмечен в plan.md на develop; review — отмечен в другой ветке задачи
 * (PR ещё не смержен); local — отмечен в текущей ветке; todo — нигде.
 */
export type TPlanStepState = 'merged' | 'review' | 'local' | 'todo'

export interface IPlanStep {
  text: string
  done: boolean
  /** Постоянный id шага: `<!-- step: base -->` в plan.md; по нему PR указывает «Шаги plan.md: base». */
  stepId?: string
  state?: TPlanStepState
  /** Для review: ветка (и номер PR), где шаг в работе. */
  branch?: string
}

/** PR задачи и шаги plan.md из его описания («Шаги plan.md: base, modals»). */
export interface IPrSteps {
  number: number
  state: 'MERGED' | 'OPEN' | 'CLOSED'
  branch: string
  steps: string[]
}

/** Метка временного исключения в коде: `sdd-temp(TN-1485): право не проверяется до TN-1484`. */
export interface ITempMarker {
  file: string
  line: number
  key: string
  text: string
}

export interface IPlanTask {
  id: string
  title: string
  steps: IPlanStep[]
}

/** docs/changes/<change>/plan.md: шаги реализации, отмечает их агент. */
export interface IPlan {
  tasks: IPlanTask[]
  total: number
  done: number
}

/** Запись из docs/changes/<change>/spec-gaps.md. */
export interface ISpecGap {
  n: string
  title: string
  blocks: string
  /** Тимлид заполнил поле «Решение». */
  resolved: boolean
}

export interface IAcceptance {
  exists: boolean
  accepted: boolean
  build: string | null
}

/** Всё, что удалось прочитать про change с диска и из git. */
export interface IChangeState {
  /** Ключ задачи разработчика: из ветки или, если её нет, из meta.yaml. */
  key: string
  /** Ключ задачи change из meta.yaml (родитель). */
  jira: string | null
  changeName: string | null
  /** Сабмодуль OpenSpec подключён и содержит openspec/changes. */
  specsAvailable: boolean
  archived: boolean
  /** Путь к папке change относительно корня проекта. */
  specDir: string | null
  designDir: string | null
  hasDesign: boolean
  /** design.md уже в origin/develop. null — неизвестно. */
  designMerged: boolean | null
  affectedAreas: TRepoId[]
  tier: number | null
  tasks: ITasksGroup[]
  hasTasksFile: boolean
  plan: IPlan | null
  gaps: ISpecGap[]
  acceptance: IAcceptance
  /** Метки sdd-temp этой задачи в коде. */
  tempMarkers: ITempMarker[]
  /** Строк в разделе «Временные исключения» design.md; null — раздела нет. */
  tempTableRows: number | null
}

export interface IFlowStep {
  id: TStepId
  title: string
  status: TStepStatus
  note?: string
}

export interface IBlocker {
  id: string
  severity: TBlockerSeverity
  title: string
  hint?: string
  /** Файл, который стоит открыть, относительно корня проекта. */
  file?: string
}

export interface IPlanTaskProgress {
  id: string
  title: string
  done: number
  total: number
  /** В задаче есть шаг, который делается в текущей ветке. */
  active?: boolean
}

/** Шаг плана, который делается в текущей ветке. */
export interface ICurrentStep {
  /** Короткое название: жирная часть шага или его начало. */
  title: string
  /** Раздел плана, например «2.2 · Изменения с окном подтверждения». */
  section: string
  /** true — по PR этой ветки или отметке в ней; false — предположение по изменениям в ветке. */
  exact: boolean
}

export interface IChangeFlow {
  kind: 'change'
  key: string
  jira: string | null
  branch: string | null
  changeName: string | null
  tier: number | null
  repoId: TRepoId | null
  areas: TRepoId[]
  steps: IFlowStep[]
  blockers: IBlocker[]
  /** null — plan.md ещё нет. */
  plan: {
    done: number
    total: number
    merged: number
    review: number
    local: number
    tasks: IPlanTaskProgress[]
    /** Ветки с несмерженными шагами плана. */
    inReview: Array<{ branch: string; steps: number }>
  } | null
  /** Сколько задач tasks.md у этого репозитория. */
  scopeTasks: number | null
  tempMarkers: ITempMarker[]
  currentStep: ICurrentStep | null
  actions: IAction[]
  next: string | null
}

export type TFlowModel =
  | { kind: 'no-workspace' }
  | { kind: 'no-key'; branch: string | null; actions: IAction[]; blockers: IBlocker[] }
  | IChangeFlow
