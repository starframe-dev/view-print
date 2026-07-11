# view-print: AI-инструмент для извлечения графа верстки страницы

## Контекст

Нужен standalone AI-инструмент для точной верстки. Плагин Playwright запускает браузер, вычисляет позиции и базовую информацию об элементах, и отдаёт граф в виде плоского JSON (adjacency list). Детальные CSS-данные запрашиваются отдельно по конкретному элементу через `inspect`.

Инструмент работает через CLI `viewprint` и демон с HTTP API. Демон держит браузер открытым между командами. Граф содержит только рендеримые элементы внутри `<body>`, без умолчательных CSS-значений и без текста скриптов/стилей. Поддерживается настройка viewport для разных разрешений.

## Цель

Создать TypeScript CLI `viewprint` и демон, который:

- открывает страницу в Playwright в рамках именованной сессии;
- строит облегчённый граф элементов внутри `<body>` на `capture`;
- исключает `<html>`, `<head>` и их потомков (кроме `<body>`);
- не включает текст из `<script>` и `<style>`;
- позволяет задавать viewport для эмуляции разных разрешений экрана;
- предоставляет команду `inspect <elementId>` для получения полных CSS-данных конкретного элемента;
- сохраняет состояние сессии (URL, cookies, localStorage) между запросами;
- перевычисляет граф только при команде `capture`;
- предоставляет команды `capture`, `inspect`, `click`, `status` и `close`;
- выводит граф в формате плоского JSON adjacency list;
- работает через демон с HTTP API, держащий браузер открытым между командами.

## Что изменится

1. `specs/view-print.md` — настоящая спецификация.
2. `src/extractor.ts` — разделение на snapshot и inspect extraction.
3. `src/graph.ts` — построение облегчённого и полного графа.
4. `src/browser.ts` — методы `capture` и `inspect`.
5. `src/daemon.ts` — HTTP-демон с API `/sessions/:name/*` и `/health`.
6. `src/daemon-client.ts` — HTTP-клиент.
7. `src/daemon-process.ts` — управление процессом демона.
8. `src/daemon-entry.ts` — entry point.
9. `src/cli.ts` — CLI: `capture`, `inspect`, `click`, `status`, `close`, `daemon`.
10. `src/session.ts` — сохранение/загрузка состояния сессии.
11. `src/types.ts` — типы графа и сессий.
12. `src/index.ts` — публичное API.
13. `tests/` — unit и интеграционные тесты.

## Детали реализации

### 1. Обход DOM

Извлечение данных происходит для `<body>` и всех элементов внутри него:

```js
document.querySelectorAll('body, body *')
```

`<html>`, `<head>` и их потомки (кроме `<body>`) не включаются. Корневой элемент графа — `<body>`.

### 2. Role и accessible name

Для каждого элемента в снапшоте определяются:

- `role` — явный (`role` атрибут) или неявный по тегу (`button`, `link`, `heading`, `textbox`, `img` и др.).
- `name` — accessible name по приоритету: `aria-labelledby`, `aria-label`, `<label>`, `alt`, `title`, `placeholder`, текст кнопки/ссылки.

### 2. Текст

Свойство `text` заполняется только из **непосредственных** текстовых дочерних узлов элемента (nodeType === TEXT_NODE), без рекурсии в дочерние элементы. Пустые и whitespace-only значения не включаются. Содержимое `<script>` и `<style>` исключается для всех элементов, включая родителей. Для самих `<script>`/`<style>` `text` не заполняется.

Пример: для `<div>Hello <span>world</span>!</div>` у `div` будет `text: "Hello !"`, у `span` — `text: "world"`.

### 3. Snapshot — accessibility tree с refs

`Snapshot` возвращает иерархическое accessibility-дерево элементов внутри `<body>`. Каждый узел содержит `ref` (например, `e2`), который можно использовать в `click @e2` и `inspect @e2`.

```json
{
  "url": "https://example.com",
  "viewport": { "width": 1280, "height": 720 },
  "tree": [
    {
      "ref": "e1",
      "tag": "body",
      "boundingBox": { ... },
      "children": [
        { "ref": "e2", "tag": "button", "role": "button", "name": "Submit", "text": "Submit", "children": [] }
      ]
    }
  ]
}
```

Узлы без `role`/`name`/`text`, но имеющие значимых потомков, поднимаются вверх; пустые контейнеры пропускаются.

### 3. Capture — облегчённый граф

`capture` возвращает плоский JSON adjacency list с минимальными данными:

