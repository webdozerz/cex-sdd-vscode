import { afterEach, describe, expect, it } from 'vitest'

import { compareVersions, readPluginStatus, MIN_PLUGIN_VERSION } from '../src/core/plugin'
import { loadFlowModel } from '../src/core/model'
import type { IPluginStatus } from '../src/core/plugin'

import { DESIGN_FILES, SPEC_FILES, cleanupProjects, makeProject } from './fixtures'

afterEach(cleanupProjects)

const PLUGINS = '.claude/plugins'
const INSTALLED = (version: string) =>
  JSON.stringify({ version: 2, plugins: { 'cex-sdd@crypton': [{ scope: 'user', version }] } })
const MARKETPLACES = JSON.stringify({ crypton: { source: { source: 'git' } } })
const ENABLED = (value: boolean) => JSON.stringify({ enabledPlugins: { 'cex-sdd@crypton': value } })

const status = (home: Record<string, string>, project: Record<string, string> = {}): IPluginStatus =>
  readPluginStatus(makeProject(home), makeProject(project))

describe('compareVersions', () => {
  it.each([
    ['0.6.0', '0.6.0', 0],
    ['0.5.0', '0.6.0', -1],
    ['0.10.0', '0.6.0', 1],
    ['1.0.0', '0.9.9', 1],
    ['0.6.0-rc.1', '0.6.0', 0],
  ])('%s vs %s', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign)
  })
})

describe('readPluginStatus', () => {
  it('установлен, включён, версия достаточная → ok', () => {
    const result = status({
      [`${PLUGINS}/installed_plugins.json`]: INSTALLED('0.7.0'),
      [`${PLUGINS}/known_marketplaces.json`]: MARKETPLACES,
      '.claude/settings.json': ENABLED(true),
    })
    expect(result).toEqual({ state: 'ok', version: '0.7.0', commands: [] })
  })

  it('плагин установлен, настройки про него молчат → ok', () => {
    const result = status({ [`${PLUGINS}/installed_plugins.json`]: INSTALLED('0.7.1') })
    expect(result.state).toBe('ok')
  })

  it('маркетплейса нет → нужны обе команды', () => {
    const result = status({ [`${PLUGINS}/installed_plugins.json`]: JSON.stringify({ version: 2, plugins: {} }) })
    expect(result.state).toBe('missing')
    expect(result.commands).toEqual([
      'claude plugin marketplace add git@github.com:CryptonStudio/AI-Marketplace.git',
      'claude plugin install cex-sdd@crypton',
    ])
  })

  it('маркетплейс есть, плагина нет → только install', () => {
    const result = status({
      [`${PLUGINS}/installed_plugins.json`]: JSON.stringify({ version: 2, plugins: {} }),
      [`${PLUGINS}/known_marketplaces.json`]: MARKETPLACES,
    })
    expect(result.commands).toEqual(['claude plugin install cex-sdd@crypton'])
  })

  it('версия ниже минимальной → outdated и команды обновления', () => {
    const result = status({
      [`${PLUGINS}/installed_plugins.json`]: INSTALLED('0.5.0'),
      [`${PLUGINS}/known_marketplaces.json`]: MARKETPLACES,
    })
    expect(result.state).toBe('outdated')
    expect(result.commands).toEqual(['claude plugin marketplace update crypton', 'claude plugin update cex-sdd@crypton'])
    expect(compareVersions(result.version ?? '', MIN_PLUGIN_VERSION)).toBeLessThan(0)
  })

  it('выключен в пользовательских настройках → disabled', () => {
    const result = status({ [`${PLUGINS}/installed_plugins.json`]: INSTALLED('0.7.0'), '.claude/settings.json': ENABLED(false) })
    expect(result).toMatchObject({ state: 'disabled', commands: ['claude plugin enable cex-sdd@crypton'] })
  })

  it('проектные настройки перекрывают пользовательские', () => {
    const home = { [`${PLUGINS}/installed_plugins.json`]: INSTALLED('0.7.0'), '.claude/settings.json': ENABLED(false) }
    expect(status(home, { '.claude/settings.json': ENABLED(true) }).state).toBe('ok')
    expect(
      status({ ...home, '.claude/settings.json': ENABLED(true) }, { '.claude/settings.local.json': ENABLED(false) }).state,
    ).toBe('disabled')
  })

  it('файлов плагинов нет совсем → плагин не установлен, нужны обе команды', () => {
    const result = status({})
    expect(result.state).toBe('missing')
    expect(result.commands).toHaveLength(2)
  })

  it('файл есть, но не разбирается → unknown, ничего не блокируем', () => {
    expect(status({ [`${PLUGINS}/installed_plugins.json`]: '{ не json' })).toEqual({
      state: 'unknown',
      version: null,
      commands: [],
    })
  })
})

