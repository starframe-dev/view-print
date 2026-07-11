# view-print

AI-инструмент для извлечения точного графа вёрстки страницы и browser automation через Playwright. Standalone TypeScript CLI + HTTP-демон + MCP-сервер.

Используется как:
- **AI layout extractor** — структурированный JSON-граф DOM для LLM-агентов.
- **Browser automation** — клик, ввод, скриншоты, перехват запросов.
- **MCP tool** — интеграция с Claude/Cursor/другими MCP-клиентами.

## Возможности

- 🗺️ **Capture** — облегчённый граф элементов `<body>` с `parentId`, `role`, `name`, `boundingBox`.
- 🔍 **Inspect** — полные `computedStyles`, `cascade` и псевдо-элементы для конкретного узла.
- 🌳 **Snapshot** — accessibility tree с `@e1`, `@e2` refs.
- 🎯 **Actions** — `click`, `fill`, `type`, `hover`, `focus`, `press`, `scroll`, `scrollIntoView`, `wait`, `eval`.
- 📜 **Batch** — JSON-массив команд за один запрос.
- 🌐 **Network** — отслеживание, HAR, mock `route`/`unroute`.
- 🍪 **Storage** — cookies, localStorage, sessionStorage с persist между сессиями.
- 🗂️ **Tabs & frames** — multi-tab навигация, frame switching.
- 📸 **Screenshots** — page и element.
- 📖 **Read** — извлечение text/markdown.
- 🤖 **MCP server** — stdio-сервер для интеграции с AI-агентами.
- 🔔 **Dialogs** — обработка `alert`/`confirm`/`prompt`.
- 🔄 **Diff** — сравнение графов между вызовами.

## Установка

```bash
cd /Users/a/Space/Projects/Starframe/view-print
pnpm install
pnpm exec playwright install chromium
pnpm run build
```

Затем установите CLI wrapper:

```bash
ln -sf /Users/a/Space/Projects/Starframe/view-print/dist/src/cli.js ~/Space/Tools/bin/viewprint
```

## Использование

### Демон

```bash
viewprint daemon start              # localhost:7345
viewprint daemon status
viewprint daemon stop
```

### Capture / snapshot

```bash
viewprint -s mypage capture https://example.com
viewprint -s mypage capture --viewport 1920x1080
viewprint -s mypage snapshot https://example.com
viewprint -s mypage inspect @e3    # full CSS details
viewprint -s mypage click @e3      # click by ref
viewprint -s mypage status
viewprint -s mypage close
```

### Actions

```bash
viewprint -s mypage fill @e5 "hello@example.com"
viewprint -s mypage type @e5 "search query"
viewprint -s mypage press Enter
viewprint -s mypage hover @e4
viewprint -s mypage scroll down 500
viewprint -s mypage wait --text "Ready"
viewprint -s mypage eval "document.title"
viewprint -s mypage read --format markdown
```

### Batch

```bash
viewprint -s mypage batch '[["capture","https://example.com"],["snapshot"],["click","@e2"]]'
echo '[["capture","https://example.com"],["snapshot"]]' | viewprint -s mypage batch
```

### Network

```bash
viewprint -s mypage network track start
viewprint -s mypage network requests
viewprint -s mypage network route --url "**/api/data" --body '{"ok":true}'
viewprint -s mypage network har start --path ./capture.har
```

### Storage

```bash
viewprint -s mypage cookies set session abc
viewprint -s mypage storage local set theme dark
viewprint -s mypage storage local get
viewprint -s mypage storage local clear
```

### Tabs / frames / screenshot

```bash
viewprint -s mypage tabs list
viewprint -s mypage tabs new https://other.com
viewprint -s mypage frames list
viewprint -s mypage frames switch iframe[name=widget]
viewprint -s mypage screenshot /tmp/page.png
viewprint -s mypage screenshot --element @e3
```

### MCP server

```bash
viewprint mcp
```

Доступные tools: `capture`, `snapshot`, `click`, `fill`, `inspect`, `eval`, `read`, `status`.

Подключение в `claude_desktop_config.json` / `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "view-print": {
      "command": "/Users/a/Space/Projects/Starframe/view-print/dist/src/cli.js",
      "args": ["mcp"]
    }
  }
}
```

## Граф

Плоский JSON. Связи между узлами задаются через `parentId` внутри каждого узла. Корневой элемент — `<body>`. `<html>` и `<head>` исключены. Текст `<script>` и `<style>` не включается.

```json
{
  "url": "https://example.com",
  "viewport": { "width": 1920, "height": 1080 },
  "nodes": {
    "e1": { "id": "e1", "tag": "body", "parentId": null, "boundingBox": {...} },
    "e2": { "id": "e2", "tag": "div", "parentId": "e1", "role": "main", "name": "...", "boundingBox": {...} },
    "e3": { "id": "e3", "tag": "button", "parentId": "e2", "role": "button", "name": "Submit", "text": "Submit", "boundingBox": {...} }
  }
}
```

**Snapshot-узел** содержит: `id`, `parentId`, `tag`, `role`, `name`, `attributes`, `text`, `boundingBox`.

