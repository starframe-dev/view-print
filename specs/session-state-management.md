# Управление state сессии

## Контекст

Сейчас сохранённый state сессии можно использовать только косвенно через browser automation. Нет безопасных команд для переименования state, резервного копирования и переноса cookies/хранилищ/настроек между сессиями.

## Цель

Добавить команды `session rename`, `session export` и `session import` для сохранённого state сессии. Переименование и импорт не должны конфликтовать с уже открытым браузером.

## Что изменится

1. `src/types.ts` — добавить сохраняемый `viewport` в `SessionState`.
2. `src/session.ts` — нормализация state, проверка существования, переименование, импорт state.
3. `src/browser.ts` — сохранять переданный viewport и восстанавливать его при запуске сессии.
4. `src/daemon.ts` — HTTP API для export/import/rename и проверка открытых сессий.
5. `src/daemon-client.ts` — клиентские методы export/import/rename.
6. `src/cli.ts` — группа команд `session rename|export|import`.
7. `tests/session.test.ts` — unit-тесты state-операций и валидации.
8. `tests/browser.test.ts` — тест сохранения viewport.
9. `tests/daemon.test.ts` — HTTP-тесты export/import/rename и запрета операций для открытой сессии.
10. `README.md` — документация команд и предупреждение о секретах.
11. Оба `knowledge_view-print/SKILL.md` — синхронное описание новых команд.

## Детали реализации

### CLI

```bash
viewprint -s old session rename new
viewprint -s X session export --output session.json
viewprint -s X session import session.json
viewprint -s X session import session.json --force
```

- `-s old` — исходная сессия для rename.
- `-s X` — целевая сессия для import/export.
- `export` пишет полный JSON state в `--output`; без `--output` печатает JSON в stdout.
- `import` читает путь из позиционного аргумента; без `--force` отказывается перезаписывать существующий state.
- Экспорт не шифруется и может содержать секреты из cookies/localStorage.

### State

Экспортируется и импортируется объект `SessionState`:

- `name` — при импорте заменяется на имя целевой сессии;
- `url`;
- `viewport` (`width`, `height`);
- `cookies`;
- `localStorage`;
- `sessionStorage`.

Импорт проверяет обязательные типы и отвергает некорректный JSON.

### Открытый браузер

- `rename` запрещён, если исходная сессия открыта в daemon; сначала нужно выполнить `close`.
- `import` запрещён, если целевая сессия открыта в daemon; сначала нужно выполнить `close`.
- `export` разрешён для открытой сессии и возвращает её текущий state.
- Rename не перезаписывает существующую целевую сессию.

### HTTP API

- `POST /sessions/:name/rename` с `{ "newName": "new" }`.
- `GET /sessions/:name/export` возвращает state.
- `POST /sessions/:name/import` с `{ "state": <SessionState>, "force": boolean }`.

## Критерии приёмки

- [x] `session rename` переносит сохранённый state и обновляет его имя.
- [x] Rename запрещён для открытой сессии и не перезаписывает существующую.
- [x] `session export` экспортирует весь state, включая viewport.
- [x] `session import` восстанавливает весь state и требует `--force` для перезаписи.
- [x] Import запрещён для открытой сессии.
- [x] Некорректный JSON отклоняется с понятной ошибкой.
- [x] Cookies и storage не логируются в обычный вывод daemon.
- [x] `pnpm run lint` проходит.
- [x] `pnpm test` проходит.
- [x] `pnpm run build` проходит.
