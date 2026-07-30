# view-print: tree-mode для capture и snapshot

## Контекст

Сейчас `capture` возвращает плоский JSON `nodes: Record<id, node>` (по сути adjacency list) со всеми элементами `<body>`. `snapshot` возвращает иерархическое дерево, но всё равно полностью развёрнутое. Оба варианта дают **слишком много данных** для LLM-агента, если страница сложная: на типичном лендинге — сотни нод, и большая часть context window уходит в детали DOM, которые не нужны на первом шаге.

Нужно: дефолт — только верхний уровень, по запросу — раскрытие вглубь через `--depth N`. Свёрнутые ветки показываются как `childrenCount` (число прямых потомков), без перечисления.

## Цель

1. `capture` и `snapshot` принимают флаг `--depth N` (default `1`).
2. При depth `N`:
   - `depth = 1`: корень + его прямые дети, у каждого ребёнка — `childrenCount` (число прямых внуков), `children: []`.
   - `depth = N`: раскрыто `N` уровней от корня. На уровне `N` — `childrenCount` без раскрытия.
   - `depth` очень большое (например, `9999`) — раскрыто всё.
3. `capture` теперь возвращает дерево, а не плоский adjacency list. Это **breaking change** по сравнению с v0.1.x.
4. `snapshot` остаётся по структуре деревом, но получает параметр `depth` и поле `childrenCount` у каждого узла.
5. HTTP API, daemon-client, MCP, batch — все поддерживают `depth`.

## Что изменится

1. `specs/tree-mode.md` — настоящая спецификация.
2. `specs/view-print.md` — обновить секции 3 (Capture), 3 (Snapshot) и критерии приёмки.
3. `src/types.ts` — `Graph.nodes` → `Graph.tree`, добавить `CaptureNode`, добавить `childrenCount` в `SnapshotNode`.
4. `src/graph.ts` — `buildGraph` принимает `depth` и возвращает дерево.
5. `src/browser.ts` — `capture`/`snapshot` принимают `depth`; `buildSnapshotChildren` → `buildSnapshotTree` с depth.
6. `src/cli.ts` — добавить `--depth <N>` в `capture` и `snapshot`.
7. `src/daemon.ts` — `capture`/`snapshot` HTTP endpoints парсят `depth`; `executeBatch` пробрасывает depth.
8. `src/daemon-client.ts` — `capture`/`snapshot` принимают `depth`.
9. `src/mcp.ts` — `capture`/`snapshot` tools принимают `depth`.
10. `src/diff.ts` — обход дерева вместо плоского `nodes`.
11. `src/index.ts` — экспорт `CaptureNode`.
12. `tests/graph.test.ts` — обновить существующие тесты под tree, добавить тесты на `depth`.
13. `tests/browser.test.ts` — обновить существующие capture/snapshot тесты.
14. `tests/daemon.test.ts` — обновить capture/snapshot тесты, добавить depth-тесты.
15. `README.md` — добавить `--depth`, обновить примеры.
16. `~/.ai/just/pi/skills/knowledge_view-print/SKILL.md` — обновить таблицу `Graph vs Snapshot vs Inspect` и описание `capture`/`snapshot`.

## Детали реализации

### 1. Формат `CaptureNode`

```ts
interface CaptureNode {
    id: string
    parentId?: string
    tag: string
    role?: string
    name?: string
    attributes: Record<string, string>
    text?: string
    boundingBox: BoundingBox
    childrenCount: number   // число прямых детей (всегда)
    children: CaptureNode[] // [] если свёрнуто (level >= depth)
}
```

`childrenCount` присутствует **всегда**, в том числе у раскрытых узлов (= числу элементов в `children`) и у листьев (= 0). Это единое правило.

### 2. Формат `SnapshotNode` (обновлённый)

```ts
interface SnapshotNode {
    ref: string
    tag: string
    role?: string
    name?: string
    text?: string
    boundingBox: BoundingBox
    childrenCount: number
    children: SnapshotNode[]
}
```

### 3. `Graph` (breaking change)

Было:
```json
{
  "url": "...",
  "viewport": { "width": 1280, "height": 720 },
  "nodes": { "e1": {...}, "e2": {...} }
}
```

Стало:
```json
{
  "url": "...",
  "viewport": { "width": 1280, "height": 720 },
  "tree": [
    {
      "id": "e1",
      "tag": "body",
      "boundingBox": {...},
      "childrenCount": 12,
      "children": [
        {
          "id": "e2",
          "tag": "header",
          "childrenCount": 3,
          "children": []
        }
      ]
    }
  ]
}
```

