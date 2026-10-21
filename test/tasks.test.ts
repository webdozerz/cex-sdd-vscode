import { describe, expect, it } from 'vitest'

import { proposalTitle } from '../src/core/change'
import { parsePlan, parseSpecGaps, specUpdateGaps } from '../src/core/plan'
import { parseTasks } from '../src/core/tasks'

const SAMPLE = `# Tasks

## 1. exchange

- [x] 1.1 Лимиты вывода в API — проверка: scenario A
- [ ] 1.2 Хранение лимитов — проверка: интеграционный тест

## 2. client-fe (TN-130)

Зависимость: стартует от contract/openapi.yaml

- [x] 2.1 Форма вывода — проверка: journey
- [X] 2.2 Тексты ошибок — проверка: e2e
- [ ] 2.3 Состояние «лимит исчерпан» — проверка: scenario B

## Проверка после развёртывания

- Проверить лимиты на stage — QA, TN-130
`

describe('parseTasks', () => {
  const groups = parseTasks(SAMPLE)

  it('находит группы по репозиториям и пропускает пост-деплой', () => {
    expect(groups.map((group) => group.repo)).toEqual(['exchange', 'client-fe'])
  })

  it('читает ключ подзадачи из заголовка группы', () => {
    expect(groups.map((group) => group.key)).toEqual([null, 'TN-130'])
  })

  it('читает состояние чекбоксов и номера', () => {
    expect(groups[0].items).toEqual([
      { id: '1.1', text: 'Лимиты вывода в API — проверка: scenario A', done: true },
      { id: '1.2', text: 'Хранение лимитов — проверка: интеграционный тест', done: false },
    ])
    expect(groups[1].items.map((item) => item.done)).toEqual([true, true, false])
  })

  it('нумерует задачи без явного номера', () => {
    const [group] = parseTasks('## 1. admin-fe\n\n- [ ] первая\n- [x] вторая\n')
    expect(group.items.map((item) => item.id)).toEqual(['1.1', '1.2'])
  })

  it('возвращает пустой список для пустого файла', () => {
    expect(parseTasks('')).toEqual([])
  })
})

describe('parsePlan', () => {
  const plan = parsePlan(`# План: tn-123 (client-fe)

## tasks.md 2.1 — Форма — готово
- [x] Каркас — проверка: vitest
- [x] Валидация — проверка: vitest

## tasks.md 2.2 — Ошибки
- [x] Тексты — проверка: e2e
- [ ] Состояния — проверка: e2e
`)

  it('считает шаги и убирает пометку «готово» из названия', () => {
    expect(plan.total).toBe(4)
    expect(plan.done).toBe(3)
    expect(plan.tasks.map((task) => [task.id, task.title])).toEqual([
      ['2.1', 'Форма'],
      ['2.2', 'Ошибки'],
    ])
  })

  it('шаги без заголовка задачи не теряются', () => {
    const loose = parsePlan('- [ ] что-то\n- [x] ещё')
    expect(loose.total).toBe(2)
    expect(loose.done).toBe(1)
  })

  it('пустой plan.md — ноль шагов', () => {
    expect(parsePlan('')).toEqual({ tasks: [], total: 0, done: 0 })
  })
})

describe('proposalTitle', () => {
  it('голый заголовок «Proposal» — первая фраза из «Why»', () => {
    const md = '# Proposal\n\nJira: TN-1\n\n## Why\n\nКлиенты переписывают сделки вручную. Это долго.\n\n## What Changes\n'
    expect(proposalTitle(md)).toBe('Клиенты переписывают сделки вручную.')
  })

  it('заголовок с названием берётся как есть', () => {
    expect(proposalTitle('# Proposal: Лимиты на вывод\n')).toBe('Лимиты на вывод')
  })

  it('длинную фразу обрезает', () => {
    const md = `# Proposal\n\n## Why\n\n${'слово '.repeat(40)}\n`
    expect(proposalTitle(md).length).toBeLessThanOrEqual(90)
  })

  it('без названия и Why — пусто', () => {
    expect(proposalTitle('# Proposal\n')).toBe('')
  })
})

describe('parseSpecGaps', () => {
  const gaps = parseSpecGaps(`# Spec gaps

## 1. Граница периода

- **Где:** Requirement «Экспорт»
- **Блокирует:** шаги 2.1, 2.2
- **Решение:** <заполняет тимлид: обновить change / баг кода / вне рамок>

## 2. Имя файла

- **Блокирует:** шаг 2.3
- **Решение:** обновить change, TN-140
`)

  it('шаблон в угловых скобках — расхождение открыто', () => {
    expect(gaps[0]).toEqual({
      n: '1',
      title: 'Граница периода',
      blocks: 'шаги 2.1, 2.2',
      resolved: false,
      needsSpecUpdate: false,
      specPr: null,
    })
  })

  it('заполненное решение закрывает расхождение', () => {
    expect(gaps[1].resolved).toBe(true)
    expect(gaps[1].needsSpecUpdate).toBe(true)
  })
})

describe('ссылка на правку change и заглушка решения', () => {
  const gaps = parseSpecGaps(`## 1. Окно подтверждения
- **Решение:** _(тимлид)_

## 2. Частичное сохранение
- **Решение:** обновить change, вариант 2 → OpenSpec #57

## 3. Нет прав
- **Решение:** обновить change, вариант 1
- **PR спеки:** https://github.com/CryptoExch/OpenSpec/pull/42

## 4. Подтверждение
- **Решение:** обновить change

## 5. Баг
- **Решение:** баг кода
`)

  it('«_(тимлид)_» — решения нет; ссылка из «Решения» и из старого поля «PR спеки»', () => {
    expect(gaps.map((gap) => [gap.n, gap.resolved, gap.specPr])).toEqual([
      ['1', false, null],
      ['2', true, 'OpenSpec #57'],
      ['3', true, 'OpenSpec #42'],
      ['4', true, null],
      ['5', true, null],
    ])
  })

  it('в OpenSpec вносится только «обновить change» без ссылки', () => {
    expect(specUpdateGaps(gaps).map((gap) => gap.n)).toEqual(['4'])
  })
})