```json
{
  "url": "https://example.com",
  "viewport": { "width": 1920, "height": 1080 },
  "nodes": {
    "e1": { "id": "e1", "tag": "body", "boundingBox": { ... }, "text": "..." },
    "e2": { "id": "e2", "tag": "div", "boundingBox": { ... }, "text": "..." }
  },
  "edges": [
    { "from": "e1", "to": "e2", "type": "child" }
  ]
}
```

Каждый узел содержит:
- `id` — stable ID;
- `tag`;
- `role` (опционально);
- `attributes`;
- `text` (опционально);
- `boundingBox`.

`computedStyles`, `cascade` и `pseudo` **не включаются** в `capture`.

### 4. Inspect — полные данные элемента

`inspect <elementId>` возвращает полную информацию по одному элементу:

```json
{
  "id": "e2",
  "tag": "div",
  "role": "...",
  "attributes": { ... },
  "text": "...",
  "boundingBox": { ... },
  "computedStyles": { ... },
  "cascade": [ ... ],
  "pseudo": {
    "before": { ... },
    "after": { ... }
  }
}
```

- `computedStyles` — только свойства не из `user-agent`;
- `cascade` — только `inline`, `stylesheet`, `inherited`;
- `pseudo` — полные данные псевдо-элементов `::before` и `::after`.

### 5. Viewport

CLI поддерживает флаг `--viewport`:

```bash
viewprint -s test capture <url> --viewport 1920x1080
viewprint -s test capture --viewport 375x812
```

Формат: `WIDTHxHEIGHT`. Если не указан, используется `1280x720`.

Viewport передаётся в HTTP API:

```json
POST /sessions/:name/capture
{
  "url": "https://example.com",
  "viewport": { "width": 1920, "height": 1080 }
}
```

### 6. Каскад CSS

Для `inspect` определяется источник каждого свойства:

- `inline` — задано в `element.style`;
- `stylesheet` — задано в CSS-правиле;
- `inherited` — унаследовано от родителя;
- `user-agent` — исключается из результата.

Оптимизация: один проход по CSS-правилам на элемент, затем быстрое определение source для каждого свойства.

### 7. Bounding box псевдо-элементов

Для `::before` и `::after` вычисляется bbox на основе `position`, `top`, `left`, `width`, `height` из `getComputedStyle(element, pseudo)`.

### 8. Архитектура демона

Демон — отдельный Node.js процесс, который:

- запускается командой `viewprint daemon start [--port 7345]`;
- хранит pid-файл в `~/.viewprint/daemon.pid`;
- пишет лог в `~/.viewprint/daemon.log`;
- слушает HTTP API на `localhost:<port>`;
- держит BrowserSession открытой между запросами.

CLI работает как клиент: проверяет демон, автозапускает, отправляет запросы.

### 9. HTTP API демона

| Метод | Путь | Тело | Ответ |
|-------|------|------|-------|
| POST | `/sessions/:name/capture` | `{ url?: string; viewport?: { width; height } }` | Snapshot `Graph` |
| POST | `/sessions/:name/snapshot` | `{ url?: string; viewport?: { width; height } }` | Accessibility `Snapshot` tree |
| POST | `/sessions/:name/inspect` | `{ elementId: string }` | Полный `ElementNode` |
| POST | `/sessions/:name/click` | `{ elementId: string }` | `{ clicked: true }` |
| GET | `/sessions/:name/status` | — | `{ url?: string; elementCount: number }` |
| DELETE | `/sessions/:name` | — | `{ closed: true }` |
| GET | `/health` | — | `{ ok: true }` |
| POST | `/shutdown` | — | `{ shuttingDown: true }` |

### 10. CLI

```bash
viewprint -s <session> capture [<url>] [--viewport WIDTHxHEIGHT]
viewprint -s <session> snapshot [<url>] [--viewport WIDTHxHEIGHT]
viewprint -s <session> inspect <elementId>
viewprint -s <session> click <elementId>
viewprint -s <session> status
viewprint -s <session> close

viewprint daemon start [--port 7345]
viewprint daemon stop
viewprint daemon status
```

### 11. Тестирование

- Unit-тесты для `buildGraph` и `session`.
- Интеграционные тесты для `BrowserSession`.
- Интеграционные тесты для `ViewPrintDaemon`.
- Все внешние зависимости (сеть, FS) замоканы где возможно.

## ### 12. Actions

Команды для взаимодействия с элементами страницы:

