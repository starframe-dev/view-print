# view-print

AI-инструмент для извлечения точного графа вёрстки страницы и browser automation через Playwright. Standalone TypeScript CLI + HTTP-демон + MCP-сервер.

Используется как:
- **AI layout extractor** — структурированный JSON-граф DOM для LLM-агентов.
- **Browser automation** — клик, ввод, скриншоты, перехват запросов.
- **MCP tool** — интеграция с Claude/Cursor/другими MCP-клиентами.

## Возможности

- 🗺️ **Capture** — облегчённое дерево элементов `<body>`, раскрытое до `--depth` (default 1, свёрнутые ветки показывают `childrenCount`). `--expand <ids>` задаёт альтернативные корни (body не показывается). Флаги `--skip-load` (пропустить `goto` если URL совпадает), `--no-goto` (capture на текущей странице, URL игнорируется) и `--no-headless` (показать окно Chromium для новой сессии). Опционально `--profile` для per-action timing и `--trace <path>` для Chrome perf trace.
- 🔍 **Inspect** — полные `computedStyles`, `cascade` и псевдо-элементы для конкретного узла.
- 🌳 **Snapshot** — accessibility tree с `@e1`, `@e2` refs, `--depth` и `--expand`. Узлы с HTML `id`/`class` содержат одноимённые top-level поля (`id`, `className`).
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
- 📊 **Profiling** — Chrome perf trace (CDP `Tracing`), per-action timing (count/avg/p50/p95/p99), HTTP middleware (JSON-lines). Команды `viewprint trace {start|stop|report|run}`, `viewprint profile {enable|disable|show|clear}`.

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

## Разработка

После правок в `src/` нужно пересобрать и переустановить глобальный бинарь, а также убить daemon (иначе новый код не подхватится):

```bash
pnpm run deploy      # lint → test → build → reinstall-global
# или
pnpm run build && viewprint reinstall
```

`viewprint reinstall` — перелинковывает глобальный бинарь на текущий проект и убивает daemon.

## Использование

### Демон

```bash
viewprint daemon start              # localhost:7345
viewprint daemon status
viewprint daemon stop
```

### Capture / snapshot

```bash
viewprint -s mypage capture https://example.com                  # default: depth=1 (only top level)
viewprint -s mypage capture https://example.com --depth 3        # expand 3 levels
viewprint -s mypage capture https://example.com --expand e3,e5   # expand specific subtrees
viewprint -s mypage capture https://example.com --depth 1 --expand e3   # top level + subtree
viewprint -s mypage capture https://example.com --query "button"      # all buttons as roots
viewprint -s mypage capture https://example.com --query ".product-card" --depth 3   # cards + 3 levels
viewprint -s mypage capture https://example.com --no-headless   # show Chromium window for this session
viewprint -s mypage capture --viewport 1920x1080
viewprint -s mypage snapshot https://example.com
viewprint -s mypage snapshot https://example.com --depth 9999   # full tree
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
viewprint -s mypage screenshot --element @e3 --padding 20     # с отступом вокруг элемента
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

## Граф (capture / snapshot)

Обе команды возвращают **дерево** с корнем `<body>`. Связи задаются через вложенные `children`. Свёрнутые ветки показывают `childrenCount` (число прямых потомков) и `children: []`.

- `--depth N` (default `1`): базовая глубина раскрытия. `1` — только верхний уровень, `9999` — всё дерево.
- `--expand <ids>`: comma-separated список id (`e3,e5,e7` или `@e3,@e5,@e7`). Указанные id становятся **корнями** дерева (body в результате не показывается). depth отсчитывается от каждого root независимо. Несколько id → несколько корней. Неизвестные id тихо игнорируются.

`<html>` и `<head>` исключены. Текст `<script>` и `<style>` не включается.

```json
{
  "url": "https://example.com",
  "viewport": { "width": 1920, "height": 1080 },
  "tree": [
    {
      "id": "e1",
      "tag": "body",
      "childrenCount": 2,
      "children": [
        { "id": "e2", "tag": "div", "role": "main", "childrenCount": 1, "children": [] },
        { "id": "e3", "tag": "button", "role": "button", "name": "Submit", "text": "Submit", "childrenCount": 0, "children": [] }
      ]
    }
  ]
}
```

`childrenCount` присутствует **всегда**: у раскрытых узлов — равен длине `children`, у свёрнутых — числу скрытых потомков, у листьев — `0`. Это единое правило.

**Capture-узел** содержит: `id`, `parentId`, `tag`, `role`, `name`, `attributes`, `text`, `boundingBox`, `childrenCount`, `children`.

**Snapshot-узел** содержит: `ref` (наш `id`), `tag`, `role`, `name`, `text`, `id` (HTML-атрибут, если есть), `className` (HTML-атрибут, если есть), `boundingBox`, `childrenCount`, `children`. Поля `id`/`className` — top-level, не внутри attributes, для удобного построения CSS-селекторов.

**Полный узел (`inspect`)** дополнительно содержит: `computedStyles` (только non-`user-agent`), `cascade` (`inline`/`stylesheet`/`inherited`), `pseudo.before`, `pseudo.after`.

**Accessibility:**
- `role` — явный `role` атрибут или implicit по тегу (`button`, `link`, `heading`, `textbox`, ...).
- `name` — `aria-labelledby` → `aria-label` → `<label>` → `alt` → `title` → `placeholder` → текст кнопки/ссылки.

**Текст:**
- `text` заполняется только из **непосредственных** текстовых child-nodes (без рекурсии в дочерние элементы).
- Содержимое `<script>`/`<style>` исключено для всех элементов.

**Snapshot lift:** на раскрытых уровнях пустые контейнеры (без `role`/`name`/`text`) поднимаются, их дети всплывают наверх. На свёрнутых уровнях lift не применяется, пустой контейнер показывается как stub с `childrenCount`.

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

## Profiling

Три независимых подсистемы для диагностики производительности.

### Chrome perf trace (CDP)

`viewprint trace start` оборачивает `capture` в CDP `Tracing.start`/`Tracing.end` и пишет JSON в формате Chrome DevTools Trace Event Format. Открой в `chrome://tracing` или `ui.perfetto.dev`.

