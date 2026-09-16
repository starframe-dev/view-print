# Изолированный branded Google Chrome

## Контекст

`view-print` запускает bundled Chromium через Playwright. Флаг `--no-headless` только показывает окно и не использует установленный branded Google Chrome. Для совместимости с сайтами, которые строже проверяют браузерное окружение, нужен запуск Google Chrome в отдельном временном профиле, не затрагивающем основной профиль пользователя.

## Цель

Перевести запуск браузерной сессии `view-print` на установленный branded Google Chrome с сохранением изоляции профиля, headless/headed-режимов и текущего управления жизненным циклом браузера.

## Что изменится

1. `src/browser.ts` — добавить в параметры запуска Playwright канал `chrome`.
2. `tests/browser.test.ts` — проверить, что параметры запуска содержат branded Chrome и корректно сохраняют headless-настройку.
3. `specs/branded-chrome.md` — зафиксировать решение и критерии приёмки.

## Детали реализации

1. Изменить тип результата `getBrowserLaunchOptions` так, чтобы он включал `channel: 'chrome'` и `headless: boolean`.
2. Сохранить запуск через `chromium.launchServer`, чтобы Playwright создавал отдельный временный user-data-dir и не использовал основной профиль Google Chrome.
3. Не менять CLI-контракт: `--no-headless` должен по-прежнему включать headed-режим только при создании новой сессии.
4. Не добавлять обход Cloudflare, подмену fingerprint, отключение защит или автоматическое прохождение CAPTCHA.
5. Обновить только необходимые unit-тесты и выполнить lint, тесты и сборку.

## Критерии приёмки

- [x] `getBrowserLaunchOptions()` возвращает `channel: 'chrome'` и `headless: true` по умолчанию.
- [x] `getBrowserLaunchOptions({ headless: false })` возвращает `channel: 'chrome'` и `headless: false`.
- [x] Запуск остаётся через `chromium.launchServer`, а основной профиль Chrome не передаётся.
- [x] Все тесты проходят.
- [x] TypeScript lint и сборка проходят.
