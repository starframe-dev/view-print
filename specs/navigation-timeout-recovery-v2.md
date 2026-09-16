# Восстановление ViewPrint после timeout навигации

## Контекст

Threads иногда не завершает `page.goto` за 30 секунд даже после ожидания `domcontentloaded`. Из-за этого SMM pipeline получает ошибку capture и не может перейти к read-only проверке аккаунта.

## Цель

После timeout навигации сохранить целевой URL в состоянии ViewPrint и дать вызывающему клиенту возможность снять текущий DOM без повторной навигации. Это позволяет завершить уже начавшуюся загрузку SPA и безопасно передать управление account detection.

## Что изменится

1. `src/browser.ts` — сохранять URL до `page.goto`, чтобы `--no-goto` был доступен после timeout.
2. `Engine/src/viewprint/client.ts` — после timeout `page.goto` один раз повторять capture с `--no-goto`.
3. Тесты ViewPrint и Engine — регрессия для recovery flow.

## Критерии приёмки

- [ ] Обычный capture сохраняет прежнее поведение.
- [ ] После timeout `page.goto` состояние содержит целевой URL.
- [ ] Engine client выполняет один `--no-goto` recovery capture.
- [ ] При неудаче recovery исходная ошибка не маскируется успешным результатом.
- [ ] ViewPrint и Engine lint/tests/build проходят.
