import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import * as vscode from 'vscode'

import { buildBranchName, slugFromChange } from './core/branch'
import { listChanges, type IChangeInfo } from './core/change'
import type { IGitProbe } from './core/model'
import { PLUGIN_ID, readPluginStatus } from './core/plugin'
import { bumpSpecsCommand, initSpecsCommand, specRepoUrl, specSubmodulePath, verifyCommand } from './core/repoinfo'
import { buildSpecPrPrompt } from './core/specpr'
import type { TActionId, TFlowModel, TRepoId } from './core/types'
import { git, inspectSpecs } from './gitprobe'

const CLAUDE_OPEN_COMMAND = 'claude-vscode.primaryEditor.open'
const TERMINAL_NAME = 'SDD Flow'

export interface IActionDeps {
  root: string
  probe: IGitProbe
  getModel(): TFlowModel
  getBranch(): string | null
  getRepoId(): TRepoId | null
  /** Запоминает выбранный change для ветки. */
  remember(branch: string, changeName: string): Thenable<void>
  refresh(): void
}

function runInTerminal(root: string, command: string): void {
  const terminal =
    vscode.window.terminals.find((item) => item.name === TERMINAL_NAME && item.exitStatus === undefined) ??
    vscode.window.createTerminal({ name: TERMINAL_NAME, cwd: root })
  terminal.show()
  terminal.sendText(command)
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Передаёт запрос в Claude Code: через его команду, а если её нет — через `claude` в терминале. */
async function openClaude(root: string, prompt: string): Promise<void> {
  await vscode.env.clipboard.writeText(prompt)
  const commands = await vscode.commands.getCommands(true)
  if (commands.includes(CLAUDE_OPEN_COMMAND)) {
    await vscode.commands.executeCommand(CLAUDE_OPEN_COMMAND, undefined, prompt)
    void vscode.window.showInformationMessage(
      'Запрос передан в Claude Code. Если он не отправился сам, он скопирован в буфер: вставьте и отправьте.',
    )
    return
  }
  runInTerminal(root, `claude ${shellQuote(prompt)}`)
}

/** Установка, включение или обновление плагина cex-sdd: команды из состояния плагина, в терминале и после подтверждения. */
export async function installPlugin(deps: IActionDeps): Promise<void> {
  const status = readPluginStatus(homedir(), deps.root)
  if (status.commands.length === 0) {
    void vscode.window.showInformationMessage(
      status.state === 'ok'
        ? `Плагин ${PLUGIN_ID}${status.version ? ` ${status.version}` : ''} установлен и включён.`
        : 'Не удалось определить состояние плагина: проверьте командой claude plugin list.',
    )
    return
  }
  const confirm = await vscode.window.showInformationMessage(
    'Выполнить в терминале?',
    {
      modal: true,
      detail: `${status.commands.join('\n')}\n\nПлагин ставится на уровне пользователя и добавляет хук, который блокирует запись в сабмодуль спек. После установки перезагрузите окно (Developer: Reload Window).`,
    },
    'Выполнить',
  )
  if (confirm) runInTerminal(deps.root, status.commands.join(' && '))
}

/** Перед командами /cex-sdd:*: без плагина они не существуют. false — запуск отменён. */
async function ensurePlugin(deps: IActionDeps): Promise<boolean> {
  const status = readPluginStatus(homedir(), deps.root)
  if (status.state !== 'missing' && status.state !== 'disabled') return true
  const verb = status.state === 'missing' ? 'Установить' : 'Включить'
  const choice = await vscode.window.showWarningMessage(
    `Плагин cex-sdd ${status.state === 'missing' ? 'не установлен' : 'отключён'}: без него нет команд /cex-sdd:apply и /cex-sdd:spec-gap.`,
    verb,
  )
  if (choice) await installPlugin(deps)
  return false
}

/** `/cex-sdd:apply <change>`; если ключ разработчика отличается от ключа change, просит агента использовать его. */
export function buildApplyPrompt(change: string, key: string, jira: string | null): string {
  const base = `/cex-sdd:apply ${change}`
  return key && jira && key.toUpperCase() !== jira.toUpperCase()
    ? `${base} Ключ моей задачи — ${key} (подзадача, родитель ${jira}): используй ${key} в имени ветки, коммитах и заголовке PR.`
    : base
}

const BUMP_LABEL = 'Обновить спеки'

/**
 * В подключённой спеке нет активных changes. Совет зависит от причины: кнопка «Обновить спеки»
 * показывается, только если в свежем main OpenSpec change есть (или это не удалось проверить).
 * Если их нет и там, обновлять нечего: change появится после Gate 1.
 */
async function explainNoChanges(deps: IActionDeps): Promise<void> {
  const status = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Сверяю спеки с main OpenSpec' },
    () => inspectSpecs(deps.root, specSubmodulePath(deps.root)),
  )
  if (status && !status.latestHasChanges) {
    void vscode.window.showInformationMessage(
      'В main OpenSpec сейчас нет активных changes, обновление спек ничего не добавит. Change появится после того, как аналитик пройдёт Gate 1 и смержит его.',
    )
    return
  }
  const text = status
    ? 'В подключённой спеке нет активных changes, а в main OpenSpec они уже есть: указатель сабмодуля устарел.'
    : 'В подключённой спеке нет активных changes. Не удалось сверить с main OpenSpec (сеть или доступ): возможно, указатель устарел.'
  const choice = await vscode.window.showWarningMessage(text, BUMP_LABEL)
  if (choice === BUMP_LABEL) await bumpSpecs(deps)
}