### 4. Алгоритм `buildGraph` с depth и expand

```ts
function buildGraph(
    rawData: RawSnapshotElement[],
    url: string,
    viewport: { width: number; height: number },
    depth: number = 1,
    expand: Set<string> = new Set()
): Graph {
    const nodes: Record<string, SnapshotElementNode> = {}
    for (const raw of rawData) {
        nodes[raw.id] = { ... }
    }

    if (expand.size === 0) {
        // Без expand: корень = body
        const root = Object.values(nodes).find((n) => n.parentId === undefined)
        if (!root) return { url, viewport, tree: [] }
        return { url, viewport, tree: [visitCapture(root.id, nodes, 0, depth)] }
    }

    // С expand: каждый указанный id становится корнем. body не показывается.
    // Неизвестные id тихо игнорируются.
    const tree: CaptureNode[] = []
    for (const id of expand) {
        if (nodes[id]) tree.push(visitCapture(id, nodes, 0, depth))
    }
    return { url, viewport, tree }
}

function visitCapture(
    id: string,
    nodes: Record<string, SnapshotElementNode>,
    level: number,
    maxDepth: number
): CaptureNode {
    const node = nodes[id]
    const childIds = collectDirectChildIds(nodes, id)

    const base: CaptureNode = {
        id: node.id,
        parentId: node.parentId,
        tag: node.tag,
        role: node.role,
        name: node.name,
        attributes: node.attributes,
        text: node.text,
        boundingBox: node.boundingBox,
        childrenCount: childIds.length,
        children: []
    }

    if (level >= maxDepth) return base

    return {
        ...base,
        children: childIds.map((cid) => visitCapture(cid, nodes, level + 1, maxDepth))
    }
}
```

**Примеры:**

- `depth=1, expand=∅`: `tree = [body]`. body + его прямые дети свёрнуты (только `childrenCount`).
- `depth=9999, expand=∅`: `tree = [body]` со всем поддеревом.
- `depth=1, expand={e3}`: `tree = [e3]`. e3 (корень) + его прямые дети свёрнуты как stubs.
- `depth=9999, expand={e3}`: `tree = [e3]` со всем поддеревом e3.
- `depth=2, expand={e3,e5}`: `tree = [e3, e5]`. Каждый корень раскрыт до depth=2.

Id, указанные в `--expand`, но отсутствующие в графе, тихо игнорируются. Если все id неизвестны — `tree = []`. Можно указывать с префиксом `@` (`@e3`) или без — нормализация на стороне парсера.

### 5. Алгоритм `buildSnapshotTree` с depth и expand

`buildSnapshotTree` обходит `CaptureNode.children` рекурсивно. Для `snapshot` корни берутся из `graph.tree` (где `expand` уже превратил указанные id в корни). Логика lift сохраняется:

```ts
function buildSnapshotTree(children: CaptureNode[]): SnapshotNode[] {
    const result: SnapshotNode[] = []

    for (const child of children) {
        const expandedChildren = child.children.length > 0
            ? buildSnapshotTree(child.children)
            : []
        const hasMeaningfulContent = child.role || child.name || child.text

        if (hasMeaningfulContent) {
            result.push({ ref: child.id, ..., children: expandedChildren })
        } else if (expandedChildren.length > 0) {
            // Lift empty container: promote grandchildren up
            result.push(...expandedChildren)
        } else {
            // Collapsed empty container: stub with childrenCount
            result.push({ ref: child.id, ..., children: [] })
        }
    }

    return result
}
```

`lift` (подъём пустых контейнеров) применяется, когда у ноды есть раскрытые дети. Для свёрнутых нод lift не применяется.

### 6. CLI

```bash
viewprint -s <session> capture [<url>] [--viewport WIDTHxHEIGHT] [--depth N] [--expand <ids>]
viewprint -s <session> snapshot [<url>] [--viewport WIDTHxHEIGHT] [--depth N] [--expand <ids>]
```

- `--depth N` — целое `>= 1`. Default `1`. Для полного раскрытия — `--depth 9999`.
- `--expand <ids>` — comma-separated список id (`e3,e5,e7` или `@e3,@e5,@e7`). Указанные id становятся **корнями** дерева (вместо body, который в результате не показывается). Можно комбинировать с `--depth`.

Примеры:

