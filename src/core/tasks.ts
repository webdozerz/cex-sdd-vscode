import type { ITasksGroup } from './types'

const POST_DEPLOY = 'проверка после развёртывания'
const GROUP_RE = /^##\s+(?:\d+\.\s+)?(.+?)\s*$/
const GROUP_KEY_RE = /\((SE-\d+)\)/i
const ITEM_RE = /^\s*[-*]\s+\[([ xX])\]\s+(?:(\d+(?:\.\d+)+)\s+)?(.*?)\s*$/

/**
 * Разбор tasks.md схемы cex-sdd: группы `## 1. client-fe` или `## 2. client-fe (SE-130)`
 * (ключ подзадачи Jira рядом с репозиторием), задачи `- [ ] 1.1 …`.
 * Раздел «Проверка после развёртывания» без чекбоксов в разбор не входит.
 * Валидатор OpenSpec берёт из заголовка первое слово после номера, поэтому ключ в скобках ему не мешает.
 */
export function parseTasks(markdown: string): ITasksGroup[] {
  const groups: ITasksGroup[] = []
  let current: ITasksGroup | null = null
  let skip = false
  let counter = 0

  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(GROUP_RE)
    if (heading && !line.startsWith('###')) {
      const title = heading[1].trim()
      skip = title.toLowerCase() === POST_DEPLOY
      if (skip) {
        current = null
      } else {
        current = {
          repo: title.split(/\s+/)[0],
          key: title.match(GROUP_KEY_RE)?.[1].toUpperCase() ?? null,
          items: [],
        }
        groups.push(current)
      }
      counter = 0
      continue
    }
    if (!current || skip) continue
    const item = line.match(ITEM_RE)
    if (!item) continue
    counter += 1
    current.items.push({
      id: item[2] ?? `${groups.length}.${counter}`,
      text: item[3],
      done: item[1].toLowerCase() === 'x',
    })
  }
  return groups
}
