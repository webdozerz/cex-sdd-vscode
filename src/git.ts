import * as vscode from 'vscode'

/** Минимум публичного API расширения `vscode.git` (его типы не входят в @types/vscode). */
interface IGitRepository {
  readonly rootUri: vscode.Uri
  readonly state: {
    readonly HEAD?: { readonly name?: string }
    readonly remotes: ReadonlyArray<{ readonly name: string; readonly fetchUrl?: string }>
    readonly onDidChange: vscode.Event<void>
  }
}

interface IGitApi {
  readonly repositories: IGitRepository[]
  readonly onDidOpenRepository: vscode.Event<IGitRepository>
}

interface IGitExtension {
  getAPI(version: 1): IGitApi
}

export interface IGitInfo {
  branch: string | null
  remoteUrl: string | null
}

const REPOSITORY_WAIT_MS = 3_000

async function getGitApi(): Promise<IGitApi | null> {
  const extension = vscode.extensions.getExtension<IGitExtension>('vscode.git')
  if (!extension) return null
  const exports = extension.isActive ? extension.exports : await extension.activate()
  return exports.getAPI(1)
}

function findRepository(api: IGitApi, root: vscode.Uri): IGitRepository | undefined {
  return api.repositories.find((repository) => repository.rootUri.fsPath === root.fsPath)
}

function readInfo(repository: IGitRepository | undefined): IGitInfo {
  const remotes = repository?.state.remotes ?? []
  const origin = remotes.find((remote) => remote.name === 'origin') ?? remotes[0]
  return { branch: repository?.state.HEAD?.name ?? null, remoteUrl: origin?.fetchUrl ?? null }
}

export interface IGitWatcher extends vscode.Disposable {
  read(): IGitInfo
}

/** Следит за веткой корня проекта; `onChange` вызывается при смене ветки, коммитах и remote. */
export async function watchGit(root: vscode.Uri, onChange: () => void): Promise<IGitWatcher> {
  const api = await getGitApi()
  const disposables: vscode.Disposable[] = []
  let repository: IGitRepository | undefined

  const attach = (found: IGitRepository): void => {
    repository = found
    disposables.push(found.state.onDidChange(onChange))
    onChange()
  }

  if (api) {
    const deadline = Date.now() + REPOSITORY_WAIT_MS
    while (!findRepository(api, root) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    const found = findRepository(api, root)
    if (found) attach(found)
    else {
      disposables.push(
        api.onDidOpenRepository((opened) => {
          if (!repository && opened.rootUri.fsPath === root.fsPath) attach(opened)
        }),
      )
    }
  }

  return {
    read: () => readInfo(repository),
    dispose: () => disposables.forEach((disposable) => disposable.dispose()),
  }
}
