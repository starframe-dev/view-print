# Подготовка ViewPrint к выпуску

## Контекст

Аудит main выявил риски внешнего доступа к daemon и его файловому состоянию, дефекты восстановления браузера, неработающие frames/diff, ошибки публикации пакета и lifecycle-процессов, а также неограниченное потребление памяти в network tracking. Несколько заявленных функций и пунктов спецификации не подтверждены работающими acceptance-тестами.

## Цель

Довести CLI, библиотечный API и daemon до безопасного и проверяемого состояния выпуска, исправив дефекты из implementation handoff с минимальными изменениями и сохранив совместимость там, где она безопасна.

## Что изменится

- `src/daemon.ts`, `src/daemon-client.ts`, `src/daemon-process.ts`, `src/daemon-entry.ts`, `src/process-tree.ts` — loopback, аутентификация, ограничение HTTP body, безопасные metadata/PID и запуск из библиотеки.
- `src/session.ts`, `src/types.ts`, `src/browser.ts`, `src/extractor.ts`, `src/graph.ts`, `src/diff.ts`, `src/tracing.ts` — защищённое состояние, восстановление URL/storage, refs без пользовательских DOM-атрибутов, frames/diff, ограниченные network tracking и tracing cleanup, линейное построение графа.
- `src/cli.ts`, `src/cli-parser.ts`, `src/mcp.ts`, `src/version.ts`, `src/index.ts` — полный CLI/client API, безопасный async parser, пакетная команда, единая версия и официальный MCP SDK.
- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.github/workflows/ci.yml`, `scripts/smoke-package.mjs`, `README.md`, `specs/view-print.md`, `tests/` — публикация, CI, smoke-проверки, документация и acceptance-тесты.

## Детали реализации

1. Daemon привязывается к `127.0.0.1`, проверяет bearer token для всех HTTP endpoints, ограничивает JSON body и выдаёт контролируемые статусы ошибок. Managed daemon хранит защищённые metadata отдельно по портам; остановка допустима только после проверки PID, command line и instance identity.
2. Session names валидируются в файловых функциях. Каталоги создаются с правами `0700`, state/metadata — `0600`; JSON сохраняется атомарной заменой.
3. State мигрирует старые плоские local/session storage карты в origin/tab-aware формат. Storage задаётся до выполнения приложения; повторный capture без URL восстанавливает сохранённую страницу.
4. Выбранный frame становится target для capture/snapshot/inspect, element/query actions и read. `frames main` возвращает основной документ. Неподдерживаемые действия должны явно сообщать об ограничении.
5. `diff last` сравнивает последний зафиксированный граф с новым capture. Dialog и diff доступны через daemon client и CLI.
6. Построение графа использует заранее построенный список потомков. Network capture ограничивает количество запросов и размер/тип тел, не дублирует listeners; persistence использует dirty/debounce/checkpoint; tracing всегда освобождает listener/timer/CDP session.
7. Пакет экспортирует реально собранные JS/declaration-файлы, CLI и документацию. Vitest и MCP SDK — официальные поддерживаемые зависимости; версии CLI/MCP/HAR читаются из package metadata.
8. README/specs не обещают полноценное accessibility tree или точную CSS cascade там, где реализован semantic DOM snapshot и приблизительная CSS диагностика.

## Критерии приёмки

- [x] `pnpm install --frozen-lockfile`, `pnpm run lint`, `pnpm test`, `pnpm run build` проходят (проверено на Node 22 с Chromium 149: 10 файлов, 129 тестов). `vitest.config.ts` исключает `dist/**`, чтобы не запускать скомпилированные копии тестов.
- [x] Vitest обновлён с `^2.0.0` (lock 2.1.9) до `^4.1.11` (lock 4.1.11) с явным `vite@^7` для peer-зависимости.
- [x] Positional batch: регулярка исправлена на `/"[^"]+"|\S+/g`, парсер вынесен в `src/batch-parser.ts` и покрыт `tests/batch.test.ts`.
- [x] MCP stdio запускается через `serveStdio(() => createMcpServer(session))`; `tests/mcp-stdio.test.ts` проверяет legacy handshake и `server/discover` с `_meta` для 2026-07-28.
- [x] `pnpm run build` кладёт `dist/package.json` (нужен `dist/src/version.js`); до исправления собранный CLI/daemon не находил метаданные пакета.
- [x] Добавлены acceptance-тесты на security, recovery, storage, frames, diff/dialog, packaging, CLI, performance, network и tracing.
- [ ] Packed tarball содержит только опубликованные файлы; установка во временный проект подтверждает library import и `viewprint --help`. (Не перепроверено после изменения сборки.)
- [ ] Smoke-проверка установленного пакета подтверждает daemon start/status/stop/restart и прямой запуск через library API. (Не перепроверено после изменения сборки.)
- [ ] CI workflow настроен для Node 22 (Node 20 не поддерживается: pnpm 11.9 требует Node ≥ 22.13), установки Playwright Chromium и lint/test/build/pack/smoke. Зелёный run на GitHub ещё не получен (run 37978615788 на d57a425 упал).
- [x] README и checked acceptance-пункты не описывают placeholders/no-op как готовые функции.

## Контекст проверок

[2026-10-05] Проблема: исходный `pnpm test` завершился с 95/96 passing из-за проверки Chrome PID, ожидавшей `chrome-headless-shell` при запуске через branded Chrome → Решение: переключить default на bundled Playwright Chromium и перепроверить lifecycle-тест; не ослаблять проверку очистки процесса.
[2026-10-05] Проблема: изменение shared-типа `SessionState` без синхронного обновления BrowserSession временно нарушило TypeScript-проверку → Решение: менять shared state и его readers/writers одним завершённым этапом и выполнять lint после согласованного изменения.
[2026-10-05] Проблема: экранирование `/` в регулярном литерале network MIME-проверки было записано как двойной backslash и остановило разбор TypeScript → Решение: проверять source literal после exact-text edits и запускать lint до следующего этапа.
[2026-10-05] Проблема: Playwright `evaluate` сериализует переданную функцию отдельно, поэтому вызов внешнего helper из extractor дал `ReferenceError` → Решение: все browser-evaluated функции должны быть самодостаточными; тестировать каждый сериализуемый extractor в настоящем браузере.
[2026-10-05] Проблема: замена `any` на `unknown` в HTTP body выявила невалидированные значения на границе daemon API → Решение: добавлять обязательную type/shape validation на маршруте до передачи данных BrowserSession.
[2026-10-05] Проблема: bundled Playwright браузер на macOS называется `Chromium`, а не `chrome-headless-shell`, поэтому system-wide name filter давал ложный сбой → Решение: lifecycle test сопоставляет процессы только по descendants daemon и идентифицирует браузер по фактическому command name.
[2026-10-05] Проблема: удаление из CLI типового cast для импортируемого JSON выявило, что HTTP client необоснованно требовал уже-валидированный `SessionState` → Решение: принимать `unknown` до серверной нормализации и type validation.
[2026-10-05] Проблема: первая npm tarball smoke обнаружила попадание `dist/tests`, source maps и тестовых declarations через широкий `files: ["dist"]` → Решение: публиковать явный whitelist JS/declarations/metadata, а manifest smoke блокирует лишние entries.
[2026-10-05] Проблема: tarball import выявил, что `main` ссылался на несуществующий `dist/index.js`, поскольку entry point собран в `dist/src/index.js` → Решение: выравнивать `main`, `types`, `exports` и package whitelist с фактическим `tsconfig` output.
[2026-10-05] Проблема: package smoke блокировал event loop своего HTTP fixture во время синхронного запуска CLI → Решение: изолировать fixture server в отдельном процессе, иначе capture ожидает network response, который не может быть обработан.
[2026-10-05] Проверка: frozen install, lint, весь suite (8 файлов/121 тест), build, tarball whitelist/install/import и CLI/library daemon recovery smoke прошли локально; `git diff --check` ошибок не нашёл. GitHub Actions workflow добавлен, но удалённый CI не запускался.