const LOCK_RETRIES = 5
const LOCK_RETRY_DELAY_MS = 400

/**
 * Git-команда, которая повторяется, пока index.lock держит другой процесс
 * (встроенный git VS Code, фоновое обновление панели). Остальные ошибки пробрасываются сразу.
 */
async function gitWithLockRetry(root: string, args: string[]): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await git(root, args)
    } catch (error) {
      const isLockBusy = (error as Error).message.includes('index.lock')
      if (!isLockBusy || attempt >= LOCK_RETRIES) throw error
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS))
    }
  }
}

async function pickChange(deps: IActionDeps, placeHolder: string): Promise<IChangeInfo | undefined> {
  if (!existsSync(join(deps.root, 'openspec', 'changes'))) {
    const choice = await vscode.window.showWarningMessage('Спека не подключена.', 'Подключить спеки')
    if (choice) await initSpecs(deps)
    return undefined
  }
  const repo = deps.getRepoId()
  const infos = listChanges(deps.root).sort((a, b) => Number(repo !== null && b.areas.includes(repo)) - Number(repo !== null && a.areas.includes(repo)))
  if (infos.length === 0) {
    await explainNoChanges(deps)
    return undefined
  }
  const picked = await vscode.window.showQuickPick(
    infos.map((info) => ({
      label: info.name,
      description: `tier ${info.tier ?? '?'} · ${info.areas.join(', ') || 'области не указаны'}`,
      detail: info.title || undefined,
      info,
    })),
    { placeHolder, matchOnDescription: true, matchOnDetail: true },
  )
  return picked?.info
}

export async function pickChangeManually(deps: IActionDeps): Promise<void> {
  const branch = deps.getBranch()
  if (!branch) {
    void vscode.window.showWarningMessage('Не удалось определить ветку.')
    return
  }
  const info = await pickChange(deps, 'Какой change относится к этой ветке')
  if (!info) return
  await deps.remember(branch, info.name)
  deps.refresh()
}

