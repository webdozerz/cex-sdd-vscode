/**
 * Запуски задачи без наложения: пока идёт запуск, новые вызовы не стартуют параллельно,
 * а сводятся в один повтор после него. Так более старый расчёт не перезапишет свежий,
 * а медленные вызовы (gh, git) не копятся. Все вызовы, пришедшие во время запуска, ждут и повтора.
 */
export function createSerialRunner(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null
  let again = false

  return () => {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      try {
        do {
          again = false
          await task()
        } while (again)
      } finally {
        running = null
      }
    })()
    return running
  }
}
