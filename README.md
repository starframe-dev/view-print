# view-print

AI-инструмент для извлечения точного графа вёрстки страницы и browser automation через Playwright. Standalone TypeScript CLI + HTTP-демон + MCP-сервер.

Используется как:
- **AI layout extractor** — структурированный JSON-граф DOM для LLM-агентов.
- **Browser automation** — клик, ввод, скриншоты, перехват запросов.
- **MCP tool** — интеграция с Claude/Cursor/другими MCP-клиентами.

## Возможности

- 🗺️ **Capture** — облегчённое дерево элементов `<body>`, раскрытое до `--depth` (default 1, свёрнутые ветки показывают `childrenCount`). `--expand <ids>` задаёт альтернативные корни (body не показывается). Флаги `--skip-load` (пропустить `goto` если URL совпадает), `--no-goto` (capture на текущей странице, URL игнорируется) и `--no-headless` (показать окно Chromium для новой сессии). Опционально `--profile` для per-action timing и `--trace <path>` для Chrome perf trace.
- 🔍 **Inspect** — вычисленные `computedStyles`, диагностические cascade-источники и псевдо-элементы для конкретного узла. Cascade-диагностика не является полной реконструкцией CSS-специфичности.
- 🌳 **Snapshot** — семантический DOM snapshot с `@e1`, `@e2` refs, `--depth` и `--expand`. Это не полное accessibility tree браузера. Узлы с HTML `id`/`class` содержат одноимённые top-level поля (`id`, `className`).
- 🎯 **Actions** — `click`, `fill`, `type`, `hover`, `focus`, `press`, `scroll`, `scrollIntoView`, `wait`, `eval`.
- 📜 **Batch** — JSON-массив команд за один запрос.
- 🌐 **Network** — вручную включаемое отслеживание (до 1000 запросов), HAR, mock `route`/`unroute`. Сбор response body по умолчанию выключен.
- 🍪 **Storage** — cookies, localStorage, sessionStorage с persist между сессиями.
- 🗂️ **Tabs & frames** — multi-tab навигация, frame switching.
- 📸 **Screenshots** — page и element.
- 📖 **Read** — извлечение text/markdown.
- 🤖 **MCP server** — stdio-сервер для интеграции с AI-агентами.
- 🔔 **Dialogs** — обработка `alert`/`confirm`/`prompt`.
- 🔄 **Diff** — сравнение графов между вызовами.
- 📊 **Profiling** — Chrome perf trace (CDP `Tracing`), per-action timing (count/avg/p50/p95/p99), HTTP middleware (JSON-lines). Команды `viewprint trace {start|stop|report|run}`, `viewprint profile {enable|disable|show|clear}`.

## Установка

Требуется Node.js 22.13 или новее. Установите пакет и браузер Playwright:

```bash
pnpm add @starframe/view-print
pnpm exec playwright install chromium
```