```bash
# Только верхний уровень (body + прямые дети свёрнуты)
viewprint -s landing capture URL

# Раскрыть 3 уровня от body
viewprint -s landing capture URL --depth 3

# Запросить поддерево конкретной ноды (body не показывается)
viewprint -s landing capture URL --expand e3 --depth 9999

# Несколько корней
viewprint -s landing capture URL --expand e3,e5
```

### 7. HTTP API

```
POST /sessions/:name/capture
{
  "url": "https://...",
  "viewport": { "width": 1280, "height": 720 },
  "depth": 1,
  "expand": ["e3", "e5"]
}

POST /sessions/:name/snapshot
{
  "url": "https://...",
  "viewport": { "width": 1280, "height": 720 },
  "depth": 1,
  "expand": ["e3"]
}
```

`depth` и `expand` опциональны, default `depth=1`, `expand=[]` на стороне демона.

### 8. MCP

В `inputSchema` `capture` и `snapshot` добавляется:

```ts
{
  type: 'object',
  properties: {
    url: { type: 'string' },
    viewport: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } } },
    depth: { type: 'number', description: 'Tree depth to expand (default 1). Use a large number for full expansion.' },
    expand: {
      type: 'array',
      items: { type: 'string' },
      description: 'Element ids to expand fully, regardless of depth. Accepts ids with or without @ prefix.'
    }
  }
}
```

### 9. Batch

Элементы batch могут передавать `depth` и `expand` в options-объекте:

```json
[["capture", { "url": "https://example.com", "depth": 2, "expand": ["e3", "e5"] }]]
[["snapshot", { "depth": 1, "expand": ["e3"] }]]
```

### 10. Diff

`diffGraphs` обходит оба дерева и собирает плоский `Record<id, node>` для сравнения. Логика сравнения полей (`text`, `name`, `attributes`, `boundingBox`) остаётся прежней.

```ts
function flattenTree(tree: CaptureNode[]): Record<string, CaptureNode> {
    const result: Record<string, CaptureNode> = {}
    function walk(node: CaptureNode) {
        result[node.id] = node
        for (const child of node.children) walk(child)
    }
    for (const root of tree) walk(root)
    return result
}
```

### 11. `lastGraph` в BrowserSession

Хранит последний `Graph` (tree) для `diff last`. Внутри также можно хранить `lastRawGraph: Record<id, node>` — сырой результат extraction до collapse — для возможного будущего использования (пока не нужно, оставляем только `lastGraph`).

### 12. Breaking change: capture

`capture` больше не возвращает `nodes: Record<id, node>`. Потребители, использующие `Object.entries(graph.nodes)`, должны перейти на обход `graph.tree`. В семантическом-версионировании это major bump (например, `0.1.1` → `0.2.0`).

`status` команда возвращает `elementCount` — это счётчик **всех** элементов, не меняется.

`diff last` остаётся совместимым по контракту (сравнивает ноды по id), но внутри работает с tree.

## Критерии приёмки

- [ ] `viewprint -s X capture URL` без флагов возвращает `tree` с `depth=1`: body + его дети, у каждого ребёнка `childrenCount` и `children: []`.
- [ ] `viewprint -s X capture URL --depth 3` возвращает дерево с 3 раскрытыми уровнями; на 4-м уровне — `childrenCount`.
- [ ] `viewprint -s X capture URL --depth 9999` раскрывает всё дерево.
- [ ] `viewprint -s X capture URL --expand e3,e5` возвращает `tree` где `e3` и `e5` — корни (body в результате отсутствует).
- [ ] `viewprint -s X capture URL --expand e3 --depth 9999` возвращает дерево с корнем `e3` и всем его поддеревом.
- [ ] `viewprint -s X snapshot URL` имеет тот же формат поведения, что и capture, но без `attributes` и с `ref` вместо `id`.
- [ ] `snapshot` сохраняет lift-логику на раскрытых уровнях; на свёрнутых — `childrenCount` без lift.
- [ ] HTTP API `/sessions/:name/capture` и `/sessions/:name/snapshot` принимают `depth` и `expand` в body.
- [ ] MCP tools `capture` и `snapshot` принимают `depth` и `expand`.
- [ ] Batch поддерживает `depth` и `expand` в options-объекте команды.
- [ ] `--expand` принимает id с `@` и без (`@e3` = `e3`); неизвестные id тихо игнорируются.
- [ ] `diff last` корректно сравнивает два графа в tree-формате.
- [ ] Все существующие тесты обновлены под tree-формат.
- [ ] Новые тесты: `tests/graph.test.ts` — `buildGraph` с `depth`, `expand`, комбинации, неизвестные id, snapshot с expand.
- [ ] `pnpm test` — все тесты проходят.
- [ ] `pnpm run lint` (`tsc --noEmit`) — без ошибок.
- [ ] `pnpm run build` — успешно.
- [ ] `README.md`, `SKILL.md`, `specs/view-print.md` обновлены.

