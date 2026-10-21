import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const PLUGIN_NAME = 'cex-sdd'
export const MARKETPLACE_NAME = 'crypton'
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`
export const MARKETPLACE_SOURCE = 'git@github.com:CryptonStudio/AI-Marketplace.git'

/** С 0.6.0 `/cex-sdd:apply` берёт ключ подзадачи, с 0.7.0 есть `/cex-sdd:spec-update`. */
export const MIN_PLUGIN_VERSION = '0.7.0'

export type TPluginState =
  /** Установлен, включён, версия не ниже минимальной. */
  | 'ok'
  | 'missing'
  | 'disabled'
  | 'outdated'
  /** Состояние не удалось прочитать: ничего не блокируем. */
  | 'unknown'

export interface IPluginStatus {
  state: TPluginState
  version: string | null
  /** Команды, которые приводят плагин в порядок; пусто для ok и unknown. */
  commands: string[]
}

export const PLUGIN_OK: IPluginStatus = { state: 'ok', version: null, commands: [] }

const BROKEN = Symbol('broken')

/** Содержимое JSON-файла; undefined — файла нет; BROKEN — файл есть, но не разбирается. */
function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return BROKEN
  }
}

/** Сравнение версий вида 0.6.0; нечисловые части считаются нулями. */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string): number[] => version.split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0)
  const [left, right] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Значение `enabledPlugins[PLUGIN_ID]` в файле настроек: true, false или undefined (не упомянут).
 * Проектные настройки перекрывают пользовательские, поэтому читаем от общих к частным.
 */
function enabledIn(path: string): boolean | undefined {
  const raw = readJson(path)
  const settings = raw === BROKEN ? undefined : (raw as { enabledPlugins?: Record<string, unknown> } | undefined)
  const value = settings?.enabledPlugins?.[PLUGIN_ID]
  return typeof value === 'boolean' ? value : undefined
}

interface IInstallEntry {
  scope?: string
  projectPath?: string
  version?: string
}

function samePath(a: string, b: string): boolean {
  return resolve(a).replace(/[\\/]+$/, '') === resolve(b).replace(/[\\/]+$/, '')
}

/**
 * Какая из установок плагина действует в этом проекте — так же, как выбирает сам Claude Code:
 * установка для этого проекта (scope project/local с projectPath), иначе пользовательская,
 * иначе самая свежая из остальных.
 */
export function pickInstallEntry(entries: IInstallEntry[], projectRoot: string): IInstallEntry | undefined {
  return (
    entries.find((entry) => entry.projectPath !== undefined && samePath(entry.projectPath, projectRoot)) ??
    entries.find((entry) => entry.scope === 'user') ??
    [...entries].sort((a, b) => compareVersions(b.version ?? '0', a.version ?? '0'))[0]
  )
}

function installCommands(marketplaceKnown: boolean): string[] {
  return marketplaceKnown
    ? [`claude plugin install ${PLUGIN_ID}`]
    : [`claude plugin marketplace add ${MARKETPLACE_SOURCE}`, `claude plugin install ${PLUGIN_ID}`]
}

/**
 * Состояние плагина cex-sdd по файлам Claude Code: `~/.claude/plugins/installed_plugins.json`,
 * `known_marketplaces.json` и `enabledPlugins` в настройках (пользовательских и проектных).
 * Запуск CLI не нужен: в VS Code `claude` может отсутствовать в PATH.
 */
export function readPluginStatus(home: string, projectRoot: string): IPluginStatus {
  const pluginsDir = join(home, '.claude', 'plugins')
  const installedRaw = readJson(join(pluginsDir, 'installed_plugins.json'))
  const knownRaw = readJson(join(pluginsDir, 'known_marketplaces.json'))

  // Файл есть, но не разбирается (формат мог измениться): не гадаем и ничего не блокируем.
  if (installedRaw === BROKEN || knownRaw === BROKEN) return { state: 'unknown', version: null, commands: [] }

  // Файлов нет совсем — плагины ещё ни разу не ставились: значит, и cex-sdd нет.
  const installed = installedRaw as { plugins?: Record<string, IInstallEntry[]> } | undefined
  const known = knownRaw as Record<string, unknown> | undefined
  const entry = pickInstallEntry(installed?.plugins?.[PLUGIN_ID] ?? [], projectRoot)
  if (!entry) {
    return { state: 'missing', version: null, commands: installCommands(Boolean(known && MARKETPLACE_NAME in known)) }
  }

  const version = typeof entry.version === 'string' ? entry.version : null
  const enabled = [
    join(home, '.claude', 'settings.json'),
    join(projectRoot, '.claude', 'settings.json'),
    join(projectRoot, '.claude', 'settings.local.json'),
  ].reduce<boolean | undefined>((current, path) => enabledIn(path) ?? current, undefined)
  if (enabled === false) return { state: 'disabled', version, commands: [`claude plugin enable ${PLUGIN_ID}`] }

  if (version && compareVersions(version, MIN_PLUGIN_VERSION) < 0) {
    return {
      state: 'outdated',
      version,
      commands: [`claude plugin marketplace update ${MARKETPLACE_NAME}`, `claude plugin update ${PLUGIN_ID}`],
    }
  }
  return { state: 'ok', version, commands: [] }
}