Затем запускайте `viewprint --help`. Для разработки и локальных проверок:

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm run lint
pnpm test
pnpm run build
```

Managed daemon process lifecycle поддерживается на macOS и Linux. Windows пока не поддерживается.

## Разработка

После правок в `src/` пересоберите пакет. Для глобально установленного CLI используйте `viewprint reinstall`: команда остановит только подтверждённый managed daemon и переустановит пакет из текущего корня проекта.

```bash
pnpm run build
viewprint reinstall
```

## Использование

### Демон

```bash
viewprint daemon start              # 127.0.0.1:7345
viewprint daemon status
viewprint daemon restart
viewprint daemon stop
```

Daemon принимает соединения только с `127.0.0.1` и требует bearer token, который хранится в приватной metadata пользователя. CLI управляет токеном автоматически. Если Chromium page/context закрылся из-за сбоя, следующая команда пересоздаёт stale-сессию и восстанавливает сохранённый state.

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

### Управление сохранённым state

```bash
viewprint -s old session rename new
viewprint -s X session export --output session.json
viewprint -s X session import session.json
viewprint -s X session import session.json --force
```

`rename` и `import` требуют закрытой сессии. `export` можно выполнять при открытом браузере. JSON не шифруется и может содержать секреты из cookies и storage.

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

Tracking хранит до 1000 запросов. Response-body capture выключен по умолчанию; при включении действует размерный лимит и редактирование чувствительных заголовков.

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

Сервер использует официальный `@modelcontextprotocol/server` v2 и stdio transport. Доступные tools: `capture`, `snapshot`, `click`, `fill`, `inspect`, `eval`, `read`, `status`, `diff_last`, `frames_list`, `frame_switch`, `frame_main`, `set_dialog_handler`.

Подключение в `claude_desktop_config.json` / `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "view-print": {
      "command": "viewprint",
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

**`inspect`** дополнительно содержит `computedStyles` (кроме `user-agent`), best-effort `cascade` (`inline`/`stylesheet`/`inherited`) и вычисленные `pseudo.before` / `pseudo.after`. Это не точная реконструкция CSS-каскада.

**Семантические поля snapshot:**
- `role` — явный `role` атрибут или implicit по тегу (`button`, `link`, `heading`, `textbox`, ...).
- `name` — эвристический порядок: `aria-labelledby` → `aria-label` → `<label>` → `alt` → `title` → `placeholder` → текст кнопки/ссылки. Snapshot не является полным accessibility tree.

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
  "viewport": { "width": 1280, "height": 720 },
  "cookies": [...],
  "localStorage": { "https://example.com": { "key": "value" } },
  "sessionStorage": { "tab-1": { "https://example.com": { "key": "value" } } },
  "tabs": [{ "id": "tab-1", "url": "https://example.com" }]
}
```

Cookies восстанавливаются через Playwright `storageState` (только cookies, без IndexedDB). localStorage разделён по origin, sessionStorage — по вкладке и origin; значения вводятся через `addInitScript` до выполнения кода приложения. Старые плоские storage maps мигрируют при загрузке. URL и вкладки восстанавливаются при новом capture без URL. Изменения state записываются с debounce и периодическим checkpoint, а при закрытии выполняется финальная синхронизация.

Состояние хранится с приватными правами файловой системы, но JSON не шифруется и может содержать авторизационные секреты. Синхронизация best-effort и не защищает от `SIGKILL`, отключения питания или истечения/отзыва cookies самим сайтом.

## Profiling

Три независимых подсистемы для диагностики производительности.

### Chrome perf trace (CDP)

`viewprint trace start` начинает CDP `Tracing`, а `trace stop` пишет JSON в формате Chrome DevTools Trace Event Format. Сбор ограничен 100 000 событиями; listeners, timer и CDP session освобождаются после stop/закрытия. Открой файл в `chrome://tracing` или `ui.perfetto.dev`.

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

Полезно с профилированием — чтобы измерять только действие, а не navigation. Обычная навигация ждёт `DOMContentLoaded`, а не событие полного `load`: динамические сайты вроде Threads могут продолжать загружать фоновые ресурсы бесконечно.

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

Daemon слушает только `127.0.0.1`; все endpoints, включая health и shutdown, требуют bearer token. JSON body ограничен 1 MiB по умолчанию. Token и PID/instance metadata хранятся в `~/.viewprint/daemons` с правами `0600`, а каталог — `0700`.

Каждый HTTP-запрос к daemon автоматически логируется как JSON-line в stderr. Опционально писать в файл через env `VIEWPRINT_HTTP_TRACE_FILE`.

## Архитектура

```
src/
├── cli.ts           # Commander CLI (клиент демона)
├── daemon.ts        # HTTP API сервер
├── daemon-client.ts # HTTP-клиент к демону
├── daemon-process.ts # Управление процессом демона
├── daemon-entry.ts  # Entry point демона
├── daemon-metadata.ts # Private daemon identity/token metadata
├── browser.ts       # BrowserSession (Playwright)
├── extractor.ts     # extractSnapshotData, inspectElement (page.evaluate)
├── graph.ts         # buildGraph
├── tracing.ts       # Chrome perf trace (CDP Tracing)
├── session.ts       # State persistence (FS JSON)
├── diff.ts          # diffGraphs
├── mcp.ts           # MCP server (stdio, official @modelcontextprotocol/server v2)
├── index.ts         # Публичное API
└── types.ts         # Типы
```

