# Режим `no-headless` для capture

## Контекст

`BrowserSession` всегда запускает Chromium в headless-режиме. Для визуальной отладки нужна возможность показать окно Chromium только при создании сессии через конкретную команду `capture`.

## Цель

Добавить флаг `--no-headless` к `capture [url]`. По умолчанию поведение не меняется: Chromium запускается headless. При передаче флага новая сессия запускается в headed-режиме и остаётся такой для последующих действий этой сессии.

## Что изменится

1. `src/browser.ts` — принимать настройку `headless` при создании `BrowserSession` и передавать её в `chromium.launchServer()`.
2. `src/daemon.ts` — принимать `noHeadless` в запросе `capture`; использовать его только при создании новой сессии.
3. `src/daemon-client.ts` — передавать настройку `noHeadless` в HTTP API.
4. `src/cli.ts` — добавить `--no-headless` к `capture` и передавать его клиенту.
5. `tests/browser.test.ts` — проверить, что настройка запуска преобразуется в headless/headed режим через мок Playwright.
6. `tests/daemon.test.ts` — проверить передачу `noHeadless` через HTTP API и сохранение существующей сессии без повторного запуска.
7. `specs/no-headless.md` — эта спецификация.

## Детали реализации

1. `BrowserSession` получает опции конструктора `{ headless?: boolean }`; значение по умолчанию — `true`.
2. `createBrowserSession` получает такие же опции и передаёт их в `BrowserSession`.
3. `ViewPrintDaemon.getOrCreateSession(name, options)` создаёт новую сессию с `headless: !noHeadless`; уже существующую сессию не перезапускает и не меняет.
4. HTTP `POST /sessions/<name>/capture` читает `body.noHeadless` и передаёт его только в `getOrCreateSession`.
5. `DaemonClient.capture` получает опции `{ skipLoad?, noLoad?, noHeadless? }` и включает `noHeadless` в тело запроса.
6. CLI добавляет `.option('--no-headless', 'Show Chromium window for this session')` и передаёт `noHeadless: options.headless === false`.
7. `README.md` документирует флаг и его действие при создании новой сессии.
8. Если сессия уже создана headless, `capture --no-headless` не меняет её режим; для смены режима нужно закрыть сессию и выполнить capture снова с нужным флагом.
9. Команды `snapshot`, batch, MCP и daemon start не получают новый флаг.

## Критерии приёмки

- [ ] Без `--no-headless` новая сессия запускает Chromium с `headless: true`.
- [ ] `capture --no-headless` новая сессия запускает Chromium с `headless: false`.
- [ ] Флаг действует только на конкретную сессию и не меняет режим других сессий.
- [ ] Повторный capture существующей сессии не перезапускает Chromium и не меняет его режим.
- [ ] `pnpm run lint` проходит.
- [ ] `pnpm test` проходит.
- [ ] `pnpm run build` проходит.