---

## Дополнение: `--query <CSS-selector>` (v0.2.x)

### Контекст

Даже с `--depth 1` агент получает на выходе дерево с десятками верхнеуровневых элементов. Ещё чаще задача агента — не "дай мне весь layout", а "найди кнопки в шапке", "найди все карточки товаров", "найди модальное окно". `--expand e3` требует двух вызовов (сначала `capture` чтобы узнать id, потом `expand e3`). Прямой CSS-запрос решает оба ограничения.

### Цель

1. `capture` и `snapshot` принимают флаг `--query <CSS-selector>`.
2. Все элементы, удовлетворяющие селектору, становятся **корнями** дерева (аналогично `--expand`, без body).
3. `--query` комбинируется с `--depth` (depth считается от каждого найденного элемента) и с `--expand` (оба источника корней объединяются).
4. Селектор пустой или нет матчей → `tree = []` (без fallback на body).
5. Невалидный селектор → ошибка от `document.querySelectorAll`.

### Что меняется

1. `src/browser.ts` — `capture`/`snapshot` принимают `query?: string`. После `extractSnapshotData` дополнительно через `page.evaluate` резолвится список id через `document.querySelectorAll(query)` и извлекается `data-viewprint-id` каждого матча.
2. `src/graph.ts` — `buildGraph` принимает `hasQuery: boolean`. Если передан query, fallback на body отключается: при пустом expand (и пустых query-результатах) возвращается `tree = []`.
3. `src/cli.ts` — добавить `--query <selector>` в `capture` и `snapshot`.
4. `src/daemon.ts` — HTTP API и `executeBatch` принимают `query`.
5. `src/daemon-client.ts` — `capture`/`snapshot` принимают `query`.
6. `src/mcp.ts` — `inputSchema` добавляет `query` в properties `capture` и `snapshot`.

### Алгоритм resolveQuery

```ts
private async resolveQuery(selector: string): Promise<string[]> {
    return this.page.evaluate((sel: string) => {
        const elements = document.querySelectorAll(sel)
        const ids: string[] = []
        for (const element of Array.from(elements)) {
            const id = element.getAttribute('data-viewprint-id')
            if (id) ids.push(id)
        }
        return ids
    }, selector)
}
```

Зависимость от `data-viewprint-id` означает, что `extractSnapshotData` должен быть вызван до резолва query (он сам и проставляет id каждой ноде).

### Семантика комбинаций

| `--query` | `--expand` | результат |
|-----------|------------|-----------|
| —         | —          | body как единственный корень |
| `".btn"`  | —          | все `.btn` элементы как корни, body исключён |
| —         | `e3,e5`    | e3 и e5 как корни, body исключён |
| `".btn"`  | `e3`       | `.btn` + e3 как корни (объединение), body исключён |
| `"x"` (нет матчей) | — | `tree = []`, body **не** возвращается |

### Примеры

```bash
# Все кнопки на странице
viewprint -s X capture URL --query "button"

# Кнопки внутри контейнера
viewprint -s X capture URL --query ".container button"

# Все карточки товаров
viewprint -s X capture URL --query ".product-card" --depth 3

# Карточки + конкретный элемент
viewprint -s X capture URL --query ".card" --expand e10

# Модальное окно с полным поддеревом
viewprint -s X capture URL --query ".modal" --depth 9999
```

### Тесты

- query с одним матчем: tree = [найденный элемент], body отсутствует
- query + depth=1: дерево с одной нодой, `children: []`
- query + expand: оба источника объединяются в корни
- query без матчей: `tree = []`
- daemon HTTP API: тот же набор ассертов через клиент

### Критерии приёмки

- [ ] `--query "<selector>"` работает для capture и snapshot.
- [ ] Несколько матчей → несколько корней.
- [ ] `--query` + `--expand` объединяют корни.
- [ ] Пустой результат (нет матчей) → `tree = []`, body не возвращается.
- [ ] depth считается от каждого корня независимо.
- [ ] HTTP API и batch принимают `query`.
- [ ] MCP tools принимают `query`.
- [ ] README и SKILL.md описывают --query как основной способ фильтрации.
