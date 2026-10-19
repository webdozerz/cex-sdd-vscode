import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

import { detectRepoId, isRepoId, parseIssueKey } from './branch'
import { readChangeState, resolveChangeName } from './change'
import { buildFlow, noKeyActions, pluginBlockers } from './flow'
import type { IPluginStatus } from './plugin'
import { mergePlan, type IPlanSources } from './planmerge'
import type { ITempMarker, TFlowModel } from './types'

/** То, что можно узнать только у git: проект может подставить свою реализацию (в тестах — фальшивую). */
export interface IGitProbe {
  /** Changes, чьи docs/changes/<change>/ изменены веткой относительно develop или рабочим деревом. */
  branchChanges(): Promise<string[]>
  /** design.md этого change уже в origin/develop; null — не удалось определить. */
  isDesignMerged(change: string): Promise<boolean | null>
  /** plan.md change в origin/develop и в удалённых ветках с ключом задачи (кроме текущей). */
  planSources?(change: string, key: string | null, currentBranch: string | null): Promise<IPlanSources>
  /** Метки `sdd-temp(<KEY>)` в коде репозитория. */
  tempMarkers?(): Promise<ITempMarker[]>
  /** В ветке идёт работа: есть коммиты относительно origin/develop или изменённые отслеживаемые файлы. */
  isBranchActive?(): Promise<boolean>
}

export const NO_GIT: IGitProbe = {
  branchChanges: async () => [],
  isDesignMerged: async () => null,
}

export interface ILoadModelInput {
  root: string
  branch: string | null
  remoteUrl: string | null
  /** Значение настройки sddFlow.repoId: auto или id репозитория. */
  repoSetting: string
  /** Change, выбранный вручную или в мастере для этой ветки. */
  overrideChange: string | null
  git?: IGitProbe
  /** Состояние плагина cex-sdd (см. readPluginStatus); не задано — считается исправным. */
  plugin?: IPluginStatus
}

export async function loadFlowModel(input: ILoadModelInput): Promise<TFlowModel> {
  const git = input.git ?? NO_GIT
  const specsAvailable = existsSync(join(input.root, 'openspec', 'changes'))
  const branchKey = parseIssueKey(input.branch)

  const resolved = resolveChangeName(input.root, {
    key: branchKey,
    override: input.overrideChange,
    branchChanges: await git.branchChanges(),
  })
  if (!branchKey && !resolved) {
    return {
      kind: 'no-key',
      branch: input.branch,
      actions: noKeyActions(specsAvailable, input.plugin),
      blockers: pluginBlockers(input.plugin),
    }
  }

  const repoId = isRepoId(input.repoSetting)
    ? input.repoSetting
    : detectRepoId([input.remoteUrl, basename(input.root)])
  const state = readChangeState(input.root, {
    key: branchKey,
    changeName: resolved?.name ?? null,
    designMerged: resolved ? await git.isDesignMerged(resolved.name) : null,
  })
  if (state.plan && state.changeName && git.planSources) {
    const sources = await git.planSources(state.changeName, branchKey, input.branch)
    state.plan = mergePlan(state.plan, sources, state.designMerged, input.branch)
  }
  if (state.changeName && git.tempMarkers) {
    const own = new Set([state.key, state.jira].filter(Boolean).map((key) => String(key).toUpperCase()))
    state.tempMarkers = (await git.tempMarkers()).filter((marker) => own.has(marker.key))
  }
  // state.key — ключ разработчика из ветки (подзадача); если ветки с ключом нет, берётся jira из meta.yaml.
  const branchActive = branchKey && git.isBranchActive ? await git.isBranchActive() : false
  return buildFlow(state, { repoId, branch: input.branch, plugin: input.plugin, branchActive })
}
