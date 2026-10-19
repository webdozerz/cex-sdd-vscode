import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

import * as vscode from 'vscode'

import { handleAction, installPlugin, pickChangeManually, startTask, type IActionDeps } from './actions'
import { detectRepoId, isRepoId } from './core/branch'
import { loadFlowModel } from './core/model'
import { readPluginStatus } from './core/plugin'
import type { TFlowModel } from './core/types'
import { watchGit } from './git'
import { createGitProbe } from './gitprobe'
import { FlowViewProvider } from './ui/FlowViewProvider'

const REFRESH_DEBOUNCE_MS = 300
const POLL_INTERVAL_MS = 30_000
const OVERRIDE_PREFIX = 'override:'

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]
  const root = folder?.uri.fsPath

  const openRelative = (location: string): void => {
    if (!root) return
    // «путь:строка» — метка sdd-temp: открываем файл на нужной строке.
    const withLine = location.match(/^(.*):(\d+)$/)
    const relativePath = withLine ? withLine[1] : location
    const line = withLine ? Number(withLine[2]) - 1 : null
    const target = resolve(root, relativePath)
    const inside = relative(root, target)
    if (inside.startsWith('..') || isAbsolute(inside)) return
    const uri = vscode.Uri.file(target)
    void vscode.workspace.fs.stat(uri).then(
      (stat) =>
        stat.type & vscode.FileType.Directory
          ? vscode.commands.executeCommand('revealInExplorer', uri)
          : line === null
            ? vscode.commands.executeCommand('vscode.open', uri)
            : vscode.window.showTextDocument(uri, { selection: new vscode.Range(line, 0, line, 0) }),
      () => vscode.window.showWarningMessage(`Файл не найден: ${relativePath}`),
    )
  }

  let git: Awaited<ReturnType<typeof watchGit>> | undefined
  let model: TFlowModel = { kind: 'no-workspace' }

  const deps: IActionDeps | undefined = root
    ? {
        root,
        probe: createGitProbe(root),
        getModel: () => model,
        getBranch: () => git?.read().branch ?? null,
        getRepoId: () => {
          const setting = vscode.workspace.getConfiguration('sddFlow').get<string>('repoId', 'auto')
          return isRepoId(setting) ? setting : detectRepoId([git?.read().remoteUrl, basename(root)])
        },
        remember: (branch, changeName) => context.workspaceState.update(`${OVERRIDE_PREFIX}${branch}`, changeName),
        refresh: () => void refresh(),
      }
    : undefined

  const provider = new FlowViewProvider(openRelative, (id) => {
    if (deps) void handleAction(deps, id)
  })
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
  statusBar.command = 'sddFlow.focus'
  context.subscriptions.push(
    statusBar,
    vscode.window.registerWebviewViewProvider(FlowViewProvider.viewType, provider),
  )

  const compute = async (): Promise<TFlowModel> => {
    if (!root) return { kind: 'no-workspace' }
    const info = git?.read() ?? { branch: null, remoteUrl: null }
    const overrideChange = info.branch
      ? (context.workspaceState.get<string>(`${OVERRIDE_PREFIX}${info.branch}`) ?? null)
      : null
    return loadFlowModel({
      root,
      branch: info.branch,
      remoteUrl: info.remoteUrl,
      repoSetting: vscode.workspace.getConfiguration('sddFlow').get<string>('repoId', 'auto'),
      overrideChange,
      git: createGitProbe(root),
      plugin: readPluginStatus(homedir(), root),
    })
  }

  const updateStatusBar = (next: TFlowModel): void => {
    if (next.kind !== 'change') {
      statusBar.hide()
      return
    }
    const errors = next.blockers.filter((blocker) => blocker.severity === 'error').length
    const warnings = next.blockers.filter((blocker) => blocker.severity === 'warning').length
    const marks = [errors ? `$(error) ${errors}` : '', warnings ? `$(warning) ${warnings}` : '']
      .filter(Boolean)
      .join(' ')
    statusBar.text = `$(git-branch) ${next.key || 'SDD'}${marks ? ` ${marks}` : ' $(check)'}`
    statusBar.tooltip = next.next ?? 'SDD Flow'
    statusBar.show()
  }

  async function refresh(): Promise<void> {
    model = await compute()
    provider.update(model)
    updateStatusBar(model)
  }

  let timer: NodeJS.Timeout | undefined
  const scheduleRefresh = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => void refresh(), REFRESH_DEBOUNCE_MS)
  }

  if (folder) {
    git = await watchGit(folder.uri, scheduleRefresh)
    context.subscriptions.push(git)

    for (const pattern of ['docs/changes/**', 'openspec/changes/**']) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern))
      watcher.onDidCreate(scheduleRefresh)
      watcher.onDidChange(scheduleRefresh)
      watcher.onDidDelete(scheduleRefresh)
      context.subscriptions.push(watcher)
    }
    // Установка или обновление плагина cex-sdd в терминале: панель обновляется сразу, а не по опросу.
    const pluginsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(join(homedir(), '.claude', 'plugins')), 'installed_plugins.json'),
    )
    pluginsWatcher.onDidCreate(scheduleRefresh)
    pluginsWatcher.onDidChange(scheduleRefresh)
    context.subscriptions.push(pluginsWatcher)

    // Сабмодуль и origin/develop обновляются через git, а не через редактор: события файлов могут не прийти.
    const poll = setInterval(scheduleRefresh, POLL_INTERVAL_MS)
    context.subscriptions.push({ dispose: () => clearInterval(poll) })
  }

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) scheduleRefresh()
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('sddFlow')) scheduleRefresh()
    }),
    vscode.commands.registerCommand('sddFlow.refresh', () => refresh()),
    vscode.commands.registerCommand('sddFlow.focus', () =>
      vscode.commands.executeCommand(`${FlowViewProvider.viewType}.focus`),
    ),
    vscode.commands.registerCommand('sddFlow.start', () => deps && startTask(deps)),
    vscode.commands.registerCommand('sddFlow.pickChange', () => deps && pickChangeManually(deps)),
    vscode.commands.registerCommand('sddFlow.installPlugin', () => deps && installPlugin(deps)),
    vscode.commands.registerCommand('sddFlow.continue', () => deps && handleAction(deps, 'continue')),
    vscode.commands.registerCommand('sddFlow.specGap', () => deps && handleAction(deps, 'spec-gap')),
    vscode.commands.registerCommand('sddFlow.verify', () => deps && handleAction(deps, 'verify')),
    vscode.commands.registerCommand('sddFlow.verifyFast', () => deps && handleAction(deps, 'verify-fast')),
    vscode.commands.registerCommand('sddFlow.resetChange', async () => {
      const branch = git?.read().branch
      if (branch) await context.workspaceState.update(`${OVERRIDE_PREFIX}${branch}`, undefined)
      await refresh()
    }),
  )

  await refresh()
}

export function deactivate(): void {}
