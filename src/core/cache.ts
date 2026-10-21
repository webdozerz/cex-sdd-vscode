export interface ITtlCache<T> {
  /** Значение по ключу: из кэша, пока оно свежее, иначе от load. Одновременные запросы ключа ждут один load. */
  get(key: string, load: () => Promise<T>): Promise<T>
  clear(): void
}

/** Кэш с временем жизни. Ошибка load не кэшируется. now — для тестов. */
export function createTtlCache<T>(ttlMs: number, now: () => number = Date.now): ITtlCache<T> {
  const entries = new Map<string, { at: number; value: Promise<T> }>()

  return {
    get(key, load) {
      const cached = entries.get(key)
      if (cached && now() - cached.at < ttlMs) return cached.value
      const value = load()
      const entry = { at: now(), value }
      entries.set(key, entry)
      value.catch(() => {
        if (entries.get(key) === entry) entries.delete(key)
      })
      return value
    },
    clear() {
      entries.clear()
    },
  }
}
