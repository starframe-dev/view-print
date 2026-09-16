# Взаимодействие ViewPrint через CSS-селекторы

## Контекст

Refs `data-viewprint-id` могут устаревать между инспекцией и действием: capture переназначает ids DOM-элементам. Для динамических страниц нужен способ выполнить действие по CSS-селектору без повторной разметки refs.

## Цель

Добавить к ViewPrint операции `click --query` и `fill --query`, которые работают напрямую с CSS-селектором текущего DOM и не вызывают capture перед действием.

## Что изменится

1. `src/browser.ts` — добавить `clickQuery` и `fillQuery` без `ensureElementIds`.
2. `src/daemon-client.ts` — добавить HTTP-клиентские методы query-действий.
3. `src/daemon.ts` — принимать поле `query` для click/fill.
4. `src/cli.ts` — добавить `--query` к click/fill.
5. `src/platforms/threads/reader.ts` — использовать selectors для editor, expand, reply и publish действий.
6. Тесты ViewPrint и Engine — проверить query-действия и отсутствие повторного EID capture перед кликом.

## Критерии приёмки

- [x] `click --query <selector>` кликает текущий видимый элемент без reassignment refs.
- [x] `fill --query <selector> <text>` заполняет текущий элемент без reassignment refs.
- [x] Replies используют query actions для editor и publish.
- [x] EID API остаётся совместимым.
- [x] ViewPrint и Engine проверки проходят.
