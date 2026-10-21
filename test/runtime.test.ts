import { describe, expect, it } from 'vitest'

import { createTtlCache } from '../src/core/cache'
import { createSerialRunner } from '../src/core/serial'
import { chainCommands, detectShellKind, shellQuote } from '../src/core/shell'

describe('detectShellKind', () => {
  it.each([
    ['/bin/zsh', 'darwin', 'posix'],
    ['C:\\Program Files\\Git\\bin\\bash.exe', 'win32', 'posix'],
    ['C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'win32', 'powershell'],
    ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32', 'powershell'],
    ['/usr/local/bin/pwsh', 'darwin', 'powershell'],
    ['C:\\WINDOWS\\System32\\cmd.exe', 'win32', 'cmd'],
    ['', 'win32', 'powershell'],
    ['', 'linux', 'posix'],
  ])('%s (%s) → %s', (shell, platform, kind) => {
    expect(detectShellKind(shell, platform)).toBe(kind)
  })
})

describe('shellQuote', () => {
  it('posix: апостроф закрывает и снова открывает кавычки', () => {
    expect(shellQuote(`it's`, 'posix')).toBe(`'it'\\''s'`)
  })

  it('powershell: апострофы, в том числе типографские, удваиваются', () => {
    expect(shellQuote(`it's ‘x’ $env:HOME`, 'powershell')).toBe(`'it''s ‘‘x’’ $env:HOME'`)
  })

  it('cmd: экранирования нет', () => {
    expect(shellQuote('x', 'cmd')).toBeNull()
  })
})

describe('chainCommands', () => {
  const commands = ['a', 'b', 'c']

  it('posix и cmd — через &&', () => {
    expect(chainCommands(commands, 'posix')).toBe('a && b && c')
    expect(chainCommands(commands, 'cmd')).toBe('a && b && c')
  })

  it('powershell — через $?, без && (нет в 5.1)', () => {
    expect(chainCommands(commands, 'powershell')).toBe('a; if ($?) { b; if ($?) { c } }')
    expect(chainCommands(['a'], 'powershell')).toBe('a')
  })
})

describe('createSerialRunner', () => {
  it('вызовы во время запуска не идут параллельно, а сводятся в один повтор', async () => {
    let active = 0
    let maxActive = 0
    let runs = 0
    const release: Array<() => void> = []
    const run = createSerialRunner(async () => {
      runs += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>((resolve) => release.push(resolve))
      active -= 1
    })

    const first = run()
    const second = run()
    const third = run()
    expect(second).toBe(first)
    expect(third).toBe(first)

    release.shift()?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    release.shift()?.()
    await first

    expect(runs).toBe(2)
    expect(maxActive).toBe(1)
  })

  it('после ошибки следующий вызов запускается заново', async () => {
    let calls = 0
    const run = createSerialRunner(async () => {
      calls += 1
      if (calls === 1) throw new Error('boom')
    })
    await expect(run()).rejects.toThrow('boom')
    await run()
    expect(calls).toBe(2)
  })
})

describe('createTtlCache', () => {
  it('отдаёт кэш, пока он свежий, и одну загрузку на одновременные запросы', async () => {
    let time = 0
    let loads = 0
    const cache = createTtlCache<number>(100, () => time)
    const load = async (): Promise<number> => ++loads

    const [a, b] = await Promise.all([cache.get('k', load), cache.get('k', load)])
    expect([a, b, loads]).toEqual([1, 1, 1])

    time = 99
    expect(await cache.get('k', load)).toBe(1)
    time = 100
    expect(await cache.get('k', load)).toBe(2)

    cache.clear()
    expect(await cache.get('k', load)).toBe(3)
    expect(await cache.get('other', load)).toBe(4)
  })

  it('ошибка загрузки не кэшируется', async () => {
    const cache = createTtlCache<number>(1000, () => 0)
    await expect(cache.get('k', async () => Promise.reject(new Error('net')))).rejects.toThrow('net')
    expect(await cache.get('k', async () => 7)).toBe(7)
  })
})
