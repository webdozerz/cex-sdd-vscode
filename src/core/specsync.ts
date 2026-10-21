/**
 * Сабмодуль спек относительно ветки и main OpenSpec.
 * working — рабочая копия сабмодуля против commit, закреплённого в HEAD кодового репо:
 * same — совпадает; behind — отстаёт (после git pull или смены ветки не сделали git submodule update);
 * ahead — новее (спеки обновили, bump не закоммичен); diverged — ни то ни другое.
 */
export interface ISpecsSync {
  working: 'same' | 'behind' | 'ahead' | 'diverged'
  /** Файлы change в main OpenSpec отличаются от закреплённых в ветке; null — main OpenSpec неизвестен (нет сети или доступа). */
  changeUpdated: boolean | null
  /** Закреплённый commit отстаёт от main OpenSpec (что-то в спеках новее, не обязательно этот change). */
  pinnedBehind: boolean | null
}
