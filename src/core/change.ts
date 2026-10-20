import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

import { changePrefix } from './branch'
import { countTempTableRows, parsePlan, parseSpecGaps } from './plan'
import { parseTasks } from './tasks'
import { REPO_IDS, type IAcceptance, type IChangeState, type TPlansLocation, type TRepoId } from './types'

const SPEC_CHANGES = join('openspec', 'changes')
const DESIGN_CHANGES = join('docs', 'changes')
/** Настройки процесса в корне кодового репо; общий файл с плагином cex-sdd. */
export const PROJECT_CONFIG_FILE = '.cex-sdd.yaml'

export interface IChangeInfo {
  name: string
  /** Заголовок из proposal.md, если есть. */
  title: string
  tier: number | null
  jira: string | null
  areas: TRepoId[]
  /** Ключи подзадач из заголовков групп tasks.md: { 'client-fe': 'TN-130' }. */
  groupKeys: Record<string, string>
}

export type TResolvedVia = 'override' | 'task-key' | 'prefix' | 'branch-files'

export interface IResolveInput {
  /** Ключ из ветки (TN-130) или null. */
  key: string | null
  /** Change, выбранный вручную. */
  override: string | null
  /** Changes, чьи файлы docs/changes/<change>/ затронуты веткой. */
  branchChanges: string[]
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function readYaml(path: string): Record<string, unknown> | null {
  const text = readText(path)
  if (text === null) return null
  try {
    const value: unknown = parse(text)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function toAreas(raw: unknown): TRepoId[] {
  return Array.isArray(raw) ? raw.filter((a): a is TRepoId => (REPO_IDS as readonly string[]).includes(String(a))) : []
}

/** Имена активных changes в подключённой спеке (без архива). */
export function listActiveChanges(root: string): string[] {
  return listDirs(join(root, SPEC_CHANGES)).filter((name) => name !== 'archive')
}

const TITLE_MAX = 90

/**
 * Название change для списка. Заголовок `# Proposal` названия не несёт, поэтому берём
 * первую фразу раздела «Why» (или «Зачем»); заголовок с названием («# Proposal: Лимиты») — как есть.
 */
export function proposalTitle(markdown: string): string {
  const lines = markdown.split(/\r?\n/)
  const heading = lines.find((line) => /^#\s+\S/.test(line))?.replace(/^#\s+/, '').trim() ?? ''
  const named = heading.replace(/^(proposal|предложение)\s*[:—-]\s*/i, '').trim()
  if (named && !/^(proposal|предложение)$/i.test(named)) return named

  const whyAt = lines.findIndex((line) => /^##\s+(why|зачем)\b/i.test(line))
  const paragraph = whyAt < 0 ? undefined : lines.slice(whyAt + 1).find((line) => line.trim() && !line.startsWith('#'))
  if (!paragraph) return ''
  const sentence = paragraph.trim().split(/(?<=[.!?])\s/)[0]
  return sentence.length > TITLE_MAX ? `${sentence.slice(0, TITLE_MAX - 1)}…` : sentence
}

function readProposalTitle(root: string, name: string): string {
  const text = readText(join(root, SPEC_CHANGES, name, 'proposal.md'))
  return text === null ? '' : proposalTitle(text)
}

export function listChanges(root: string): IChangeInfo[] {
  return listActiveChanges(root).map((name) => {
    const dir = join(root, SPEC_CHANGES, name)
    const tierRaw = readYaml(join(dir, 'meta.yaml'))?.tier
    const jiraRaw = readYaml(join(dir, 'meta.yaml'))?.jira
    const groups = parseTasks(readText(join(dir, 'tasks.md')) ?? '')
    return {
      name,
      title: readProposalTitle(root, name),
      tier: typeof tierRaw === 'number' ? tierRaw : null,
      jira: typeof jiraRaw === 'string' ? jiraRaw : null,
      areas: toAreas(readYaml(join(dir, '.openspec.yaml'))?.affected_areas),
      groupKeys: Object.fromEntries(groups.filter((g) => g.key).map((g) => [g.repo, g.key as string])),
    }
  })
}

/** Change, в tasks.md которого есть группа с этим ключом: `## 2. client-fe (TN-130)`. */
export function findChangeByTaskKey(root: string, key: string): string | null {
  const wanted = key.toUpperCase()
  return listChanges(root).find((info) => Object.values(info.groupKeys).includes(wanted))?.name ?? null
}

/**
 * Какой change относится к этой ветке. Порядок, от надёжного к догадке:
 * выбор вручную → ключ подзадачи в tasks.md → имя change начинается с ключа ветки →
 * ветка меняет docs/changes/<change>/ (после первого /cex-sdd:apply).
 */
export function resolveChangeName(
  root: string,
  input: IResolveInput,
): { name: string; via: TResolvedVia } | null {
  const exists = (name: string): boolean => dirOf(root, name) !== null
  if (input.override && exists(input.override)) return { name: input.override, via: 'override' }
  if (input.key) {
    const byTaskKey = findChangeByTaskKey(root, input.key)
    if (byTaskKey) return { name: byTaskKey, via: 'task-key' }
    const prefix = changePrefix(input.key)
    const byPrefix = listActiveChanges(root).find((name) => name.startsWith(prefix))
    if (byPrefix) return { name: byPrefix, via: 'prefix' }
    // Архив: каталог называется `<дата>-tn-123-slug`.
    const archived = listDirs(join(root, SPEC_CHANGES, 'archive')).find((dir) => dir.includes(`-${prefix}`))
    if (archived) return { name: archived.slice(archived.indexOf(prefix)), via: 'prefix' }
  }
  const unique = [...new Set(input.branchChanges)]
  if (unique.length === 1 && exists(unique[0])) return { name: unique[0], via: 'branch-files' }
  return null
}

function dirOf(root: string, name: string): { specDir: string; archived: boolean } | null {
  if (listDirs(join(root, SPEC_CHANGES)).includes(name) && name !== 'archive') {
    return { specDir: join(SPEC_CHANGES, name), archived: false }
  }
  const archived = listDirs(join(root, SPEC_CHANGES, 'archive')).find((dir) => dir.endsWith(`-${name}`))
  return archived ? { specDir: join(SPEC_CHANGES, 'archive', archived), archived: true } : null
}

function parseAcceptance(text: string | null): IAcceptance {
  if (text === null) return { exists: false, accepted: false, build: null }
  const result = text.match(/\*\*Результат:\*\*\s*([^\n]+)/)?.[1]?.trim().toLowerCase() ?? ''
  const build = text.match(/\*\*Сборка:\*\*\s*(v\d+\.\d+\.\d+-rc\.\d+)/)?.[1] ?? null
  return { exists: true, accepted: result.startsWith('принято'), build }
}

export interface IReadStateInput {
  /** Ключ задачи разработчика (из ветки) или null — тогда берётся jira из meta.yaml. */
  key: string | null
  changeName: string | null
  /** design.md в origin/develop (план в кодовом репо); для плана в спеке не нужен. */
  designMerged: boolean | null
  /** Репозиторий этого проекта: по нему план в спеке лежит в plans/<repoId>/. */
  repoId?: TRepoId | null
  /** Настройка sddFlow.plansLocation: auto, code или spec. */
  plansSetting?: string
}

/** Каталог change в спеке (активный или в архиве) относительно корня проекта. */
export function changeSpecDir(root: string, changeName: string): string | null {
  return dirOf(root, changeName)?.specDir ?? null
}

/** План в спеке: openspec/changes/<change>/plans/<repoId>. */
export function specPlansDir(specDir: string, repoId: TRepoId): string {
  return join(specDir, 'plans', repoId)
}

/**
 * Где лежит план. Порядок: настройка sddFlow.plansLocation → `plans:` в .cex-sdd.yaml →
 * есть ли у change каталог plans/<repoId>/ в спеке → кодовый репо.
 * План в спеке без известного репозитория найти нельзя — тогда кодовый репо.
 */
export function resolvePlansLocation(
  root: string,
  specDir: string | null,
  repoId: TRepoId | null | undefined,
  setting = 'auto',
): TPlansLocation {
  if (!specDir || !repoId) return 'code'
  if (setting === 'code' || setting === 'spec') return setting
  const configured = readYaml(join(root, PROJECT_CONFIG_FILE))?.plans
  if (configured === 'code' || configured === 'spec') return configured
  return existsSync(join(root, specPlansDir(specDir, repoId))) ? 'spec' : 'code'
}

/** Читает с диска всё, что известно про change в этом проекте. */
export function readChangeState(root: string, input: IReadStateInput): IChangeState {
  const specsAvailable = existsSync(join(root, SPEC_CHANGES))
  const found = input.changeName ? dirOf(root, input.changeName) : null
  const specDir = found?.specDir ?? null
  const changeName = found ? input.changeName : null

  const plansLocation = resolvePlansLocation(root, specDir, input.repoId, input.plansSetting)
  let designDir: string | null
  let designRoot: string | null
  if (plansLocation === 'spec' && specDir && input.repoId) {
    designDir = specPlansDir(specDir, input.repoId)
    designRoot = existsSync(join(root, designDir)) ? join(root, designDir) : null
  } else {
    const designName = changeName ? (listDirs(join(root, DESIGN_CHANGES)).find((name) => name === changeName) ?? null) : null
    designDir = designName ? join(DESIGN_CHANGES, designName) : changeName ? join(DESIGN_CHANGES, changeName) : null
    designRoot = designName ? join(root, DESIGN_CHANGES, designName) : null
  }
  const hasDesign = designRoot !== null && existsSync(join(designRoot, 'design.md'))
  // План в спеке виден в сабмодуле только после мержа в main спек-репо: раз он есть — дизайн смержен.
  const designMerged = plansLocation === 'spec' ? (hasDesign ? true : null) : input.designMerged

  const meta = specDir ? readYaml(join(root, specDir, 'meta.yaml')) : null
  const jira = typeof meta?.jira === 'string' ? meta.jira : null
  const tier = typeof meta?.tier === 'number' ? meta.tier : null
  const areas = toAreas(specDir ? readYaml(join(root, specDir, '.openspec.yaml'))?.affected_areas : undefined)

  const tasksText = specDir ? readText(join(root, specDir, 'tasks.md')) : null
  const planText = designRoot ? readText(join(designRoot, 'plan.md')) : null
  const gapsText = designRoot ? readText(join(designRoot, 'spec-gaps.md')) : null
  const designText = designRoot ? readText(join(designRoot, 'design.md')) : null

  return {
    key: input.key ?? jira ?? '',
    jira,
    changeName,
    specsAvailable,
    archived: found?.archived ?? false,
    specDir,
    designDir,
    plansLocation,
    hasDesign,
    designMerged,
    affectedAreas: areas,
    tier,
    tasks: tasksText === null ? [] : parseTasks(tasksText),
    hasTasksFile: tasksText !== null,
    plan: planText === null ? null : parsePlan(planText),
    gaps: gapsText === null ? [] : parseSpecGaps(gapsText),
    acceptance: parseAcceptance(specDir ? readText(join(root, specDir, 'acceptance.md')) : null),
    tempMarkers: [],
    tempTableRows: designText === null ? null : countTempTableRows(designText),
  }
}
