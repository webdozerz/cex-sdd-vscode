import type { IPlan, IPlanTask, ISpecGap } from './types'

const TASK_RE = /^##\s+tasks\.md\s+(\d+(?:\.\d+)*)\s*[—–-]\s*(.*?)\s*$/i
const STEP_RE = /^\s*[-*]\s+\[([ xX])\]\s+(.*?)\s*$/
const STEP_ID_RE = /<!--\s*step:\s*([\w.-]+)\s*-->\s*/i
const TEMP_SECTION_RE = /^##\s+временные исключения\s*$/i
const DONE_SUFFIX_RE = /\s*[—–-]\s*готово\s*$/i
const GAP_HEAD_RE = /^##\s+(\d+)\.\s+(.*?)\s*$/
const FIELD_RE = /^\s*[-*]\s+\*\*([^:*]+):\*\*\s*(.*?)\s*$/

/**
 * docs/changes/<change>/plan.md (создаёт и ведёт /cex-sdd:apply):
 *
 *   ## tasks.md 1.1 — <текст задачи>
 *   - [ ] <шаг> — проверка: <тест или команда>
 */
export function parsePlan(markdown: string): IPlan {
  const tasks: IPlanTask[] = []
  let current: IPlanTask | null = null

  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(TASK_RE)
    if (heading) {
      current = { id: heading[1], title: heading[2].replace(DONE_SUFFIX_RE, ''), steps: [] }
      tasks.push(current)
      continue
    }
    const section = line.match(/^##\s+(.+?)\s*$/)
    if (section) {
      // Разделы плана, не привязанные к задаче tasks.md: «0. Дизайн», «Общее», «Интеграция».
      current = { id: '', title: section[1].replace(DONE_SUFFIX_RE, ''), steps: [] }
      tasks.push(current)
      continue
    }
    const step = line.match(STEP_RE)
    if (!step) continue
    if (!current) {
      current = { id: '', title: 'Без привязки к задаче', steps: [] }
      tasks.push(current)
    }
    const stepId = step[2].match(STEP_ID_RE)?.[1]
    current.steps.push({
      text: step[2].replace(STEP_ID_RE, '').trim(),
      done: step[1].toLowerCase() === 'x',
      ...(stepId ? { stepId } : {}),
    })
  }

  const steps = tasks.flatMap((task) => task.steps)
  return { tasks, total: steps.length, done: steps.filter((step) => step.done).length }
}

/**
 * docs/changes/<change>/spec-gaps.md (создаёт /cex-sdd:spec-gap): записи `## N. <кратко>`
 * с полями «Блокирует» и «Решение». Поле «Решение» заполняет тимлид; пока там шаблон в <…> — расхождение открыто.
 */
export function parseSpecGaps(markdown: string): ISpecGap[] {
  const gaps: ISpecGap[] = []
  let current: { n: string; title: string; blocks: string; decision: string } | null = null

  const flush = (): void => {
    if (current) {
      gaps.push({ n: current.n, title: current.title, blocks: current.blocks, resolved: current.decision.length > 0 })
    }
  }

  for (const line of markdown.split(/\r?\n/)) {
    const head = line.match(GAP_HEAD_RE)
    if (head) {
      flush()
      current = { n: head[1], title: head[2], blocks: '', decision: '' }
      continue
    }
    if (!current) continue
    const field = line.match(FIELD_RE)
    if (!field) continue
    const name = field[1].trim().toLowerCase()
    if (name === 'блокирует') current.blocks = field[2].replace(/<[^>]*>/g, '').trim() || field[2]
    if (name === 'решение') current.decision = field[2].replace(/<[^>]*>/g, '').trim()
  }
  flush()
  return gaps
}

/**
 * Строки таблицы раздела «Временные исключения» в design.md (без заголовка и разделителя).
 * null — раздела нет; 0 — раздел есть, исключений нет («Нет.» или пустая таблица).
 */
export function countTempTableRows(designMarkdown: string): number | null {
  const lines = designMarkdown.split(/\r?\n/)
  const start = lines.findIndex((line) => TEMP_SECTION_RE.test(line.trim()))
  if (start < 0) return null
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line))
  // Строки таблицы без разделителя |---|; первая из оставшихся — заголовок.
  const rows = lines
    .slice(start + 1, end < 0 ? undefined : end)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && !/^\|[\s:|-]+\|$/.test(line))
  return Math.max(rows.length - 1, 0)
}

/** Разбор вывода `git grep -n` по меткам `sdd-temp(<KEY>): описание`. */
export function parseTempMarkers(grepOutput: string): Array<{ file: string; line: number; key: string; text: string }> {
  return grepOutput.split('\n').flatMap((row) => {
    const match = row.match(/^(.+?):(\d+):(.*)$/)
    const marker = match?.[3].match(/sdd-temp\((SE-\d+)\)\s*:?\s*(.*)$/i)
    if (!match || !marker) return []
    const text = marker[2].replace(/\s*(\*\/|-->)\s*$/, '').trim()
    return [{ file: match[1], line: Number(match[2]), key: marker[1].toUpperCase(), text }]
  })
}
