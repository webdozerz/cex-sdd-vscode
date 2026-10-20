import type { TPlansLocation, TRepoId } from './types'

export interface ISpecPrInput {
  change: string
  /** Ключ задачи разработчика: в коммит и заголовок PR. */
  key: string
  gap: { n: string; title: string }
  /** spec-gaps.md относительно корня проекта. */
  gapsFile: string
  /** Сабмодуль спек: только для чтения. */
  submodulePath: string
  /** Адрес репозитория спек из .gitmodules; null — агент берёт его сам. */
  specRepoUrl: string | null
  plansLocation: TPlansLocation
  repoId: TRepoId | null
  /** Какой вариант из записи взять за основу; пусто — рекомендованный в записи. */
  variant: string
}

/**
 * Запрос к Claude Code: подготовить PR в репозиторий спек с правкой change по записи spec-gaps.md.
 * Запрос самодостаточный — не зависит от версии плагина cex-sdd: сабмодуль только читается,
 * правка идёт в отдельном клоне, push и PR — после подтверждения разработчика.
 */
export function buildSpecPrPrompt(input: ISpecPrInput): string {
  const { change, key, gap, gapsFile, submodulePath } = input
  const branch = `${change}-gap-${gap.n}`
  const clone = input.specRepoUrl
    ? `иначе \`git clone ${input.specRepoUrl}\` во временный каталог`
    : 'иначе клонируй репозиторий спек (адрес — в .gitmodules) во временный каталог'
  const variant = input.variant.trim() || 'вариант, рекомендованный в записи'
  const plans = input.plansLocation === 'spec' && input.repoId ? `, plans/${input.repoId}/` : ''
  const linkTarget =
    input.plansLocation === 'spec'
      ? `в поле «PR спеки» записи №${gap.n} в plans/${input.repoId ?? '<репозиторий>'}/spec-gaps.md — в том же PR`
      : `в поле «PR спеки» записи №${gap.n} в ${gapsFile} (коммит в кодовом репо)`

  return [
    `Подготовь PR в репозиторий спек (OpenSpec) с правкой change ${change} по расхождению №${gap.n} «${gap.title}» из ${gapsFile}. За основу возьми: ${variant}.`,
    '',
    'Порядок:',
    `1. Прочитай запись №${gap.n} и файлы change в ${submodulePath}/openspec/changes/${change}/. Сабмодуль ${submodulePath} и симлинк openspec/ — только для чтения, в них ничего не пиши и не коммить.`,
    `2. Работай в отдельном клоне репозитория спек вне этого проекта: готовый клон рядом (../OpenSpec или ../openspec), если его origin — тот же репозиторий, ${clone}. Ветка от свежего origin/main: ${branch}.`,
    '3. Перед правкой прочитай в клоне CLAUDE.md, openspec/config.yaml и схему в openspec/schemas/ — их правила главнее этого запроса.',
    `4. Меняй только openspec/changes/${change}/: proposal.md (запись в «Открытых вопросах»: вопрос, кому, решение или «предложение ${key}, ждёт решения», ссылка на запись), specs/**, ui.md, journeys.md, contract/openapi.yaml, test-plan.md, текст задач tasks.md без галочек${plans}. Не трогай openspec/specs/, contracts/, gate1 в meta.yaml, .github/, scripts/, openspec/schemas/, openspec/config.yaml и чужие change. Без деталей реализации кодового репо; термины — из GLOSSARY.md.`,
    '5. Проверь в клоне: npm ci, npm run check, npm run lint:contracts.',
    `6. Покажи мне diff и текст PR. Коммит docs(${key}): ${change} — правка по spec-gap ${gap.n}; push и PR в main по шаблону .github/pull_request_template.md — только после моего подтверждения. Нет прав на запись — подготовь diff и текст PR для аналитика.`,
    `7. После создания PR впиши ссылку ${linkTarget}.`,
    '',
    'PR — предложение для аналитика change и тимлидов затронутых репозиториев: решение по существу за ними. Если расхождение похоже на уязвимость (обход 2FA или прав, деньги, чужие данные, подпись) — остановись и ничего не записывай.',
  ].join('\n')
}