## HTTP API

| Метод | Путь | Назначение |
|-------|------|------------|
| POST | `/sessions/:name/capture` | Capture дерева (`{ url?, viewport?, depth?, expand? }`) |
| POST | `/sessions/:name/snapshot` | Семантический DOM snapshot (`{ url?, viewport?, depth?, expand? }`) |
| POST | `/sessions/:name/inspect` | Computed styles и диагностические данные элемента |
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
| GET | `/health` | Authenticated health check |
| POST | `/shutdown` | Authenticated daemon shutdown |
| POST/GET/DELETE | `/sessions/:name/profile` | Per-action profiling enable/get/clear |
| POST | `/sessions/:name/trace/start` | Start Chrome perf trace |
| POST | `/sessions/:name/trace/stop` | Stop trace + write JSON file |
| GET | `/sessions/:name/trace/report` | Trace report (summary) |
| POST | `/sessions/:name/rename` | Rename saved state (closed session only) |
| GET | `/sessions/:name/export` | Export saved state |
| POST | `/sessions/:name/import` | Import saved state (`force` optional) |

## Разработка

```bash
pnpm run lint   # tsc --noEmit
pnpm run build  # tsc
pnpm test       # vitest run
```

### Структура тестов

- `tests/graph.test.ts` — `buildGraph` unit tests
- `tests/session.test.ts` — state load/save с `memfs`
- `tests/process-tree.test.ts` — shell-free process-tree tests
- `tests/tracing.test.ts` — bounded trace cleanup с fake CDP и моками FS
- `tests/mcp.test.ts` — официальный MCP v2 transport и tool registration
- `tests/cli.test.ts` — CLI async parser и managed daemon lifecycle
- `tests/browser.test.ts` — `BrowserSession` интеграционные (Playwright + локальный HTTP server)
- `tests/daemon.test.ts` — auth/body limits, session HTTP API, diff/dialog и daemon shutdown
- `scripts/smoke-package.mjs` — tarball whitelist, install/import, CLI и recovery smoke

Число passing tests сверяйте по выводу `pnpm test`; release smoke дополнительно устанавливает tarball и проверяет библиотечный import и daemon lifecycle.

### Принципы

- TypeScript ESM, 4-space indent, no semicolons.
- `pnpm` для пакетов.
- Vitest, 30-second timeout для Playwright тестов.
- Все внешние зависимости (network, FS) замоканы где возможно.

## Решённые проблемы

### IndexedDB ошибка в data: URL

`storageState` с `origins` восстанавливает IndexedDB, что запрещено на `data:`. Решение: `buildStorageState` сохраняет только cookies и localStorage; sessionStorage восстанавливается `addInitScript`-ом до запуска кода страницы.

### `Object.entries(localStorage)` пустой

В сериализованном контексте Playwright `Object.entries(localStorage)` возвращает пустой массив. Решение: `getLocalStorage`/`getSessionStorage` используют цикл `localStorage.key(i)` + `getItem(key)`.

### Session state pollution

`BrowserSession.start()` автоматически переходил на сохранённый URL, ломая тесты с `data:` URL. Решение: `start()` не делает auto-goto; `capture` управляет навигацией.

### Click зависает на data: URL

`waitForLoadState('networkidle')` не срабатывает на `data:`. Решение: `page.waitForTimeout(100)`.

### Висящие процессы Chromium после остановки

`BrowserSession.close()` закрывает Playwright browser server, затем при необходимости завершает browser process tree и процессы с уникальным user-data directory. Process lookup использует `execFileSync` с аргументами без shell interpolation. Managed daemon останавливается только после проверки PID, command line и instance ID; process management явно поддержан на macOS и Linux.

## Лицензия

MIT