describe('выбор установки как в Claude Code', () => {
  const project = '/home/dev/Projects/SE/exchange'
  const entries = (list: object[]) => JSON.stringify({ version: 2, plugins: { 'cex-sdd@crypton': list } })

  it('установка этого проекта важнее пользовательской и стоящей первой', () => {
    const home = makeProject({
      [`${PLUGINS}/installed_plugins.json`]: entries([
        { scope: 'user', version: '0.5.0' },
        { scope: 'project', projectPath: '/other/repo', version: '0.4.0' },
        { scope: 'project', projectPath: `${project}/`, version: '0.7.0' },
      ]),
    })
    expect(readPluginStatus(home, project)).toMatchObject({ state: 'ok', version: '0.7.0' })
  })

  it('чужой проект не учитывается: берётся пользовательская', () => {
    const home = makeProject({
      [`${PLUGINS}/installed_plugins.json`]: entries([
        { scope: 'project', projectPath: '/other/repo', version: '0.7.0' },
        { scope: 'user', version: '0.5.0' },
      ]),
    })
    expect(readPluginStatus(home, project)).toMatchObject({ state: 'outdated', version: '0.5.0' })
  })

  it('нет ни своей, ни пользовательской — самая свежая', () => {
    const home = makeProject({
      [`${PLUGINS}/installed_plugins.json`]: entries([
        { scope: 'local', projectPath: '/a', version: '0.5.0' },
        { scope: 'local', projectPath: '/b', version: '0.7.1' },
      ]),
    })
    expect(readPluginStatus(home, project)).toMatchObject({ state: 'ok', version: '0.7.1' })
  })
})

describe('плагин в ленте', () => {
  const missing: IPluginStatus = { state: 'missing', version: null, commands: ['claude plugin install cex-sdd@crypton'] }

  it('ветка без ключа: стоппер и главная кнопка установки', async () => {
    const model = await loadFlowModel({
      root: makeProject(SPEC_FILES),
      branch: 'develop',
      remoteUrl: null,
      repoSetting: 'auto',
      overrideChange: null,
      plugin: missing,
    })
    if (model.kind !== 'no-key') throw new Error('ожидался no-key')
    expect(model.blockers[0]).toMatchObject({ id: 'plugin-missing', severity: 'error' })
    expect(model.actions[0]).toEqual({ id: 'install-plugin', label: 'Установить плагин cex-sdd', primary: true })
    expect(model.actions.slice(1).every((action) => !action.primary)).toBe(true)
  })

  const loadChange = async (plugin: IPluginStatus) => {
    const model = await loadFlowModel({
      root: makeProject({ ...SPEC_FILES, ...DESIGN_FILES }),
      branch: 'feat/TN-130-limits-form',
      remoteUrl: null,
      repoSetting: 'client-fe',
      overrideChange: null,
      plugin,
    })
    if (model.kind !== 'change') throw new Error('ожидался change')
    return model
  }

  it('change: отсутствие плагина — первый стоппер и главная кнопка установки', async () => {
    const flow = await loadChange(missing)
    expect(flow.blockers[0].id).toBe('plugin-missing')
    expect(flow.next).toContain('Не установлен плагин')
    expect(flow.actions.filter((action) => action.primary).map((action) => action.id)).toEqual(['install-plugin'])
  })

  it('устаревший плагин — предупреждение и вторичная кнопка, основные кнопки не трогаем', async () => {
    const flow = await loadChange({ state: 'outdated', version: '0.5.0', commands: ['x'] })
    expect(flow.blockers.find((b) => b.id === 'plugin-outdated')).toMatchObject({ severity: 'warning' })
    const install = flow.actions.find((action) => action.id === 'install-plugin')
    expect(install).toEqual({ id: 'install-plugin', label: 'Обновить плагин cex-sdd' })
    expect(flow.actions.find((action) => action.id === 'continue')?.primary).toBe(true)
  })

  it('исправный или неизвестный плагин ничего не добавляет', async () => {
    for (const state of ['ok', 'unknown'] as const) {
      const flow = await loadChange({ state, version: null, commands: [] })
      expect(flow.blockers.some((b) => b.id.startsWith('plugin'))).toBe(false)
      expect(flow.actions.some((a) => a.id === 'install-plugin')).toBe(false)
    }
  })
})
