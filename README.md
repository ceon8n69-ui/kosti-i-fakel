# Кости и Факел

Кооперативная настольная RPG в Telegram: каждый игрок — герой в чужих подземельях и мастер своего. Полное ТЗ лежит у заказчика; решения по ходу работы — в [DECISIONS.md](DECISIONS.md).

## Статус

| Этап | Состояние |
| --- | --- |
| 0. Фундамент | ✅ принят 05.11.2026: бот @kostiandfakel_bot, Railway `KOSTI-I-FAKEL` |
| 1. Вертикальный срез | ✅ |
| 2. Подземелья и партия | 🟡 часть 1: карта, сюжет, 3 обучающих подземелья, герои, награды, арт |

**Этап 2, часть 1:** формат `DungeonDefinition` (Zod), карта с туманом войны, перемещение тапом, двери, ключи, сундуки, рычаги, алтари, NPC, костры, ловушки (пассивное замечание, обыск, обезвреживание), правила «событие → условие → действие», три обучающих подземелья с сюжетом, постоянные герои (до 3), опыт и уровни, золото через журнал, бот-исследователь для тестов проходимости, фэнтези-миниатюры от OpenAI.

**Этап 1 добавляет:** детерминированный движок правил (`packages/engine`, PCG32, журнал событий, проекция для игрока, проверка бросков по зерну), партии на сервере (журнал, снимки каждые 20 событий, idempotency по `commandId`, `expectedSeq`, WebSocket и REST, догрузка пропущенного по `sinceSeq`), бой в 3D: изометрическая диорама на Three.js, 12 записанных траекторий на тип кубика, анимации миниатюр, синтезированный звук, вибрация, замедление и эффект стола на натуральных 1 и 20, ускорение, режим «меньше анимации», двумерный режим без WebGL.

**Этап 0 содержит:** монорепозиторий pnpm + Turborepo, авторизацию через подпись `initData`, профиль пользователя, бота (`/start`, `/help`, `/table`, `/terms`, `/paysupport`), схему БД с миграциями Drizzle, логирование pino, CI на GitHub Actions, Dockerfile для Railway, стартовый `balance.json` со схемой.

### Этап 2, часть 2

- Экспедиции со случайной картой в 5 биомах.
- События с выбором.
- 22 монстра.
- Снаряжение и реликвии, которые остаются после похода.
- Рынок за золото.
- Партии до 4 игроков с таймерами хода.

Подробности — `DECISIONS.md`, D-038…D-045.

## Структура

```text
apps/
  api/      Fastify: /auth/telegram, /me, /health, /bot/webhook, раздача Mini App
  bot/      grammY: команды и кнопки (библиотека + локальный polling)
  web/      React + Vite: Mini App
packages/
  schema/   Zod-схемы и общие типы, схема balance.json
  content/  balance.json, сценарий среза, загрузчик с проверкой
  content/dungeons/  официальные подземелья (JSON по схеме DungeonDefinition)
  engine/   чистые правила: applyCommand, исследование, бой, правила подземелья, project, PCG32, verifyJournal, бот
e2e/        Playwright с имитацией Telegram
```

`sim`, `llm` и `worker` появятся на этапе 2.

## Локальный запуск

Нужны Node 22, pnpm 10 и PostgreSQL 16.

```bash
cp .env.example .env            # заполнить BOT_TOKEN, BOT_USERNAME, SESSION_SECRET
pnpm install
pnpm build
pnpm dev:api                    # API на :3000, миграции применяются при старте
pnpm dev:web                    # Mini App на :5173 с прокси на API
pnpm dev:bot                    # бот в режиме polling
```

Внутри Telegram Mini App работает только по https, поэтому для проверки на телефоне используйте задеплоенный адрес Railway или туннель.

## Тесты

```bash
TEST_DATABASE_URL=postgres://kf:kf@localhost:5432/kf_test pnpm test
pnpm typecheck
```

E2E (нужны `pnpm build` и PostgreSQL): `TEST_DATABASE_URL=… pnpm --filter @kf/e2e e2e`.