**Полный узел (`inspect`)** дополнительно содержит: `computedStyles` (только non-`user-agent`), `cascade` (`inline`/`stylesheet`/`inherited`), `pseudo.before`, `pseudo.after`.

**Accessibility:**
- `role` — явный `role` атрибут или implicit по тегу (`button`, `link`, `heading`, `textbox`, ...).
- `name` — `aria-labelledby` → `aria-label` → `<label>` → `alt` → `title` → `placeholder` → текст кнопки/ссылки.

**Текст:**
- `text` заполняется только из **непосредственных** текстовых child-nodes (без рекурсии в дочерние элементы).
- Содержимое `<script>`/`<style>` исключено для всех элементов.

## State persistence

Каждая сессия сохраняется в `~/.viewprint/sessions/<name>/state.json`:

```json
{
  "name": "mypage",
  "url": "https://example.com",
  "cookies": [...],
  "localStorage": { "key": "value" },
  "sessionStorage": { "key": "value" }
}
```

Cookies восстанавливаются через Playwright `storageState` (только cookies, без IndexedDB). localStorage / sessionStorage восстанавливаются через `page.evaluate` после `goto`.

## Архитектура

```
src/
├── cli.ts           # Commander CLI (клиент демона)
├── daemon.ts        # HTTP API сервер
├── daemon-client.ts # HTTP-клиент к демону
├── daemon-process.ts # Управление процессом демона
├── daemon-entry.ts  # Entry point демона
├── browser.ts       # BrowserSession (Playwright)
├── extractor.ts     # extractSnapshotData, inspectElement (page.evaluate)
├── graph.ts         # buildGraph
├── session.ts       # State persistence (FS JSON)
├── diff.ts          # diffGraphs
├── mcp.ts           # MCP server (stdio, JSON-RPC 2.0)
├── index.ts         # Публичное API
└── types.ts         # Типы
```

## HTTP API

| Метод | Путь | Назначение |
|-------|------|------------|
| POST | `/sessions/:name/capture` | Capture графа |
| POST | `/sessions/:name/snapshot` | Accessibility snapshot |
| POST | `/sessions/:name/inspect` | Полные данные элемента |
| POST | `/sessions/:name/click` / `fill` / `type` / `hover` / `focus` / `press` / `scroll` / `scrollintoview` | Actions |
| POST | `/sessions/:name/wait` | Wait condition |
| POST | `/sessions/:name/eval` | Eval JS |
| POST | `/sessions/:name/read` | Extract text/markdown |
| POST | `/sessions/:name/batch` | Batch commands |
| POST | `/sessions/:name/network/track/{start,stop}` | Network tracking |
| POST | `/sessions/:name/network/har/{start,stop}` | HAR logging |
| POST | `/sessions/:name/network/route` / `unroute` | Mock requests |
| GET/POST | `/sessions/:name/cookies[/set\|/clear]` | Cookies |
| GET/POST | `/sessions/:name/storage/{local,session}[/set\|/clear]` | Storage |
| POST | `/sessions/:name/tabs/{new,switch,close}` / GET `/tabs` | Tabs |
| POST | `/sessions/:name/frames/{switch,main}` / GET `/frames` | Frames |
| POST | `/sessions/:name/screenshot/{page,element}` | Screenshots |
| POST | `/sessions/:name/dialog` | Dialog handler |
| GET | `/sessions/:name/diff/last` | Diff с предыдущим графом |
| GET | `/sessions/:name/status` | Session status |
| DELETE | `/sessions/:name` | Close session |
| GET | `/health` | Health check |
| POST | `/shutdown` | Shutdown daemon |

## Разработка

```bash
pnpm run lint   # tsc --noEmit
pnpm run build  # tsc
pnpm test       # vitest run
```

### Структура тестов

- `tests/graph.test.ts` — `buildGraph` unit tests
- `tests/session.test.ts` — state load/save с `memfs`
- `tests/browser.test.ts` — `BrowserSession` интеграционные (Playwright + http server)
- `tests/daemon.test.ts` — `ViewPrintDaemon` HTTP API

### Принципы

- TypeScript ESM, 4-space indent, no semicolons.
- `pnpm` для пакетов.
- Vitest, 30-second timeout для Playwright тестов.
- Все внешние зависимости (network, FS) замоканы где возможно.

## Решённые проблемы

### IndexedDB ошибка в data: URL

`storageState` с `origins` восстанавливает IndexedDB, что запрещено на `data:`. Решение: `buildStorageState` возвращает только cookies; localStorage/sessionStorage восстанавливаются через `page.evaluate`.

### `Object.entries(localStorage)` пустой

В сериализованном контексте Playwright `Object.entries(localStorage)` возвращает пустой массив. Решение: `getLocalStorage`/`getSessionStorage` используют цикл `localStorage.key(i)` + `getItem(key)`.

### Session state pollution

`BrowserSession.start()` автоматически переходил на сохранённый URL, ломая тесты с `data:` URL. Решение: `start()` не делает auto-goto; `capture` управляет навигацией.

### Click зависает на data: URL

`waitForLoadState('networkidle')` не срабатывает на `data:`. Решение: `page.waitForTimeout(100)`.

## Лицензия

MIT