- `click <elementId|@e2>` — кликает по элементу.
- `fill <elementId|@e2> <text>` — устанавливает значение input/textarea.
- `type <elementId|@e2> <text>` — печатает текст посимвольно.
- `hover <elementId|@e2>` — наводит курсор.
- `focus <elementId|@e2>` — фокусирует элемент.
- `press <key>` — нажимает клавишу.
- `scroll <direction> <px> [elementId]` — прокручивает.
- `scrollintoview <elementId|@e2>` — прокручивает до видимости.
- `wait` — ожидает условия (`text`, `selector`, `fn`, `loadState`, `timeout`).
- `eval <script>` — выполняет JS и возвращает результат.
- `read [--format text|markdown]` — извлекает читаемый текст или markdown.

### 13. Batch

`batch` принимает JSON-массив команд (JSON stdin или позиционные аргументы):

```bash
viewprint -s test batch '[["capture","https://example.com"],["snapshot"],["click","@e2"]]'
echo '[["capture","https://example.com"],["snapshot"]]' | viewprint -s test batch
```

Каждый элемент — `[commandName, ...args]` или `[commandName, optionsObject]`.

### 14. Network и storage

**Network:**

- `network requests` — список отслеженных запросов (после `track start`).
- `network track start|stop` — включает/выключает отслеживание.
- `network har start|stop --path <file>` — HAR-логирование.
- `network route --url <pattern> [--body B] [--status N] [--content-type CT] [--abort]` — мокирование запросов.
- `network unroute --url <pattern>` — снимает mock.

**Storage:**

- `cookies get|set|clear` — управление cookies.
- `storage local|session get|set|clear` — localStorage и sessionStorage.

State сессии (`~/.viewprint/sessions/<name>/state.json`) включает cookies, localStorage, sessionStorage и URL. Они восстанавливаются при следующем `capture`.

### 15. Tabs, frames, screenshots

**Tabs:**

- `tabs list` — список вкладок.
- `tabs new [url]` — открыть новую вкладку.
- `tabs switch <index>` — переключиться.
- `tabs close [index]` — закрыть.

**Frames:**

- `frames list` — список фреймов.
- `frames switch <selector>` — переключиться на frame.
- `frames main` — вернуться в main frame.

**Screenshots:**

- `screenshot [path]` — скриншот страницы.
- `screenshot <path> --element <elementId|@e2>` — скриншот элемента.

Пути по умолчанию: `~/.viewprint/screenshots/<session>-<type>-<timestamp>.png`.

### 16. MCP server

`viewprint mcp` запускает Model Context Protocol сервер через stdio.

Реализует JSON-RPC 2.0 методы:

- `initialize` — инициализация MCP.
- `tools/list` — список инструментов.
- `tools/call` — вызов инструмента.

Tools: `capture`, `snapshot`, `click`, `fill`, `inspect`, `eval`, `read`, `status`.

### 17. Advanced: dialogs, diff

**Dialogs:**

- `dialog --handler '{"accept":true,"promptText":"ok"}'` — устанавливает обработчик alert/confirm/prompt.

**Diff:**

- `diff last` — сравнение текущего графа с предыдущим (added/removed/changed).

## Критерии приёмки (обновлённые)

- [x] `capture` возвращает облегчённый граф без `computedStyles`, `cascade` и `pseudo`.
- [x] `inspect <elementId>` возвращает полные данные элемента со всеми CSS-данными и псевдо-элементами.
- [x] `capture` с `--viewport 1920x1080` возвращает граф с указанным viewport.
- [x] `click` возвращает `{ clicked: true }` и не пересчитывает граф.
- [x] Граф содержит только `<body>` и потомков; `<html>`/`<head>` исключены.
- [x] Текст `<script>`/`<style>` не попадает в `text`.
- [x] **Actions**: fill, type, hover, focus, press, scroll, scrollIntoView, wait, eval.
- [x] **Batch**: JSON stdin и позиционные команды.
- [x] **Network**: requests, HAR, route, unroute.
- [x] **Storage**: cookies, localStorage, sessionStorage (get/set/clear).
- [x] **Tabs**: list, new, switch, close.
- [x] **Frames**: list, switch, main.
- [x] **Screenshots**: page и element.
- [x] **Read**: text и markdown.
- [x] **MCP server**: tools/list, tools/call через stdio.
- [x] **Dialogs**: обработчик alert/confirm/prompt.
- [x] **Diff**: сравнение графов.
- [x] Все тесты проходят (`pnpm test`).
- [x] Линтер не выдаёт ошибок (`pnpm run lint`).