```bash
viewprint -s X trace start [--categories c1,c2,...]
viewprint -s X capture URL                # действия между start и stop
viewprint -s X trace stop --output trace.json
```

### Per-action timing

`viewprint profile enable` измеряет длительность каждого action в `BrowserSession` (capture/click/fill/wait/eval/...). Возвращает count, totalMs, avgMs, p50/p95/p99, byAction.

```bash
viewprint -s X profile enable
viewprint -s X capture URL
viewprint -s X profile show
viewprint -s X profile clear
viewprint -s X profile disable
```

### Удобные флаги на `capture`

```bash
viewprint -s X capture URL --profile               # per-action timing в stderr
viewprint -s X capture URL --trace /tmp/page.json  # Chrome perf trace в файл
viewprint -s X capture URL --profile --trace /tmp/page.json  # оба вместе
```

### Skip / no navigation

Полезно с профилированием — чтобы измерять только действие, а не navigation.

```bash
viewprint -s X capture URL --skip-load    # не делать goto если URL уже совпадает
viewprint -s X capture URL --no-goto      # capture на текущей странице, URL игнорируется
viewprint -s X capture URL --no-headless  # показать Chromium; действует при создании новой сессии
```

### Видимый режим Chromium

`--no-headless` запускает видимое окно Chromium только при создании новой сессии. Без флага Chromium запускается headless. Если сессия уже существует, её режим не меняется; для смены режима закрой сессию и создай её снова:

```bash
viewprint -s X capture https://example.com --no-headless
viewprint -s X close
```

Флаг относится только к `capture` и не меняет режим других сессий.

### Trace без capture: `trace run`

Оборачивает произвольные команды в trace session без `capture`.

```bash
viewprint -s X trace run --actions '[["tabs","new","https://example.com"],["wait",{"text":"Loaded"}],["click","@e3"]]'
echo '[["click","@e3"],["fill","@e5","hello"]]' | viewprint -s X trace run
```

### HTTP middleware

Каждый HTTP-запрос к daemon автоматически логируется как JSON-line в stderr. Опционально писать в файл через env `VIEWPRINT_HTTP_TRACE_FILE`.

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
├── tracing.ts       # Chrome perf trace (CDP Tracing)
├── session.ts       # State persistence (FS JSON)
├── diff.ts          # diffGraphs
├── mcp.ts           # MCP server (stdio, JSON-RPC 2.0)
├── index.ts         # Публичное API
└── types.ts         # Типы
```

## HTTP API

| Метод | Путь | Назначение |
|-------|------|------------|
| POST | `/sessions/:name/capture` | Capture дерева (`{ url?, viewport?, depth?, expand? }`) |
| POST | `/sessions/:name/snapshot` | Accessibility snapshot дерева (`{ url?, viewport?, depth?, expand? }`) |
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
| POST/GET/DELETE | `/sessions/:name/profile` | Per-action profiling enable/get/clear |
| POST | `/sessions/:name/trace/start` | Start Chrome perf trace |
| POST | `/sessions/:name/trace/stop` | Stop trace + write JSON file |
| GET | `/sessions/:name/trace/report` | Trace report (summary) |

## Разработка

```bash
pnpm run lint   # tsc --noEmit
pnpm run build  # tsc
pnpm test       # vitest run
```

### Структура тестов

- `tests/graph.test.ts` — `buildGraph` unit tests
- `tests/session.test.ts` — state load/save с `memfs`
- `tests/process-tree.test.ts` — `process-tree.ts` unit tests
- `tests/tracing.test.ts` — `TracingSession` unit tests
- `tests/browser.test.ts` — `BrowserSession` интеграционные (Playwright + http server)
- `tests/daemon.test.ts` — `ViewPrintDaemon` HTTP API

**87/87 тестов passing**.

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

### Висящие chrome-headless-shell после остановки

`BrowserSession.close()` использует тройную страховку: graceful Playwright close → `killProcessTree(browserPid)` (если Playwright отдал PID через `launchServer`) → `killChromeProcessesByUserDataDir(dir)` (поиск по `ps | grep --user-data-dir`). Дополнительно `daemon.stop()` вызывает `killRemainingDescendants()` (SIGKILL всем потомкам демона через `pgrep -P` рекурсивно), а `daemon-entry.ts` `process.on('exit')` синхронно SIGKILL-ит потомков если event loop умер до async cleanup.

## Лицензия

MIT