/** Мастер: выбрать change → ключ → slug → создать ветку от origin/develop → запустить /cex-sdd:apply. */
export async function startTask(deps: IActionDeps): Promise<void> {
  if (!(await ensurePlugin(deps))) return
  const info = await pickChange(deps, 'Какой change реализуем?')
  if (!info) return

  const repo = deps.getRepoId()
  const suggestedKey = (repo && info.groupKeys[repo]) || info.jira || ''
  const key = await vscode.window.showInputBox({
    title: 'Ключ вашей задачи Jira',
    prompt: 'Он пойдёт в имя ветки, коммиты и заголовок PR. Подзадача или родитель, как принято у вас.',
    value: suggestedKey,
    validateInput: (value) => (/^[A-Z][A-Z0-9]+-\d+$/i.test(value.trim()) ? null : 'Формат: TN-123'),
  })
  if (!key) return

  const slug = await vscode.window.showInputBox({
    title: 'Короткое имя ветки (slug)',
    value: slugFromChange(info.name),
    validateInput: (value) => (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value) ? null : 'Латиница, цифры и дефисы: limits-form'),
  })
  if (!slug) return

  const designMerged = await deps.probe.isDesignMerged(info.name)
  const design = (info.tier === 1 || info.tier === 2) && designMerged !== true
  const branch = buildBranchName(key.trim(), slug, design)

  const confirm = await vscode.window.showInformationMessage(
    `Создать ветку ${branch} от origin/develop и запустить /cex-sdd:apply ${info.name}?`,
    {
      modal: true,
      detail: design
        ? `Tier ${info.tier}: сначала design.md и plan.md отдельным PR, код после его мержа.`
        : 'Дизайн, план и код пойдут в этой ветке.',
    },
    'Создать и запустить',
  )
  if (!confirm) return

  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Создаю ${branch}` }, async () => {
      await git(deps.root, ['fetch', 'origin'])
      await gitWithLockRetry(deps.root, ['switch', '-c', branch, '--no-track', 'origin/develop'])
    })
  } catch (error) {
    void vscode.window.showErrorMessage(`Не удалось создать ветку: ${(error as Error).message}`)
    return
  }
  await deps.remember(branch, info.name)
  deps.refresh()
  await openClaude(deps.root, buildApplyPrompt(info.name, key.trim().toUpperCase(), info.jira))
}

/** Продолжить change: тот же /cex-sdd:apply, агент сам смотрит на состояние (дизайн, план, код). */
export async function continueChange(deps: IActionDeps): Promise<void> {
  if (!(await ensurePlugin(deps))) return
  const model = deps.getModel()
  if (model.kind !== 'change' || !model.changeName) {
    void vscode.window.showWarningMessage('Сначала выберите change.')
    return
  }
  await openClaude(deps.root, buildApplyPrompt(model.changeName, model.key, model.jira))
}

const VULNERABILITY_DETAIL =
  'Если расхождение даёт обход 2FA или прав, создание или потерю денег, доступ к чужим данным или подделку подписи — не описывайте его ни здесь, ни в репозитории, PR и Jira. Передайте лично CTO и техлиду бэка.'

/**
 * Расхождение со спекой. Описание уходит только в запрос к Claude Code и нигде не сохраняется:
 * по правилам процесса уязвимости нельзя записывать в репозиторий, PR и Jira.
 */
export async function reportSpecGap(deps: IActionDeps): Promise<void> {
  if (!(await ensurePlugin(deps))) return
  const model = deps.getModel()
  if (model.kind !== 'change' || !model.changeName) {
    void vscode.window.showWarningMessage('Сначала выберите change.')
    return
  }
  const confirm = await vscode.window.showWarningMessage(
    'Это не уязвимость?',
    {
      modal: true,
      detail: VULNERABILITY_DETAIL,
    },
    'Не уязвимость, продолжить',
  )
  if (!confirm) return
  const description = await vscode.window.showInputBox({
    title: 'Что не сходится',
    prompt: 'Коротко: где спека неполная или противоречит коду. Агент оформит запись в spec-gaps.md.',
  })
  if (!description?.trim()) return
  await openClaude(deps.root, `/cex-sdd:spec-gap ${description.trim()}`)
}

/**
 * PR в репозиторий спек с правкой change по записи spec-gaps.md. Расширение ничего не пушит само:
 * запрос уходит в Claude Code, агент готовит правку в отдельном клоне и ждёт подтверждения на push и PR.
 */
export async function proposeSpecPr(deps: IActionDeps): Promise<void> {
  const model = deps.getModel()
  if (model.kind !== 'change' || !model.changeName || !model.plansDir) {
    void vscode.window.showWarningMessage('Сначала выберите change.')
    return
  }
  const candidates = model.specPrCandidates
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage('Нет расхождений, по которым нужен PR с правкой спеки: у всех есть PR или правка не нужна.')
    return
  }
  const gap =
    candidates.length === 1
      ? candidates[0]
      : (
          await vscode.window.showQuickPick(
            candidates.map((item) => ({ label: `№${item.n}. ${item.title}`, item })),
            { placeHolder: 'По какому расхождению подготовить PR в спеку' },
          )
        )?.item
  if (!gap) return

  const confirm = await vscode.window.showInformationMessage(
    `Подготовить PR в репозиторий спек по расхождению №${gap.n}?`,
    {
      modal: true,
      detail: `Claude Code подготовит правку change ${model.changeName} в отдельном клоне репозитория спек (сабмодуль не трогается), прогонит проверки спек и покажет diff. Push и PR — только после вашего подтверждения. PR — предложение: решают аналитик и тимлид.\n\n${VULNERABILITY_DETAIL}`,
    },
    'Подготовить',
  )
  if (!confirm) return
  const variant = await vscode.window.showInputBox({
    title: 'Какой вариант из записи взять за основу',
    prompt: 'Номер или текст варианта. Пусто — рекомендованный в записи или решение тимлида.',
  })
  if (variant === undefined) return

  await openClaude(
    deps.root,
    buildSpecPrPrompt({
      change: model.changeName,
      key: model.key,
      gap,
      gapsFile: `${model.plansDir}/spec-gaps.md`,
      submodulePath: specSubmodulePath(deps.root),
      specRepoUrl: specRepoUrl(deps.root),
      plansLocation: model.plansLocation,
      repoId: model.repoId,
      variant,
    }),
  )
}

export async function runVerify(deps: IActionDeps, fast: boolean): Promise<void> {
  const command = verifyCommand(deps.root, fast)
  if (!command) {
    void vscode.window.showWarningMessage(`В проекте нет команды ${fast ? 'verify:fast' : 'verify'}.`)
    return
  }
  runInTerminal(deps.root, command)
}

export async function initSpecs(deps: IActionDeps): Promise<void> {
  runInTerminal(deps.root, initSpecsCommand(deps.root))
}

export async function bumpSpecs(deps: IActionDeps): Promise<void> {
  const confirm = await vscode.window.showInformationMessage(
    'Обновить указатель сабмодуля спек до свежего main OpenSpec?',
    {
      modal: true,
      detail:
        'По правилам процесса указатель обновляется отдельным коммитом chore(TN-…): bump openspec, который мержится в develop до начала работы. Не смешивайте его с кодом.',
    },
    'Обновить',
  )
  if (confirm) runInTerminal(deps.root, bumpSpecsCommand(deps.root))
}

export function handleAction(deps: IActionDeps, id: TActionId): Promise<void> {
  switch (id) {
    case 'init-specs':
      return initSpecs(deps)
    case 'bump-specs':
      return bumpSpecs(deps)
    case 'start':
      return startTask(deps)
    case 'continue':
      return continueChange(deps)
    case 'spec-gap':
      return reportSpecGap(deps)
    case 'spec-pr':
      return proposeSpecPr(deps)
    case 'verify':
      return runVerify(deps, false)
    case 'verify-fast':
      return runVerify(deps, true)
    case 'pick-change':
      return pickChangeManually(deps)
    case 'install-plugin':
      return installPlugin(deps)
  }
}