Нагрузка: `DATABASE_URL=… pnpm --filter @kf/api exec tsx scripts/load.ts 200 1000` — 200 партий, пауза игрока ~1 с.

Траектории кубиков пересчитываются командой `pnpm --filter @kf/web record-dice` (результат детерминирован и закоммичен).

Интеграционные тесты API пропускаются, если `TEST_DATABASE_URL` не задан. В CI они идут на PostgreSQL 16. CI также проверяет, что миграции совпадают со схемой (`drizzle-kit check`) и что JS Mini App укладывается в 450 КБ gzip.

После изменения `apps/api/src/db/schema.ts`: `pnpm db:generate`, коммит файла из `apps/api/drizzle/`.

## Переменные окружения

| Переменная | Обязательна | Назначение |
| --- | --- | --- |
| `DATABASE_URL` | да | PostgreSQL |
| `BOT_TOKEN` | да | Токен бота; им же проверяется `initData` |
| `BOT_USERNAME` | да | Имя бота без `@` для ссылок `t.me/<bot>/<app>` |
| `MINI_APP_SHORT_NAME` | нет, пусто | Пусто — Main App бота; иначе короткое имя из `/newapp` |
| `SESSION_SECRET` | да | ≥ 32 символов, `openssl rand -hex 32` |
| `PUBLIC_URL` | для вебхука | https-адрес сервиса |
| `BOT_MODE` | нет, `off` | `webhook` на Railway, `polling` локально |
| `WEBHOOK_SECRET` | для вебхука | ≥ 16 символов, проверяется в заголовке Telegram |
| `SESSION_TTL_SEC` | нет, 3600 | Срок сессии |
| `AUTH_MAX_AGE_SEC` | нет, 86400 | Максимальный возраст `auth_date` |
| `RUN_MIGRATIONS` | нет, `true` | Миграции при старте |
| `DB_POOL_MAX` | нет, 20 | Размер пула соединений PostgreSQL |
| `WEB_DIST` | нет | Путь к сборке Mini App (в Docker задан) |
| `LOG_LEVEL`, `PORT` | нет | Логи и порт |

## Деплой на Railway

1. В @BotFather: создать бота, затем Bot Settings → Main App → URL `https://<сервис>.up.railway.app/`, режим Fullscreen.
2. Railway → New Project → Deploy from GitHub repo → этот репозиторий. Сборка идёт по `Dockerfile` (`railway.json`).
3. Добавить PostgreSQL в проект, в переменных сервиса: `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
4. Settings → Networking → Generate Domain. Этот адрес — `PUBLIC_URL`.
5. Задать `BOT_TOKEN`, `BOT_USERNAME`, `SESSION_SECRET`, `WEBHOOK_SECRET`, `PUBLIC_URL`, `BOT_MODE=webhook`.
6. Деплой. Healthcheck — `/health`. При старте API применяет миграции, ставит вебхук и список команд бота.

### Приёмка этапа 0

- [x] Mini App открывается из бота и показывает профиль (iPhone, 05.11.2026).
- [x] Запись пользователя создаётся (`POST /auth/telegram` → 200 на проде).
- [x] Подделанная `initData` получает 401 (тесты `apps/api/src/app.test.ts`).
- [ ] CI зелёный.

### Приёмка этапа 1

- [ ] Бой проходится на реальном телефоне (iPhone и средний Android).
- [ ] Состояние воспроизводится из журнала: после перезагрузки страницы бой продолжается с того же места; «Проверить броски» в конце подтверждает все броски по зерну.
- [ ] Натуральные 1 и 20 дают заметный эффект. Проще всего проверить на «Осмотреть проход»: каждая проверка — новый d20 (и −1 свет), 1 или 20 выпадает в среднем раз в 10 бросков.

## Арт

Фигурки генерируются в GitHub Actions (нужен секрет репозитория `OPENAI_API_KEY`). Чтобы перерисовать или добавить: допишите описание в `tools/build_art_prompts.py`, запустите `python tools/build_art_prompts.py`, укажите ключи в `tools/art-request.json` и закоммитьте его в `main`. Результат появится в ветке `art/run-<id>`; после проверки файлы из `apps/web/public/art/minis/` переносятся в `main`.
