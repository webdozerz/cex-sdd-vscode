import { describe, expect, it } from 'vitest'

import {
  buildBranchName,
  changePrefix,
  detectRepoId,
  isFixBranch,
  parseIssueKey,
  slugFromChange,
} from '../src/core/branch'
import { bumpSpecsCommand, initSpecsCommand, specSubmodulePath, verifyCommand } from '../src/core/repoinfo'
import { cleanupProjects, makeProject } from './fixtures'
import { afterEach } from 'vitest'

afterEach(cleanupProjects)

describe('parseIssueKey', () => {
  it.each([
    ['feat/TN-130-limits-form', 'TN-130'],
    ['TN-4521', 'TN-4521'],
    ['fix/ABC-7-buttons', 'ABC-7'],
    ['fix/ui-2-buttons', null],
    ['feat/limits-TN-12', null],
    ['develop', null],
  ])('%s → %s', (branch, expected) => {
    expect(parseIssueKey(branch)).toBe(expected)
  })

  it('возвращает null без ветки', () => {
    expect(parseIssueKey(null)).toBeNull()
  })
})

describe('имена', () => {
  it('префикс и slug change', () => {
    expect(changePrefix('TN-123')).toBe('tn-123-')
    expect(slugFromChange('tn-123-withdraw-limits')).toBe('withdraw-limits')
  })

  it('ветка по правилам процесса, с суффиксом для design PR', () => {
    expect(buildBranchName('TN-130', 'limits-form', false)).toBe('feat/TN-130-limits-form')
    expect(buildBranchName('tn-130', 'limits-form', true)).toBe('feat/TN-130-limits-form-design')
  })

  it('fix-ветки', () => {
    expect(isFixBranch('fix/TN-124-x')).toBe(true)
    expect(isFixBranch('feat/TN-124-x')).toBe(false)
    expect(isFixBranch(null)).toBe(false)
  })
})

describe('detectRepoId', () => {
  it.each([
    ['git@github.com:CryptoExch/client-frontend-v2.git', 'client-fe'],
    ['https://github.com/CryptoExch/admin-frontend-v2', 'admin-fe'],
    ['https://github.com/CryptoExch/exchange.git', 'exchange'],
    ['/Users/me/work/exchange', 'exchange'],
    ['https://github.com/CryptoExch/OpenSpec.git', null],
  ])('%s → %s', (hint, expected) => {
    expect(detectRepoId([hint])).toBe(expected)
  })

  it('берёт первую подсказку, которая что-то даёт', () => {
    expect(detectRepoId([null, 'Rao-Platform-v2', 'client-frontend-v2'])).toBe('client-fe')
  })
})

describe('сведения о репозитории', () => {
  it('путь сабмодуля из .gitmodules: фронт и exchange', () => {
    const front = makeProject({ '.gitmodules': '[submodule "vendor/openspec"]\n\tpath = vendor/openspec\n\turl = x\n' })
    const back = makeProject({ '.gitmodules': '[submodule "third_party/openspec"]\n\tpath = third_party/openspec\n' })
    expect(specSubmodulePath(front)).toBe('vendor/openspec')
    expect(specSubmodulePath(back)).toBe('third_party/openspec')
    expect(specSubmodulePath(makeProject({}))).toBe('vendor/openspec')
  })

  it('команды проверки и подключения спек по package.json', () => {
    const root = makeProject({
      'pnpm-lock.yaml': '',
      'package.json': JSON.stringify({ scripts: { verify: 'x', 'verify:fast': 'y', specs: 'z' } }),
    })
    expect(verifyCommand(root, false)).toBe('pnpm verify')
    expect(verifyCommand(root, true)).toBe('pnpm verify:fast')
    expect(initSpecsCommand(root)).toBe('pnpm specs')
    expect(bumpSpecsCommand(root)).toBe('git submodule update --remote vendor/openspec')
  })

  it('exchange без package.json: make verify и голый git', () => {
    const root = makeProject({
      Makefile: 'verify:\n',
      '.gitmodules': '[submodule "x"]\n\tpath = third_party/openspec\n',
    })
    expect(verifyCommand(root, false)).toBe('make verify')
    expect(verifyCommand(root, true)).toBeNull()
    expect(initSpecsCommand(root)).toBe('git submodule update --init third_party/openspec')
  })
})
