# Автовосстановление закрытой ViewPrint-сессии

## Контекст

Browser context или страница ViewPrint могут закрыться из-за сбоя Chromium. В памяти daemon при этом оставалась старая `BrowserSession`. Следующая команда получала ошибку `Target page, context or browser has been closed` вместо восстановления сессии.

## Цель

Перед каждой операцией повторно использовать только живую BrowserSession. Если страница или browser connection закрыты, daemon должен закрыть устаревший объект, создать новую сессию с сохранённым state и продолжить команду.

## Реализация

- `BrowserSession.isUsable()` проверяет `closing`, наличие страницы, `page.isClosed()` и `browser.isConnected()`.
- `ViewPrintDaemon.getOrCreateSession()` пересоздаёт неиспользуемую сессию и удаляет stale tracing state.
- Сохранённые cookies, localStorage, viewport и URL загружаются штатным `BrowserSession.start()`.

## Критерии приёмки

- [x] Живая сессия переиспользуется без нового запуска.
- [x] Закрытая сессия определяется как неиспользуемая.
- [x] После закрытия создаётся новая BrowserSession.
- [x] Тесты, lint и build проходят.
