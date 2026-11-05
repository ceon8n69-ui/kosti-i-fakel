# Кости и Факел

Кооперативная настольная RPG в Telegram: каждый игрок — герой в чужих подземельях и мастер своего. Полное ТЗ лежит у заказчика; решения по ходу работы — в [DECISIONS.md](DECISIONS.md).

## Статус

| Этап | Состояние |
| --- | --- |
| 0. Фундамент | ✅ принят 05.11.2026: бот @kostiandfakel_bot, Railway `KOSTI-I-FAKEL` |
| 1. Вертикальный срез | — |

**Этап 0 содержит:** монорепозиторий pnpm + Turborepo, авторизацию через подпись `initData`, профиль пользователя, бота (`/start`, `/help`, `/table`, `/terms`, `/paysupport`), схему БД с миграциями Drizzle, логирование pino, CI на GitHub Actions, Dockerfile для Railway, стартовый `balance.json` со схемой.

## Структура

```text
apps/
  api/      Fastify: /auth/telegram, /me, /health, /bot/webhook, раздача Mini App
  bot/      grammY: команды и кнопки (библиотека + локальный polling)
  web/      React + Vite: Mini App
packages/
  schema/   Zod-схемы и общие типы, схема balance.json
  content/  balance.json и загрузчик с проверкой
```

`engine`, `sim`, `llm` и `worker` появятся на этапах 1–2.

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
