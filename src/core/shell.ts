/** Оболочка терминала VS Code: от неё зависят кавычки и склейка команд. */
export type TShellKind = 'posix' | 'powershell' | 'cmd'

/**
 * Вид оболочки по пути из `vscode.env.shell`. Пусто на Windows — PowerShell, оболочка по умолчанию.
 * Git Bash, WSL и прочие bash/zsh/fish — posix.
 */
export function detectShellKind(shellPath: string, platform: string): TShellKind {
  const name = shellPath.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (/^(pwsh|powershell)(\.exe)?$/.test(name)) return 'powershell'
  if (/^cmd(\.exe)?$/.test(name)) return 'cmd'
  if (!name && platform === 'win32') return 'powershell'
  return 'posix'
}

/**
 * Аргумент в одинарных кавычках. PowerShell считает кавычками и типографские ‘ ’ ‚ ‛, внутри строки они удваиваются.
 * Для cmd надёжного экранирования нет (% и ^ раскрываются даже в кавычках): null.
 */
export function shellQuote(value: string, kind: TShellKind): string | null {
  switch (kind) {
    case 'posix':
      return `'${value.replace(/'/g, `'\\''`)}'`
    case 'powershell':
      return `'${value.replace(/['‘’‚‛]/g, '$&$&')}'`
    case 'cmd':
      return null
  }
}

/** Команды по очереди, каждая — только если предыдущая успешна. В Windows PowerShell 5.1 нет `&&`. */
export function chainCommands(commands: string[], kind: TShellKind): string {
  if (kind !== 'powershell') return commands.join(' && ')
  return commands.reduceRight((rest, command) => (rest ? `${command}; if ($?) { ${rest} }` : command), '')
}
