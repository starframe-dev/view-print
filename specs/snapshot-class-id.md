# Snapshot: добавить `id` и `className`

## Контекст

`SnapshotNode` содержит `ref, tag, role, name, text, boundingBox, childrenCount, children`,
но не имеет доступа к HTML атрибутам `id` и `class`. Они лежат внутри `attributes`,
которое в `SnapshotNode` вообще не пробрасывается.

Для написания селекторов по snapshot (`.querySelector('.btn.primary')`,
`getElementById('main')`) приходится лезть в `capture.attributes`, что неудобно.

## Цель

Добавить top-level поля `id?: string` и `className?: string` в `SnapshotNode`.

## API

### До
```ts
export interface SnapshotNode {
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

### После
```ts
export interface SnapshotNode {
    ref: string
    tag: string
    role?: string
    name?: string
    text?: string
    id?: string          // ← HTML атрибут id (например "page-header")
    className?: string   // ← HTML атрибут class (например "site-header dark")
    boundingBox: BoundingBox
    childrenCount: number
    children: SnapshotNode[]
}
```

Поля опциональные — если у элемента нет `id` или `class`, они просто не
включаются в JSON (undefined → не сериализуется).

## Реализация

В `src/browser.ts:buildSnapshotTree()` читаем из `CaptureNode.attributes`:

```ts
result.push({
    ref: child.id,
    tag: child.tag,
    role: child.role,
    name: child.name,
    text: child.text,
    id: child.attributes.id,
    className: child.attributes.class,
    boundingBox: child.boundingBox,
    childrenCount: child.childrenCount,
    children: expandedChildren
})
```

`buildSnapshotTree` уже получает `CaptureNode[]` (у которого `attributes`
есть с самого начала).

## Использование

```bash
viewprint -s X snapshot https://example.com
```

Возвращает дерево, где у `<header id="page-header" class="site-header">`:
```json
{
  "ref": "e2",
  "tag": "header",
  "id": "page-header",
  "className": "site-header",
  "role": "banner",
  ...
}
```

Теперь легко фильтровать через `--query`:
```bash
viewprint -s X snapshot https://example.com --query "#page-header .nav-item"
```

## Файлы

- `src/types.ts` — `id?: string, className?: string` в `SnapshotNode`
- `src/browser.ts` — `buildSnapshotTree()` пробрасывает из `child.attributes.id/class`
- `tests/browser.test.ts` — тест на наличие id/className для элементов с этими атрибутами
- `~/.ai/{just,getic}/pi/skills/knowledge_view-print/SKILL.md` — упоминание

## Совместимость

**Additive change** — старые клиенты продолжат работать, новые поля
игнорируются. Не breaking.

## Критерии приёмки

- [ ] Snapshot для `<div id="x" class="y">` содержит `"id": "x"`, `"className": "y"`
- [ ] Snapshot для `<div>plain</div>` НЕ содержит полей id/className
- [ ] `pnpm lint` — чисто
- [ ] `pnpm test` — 84/84 passing (добавлен 1 новый тест)
- [ ] E2E через global `viewprint snapshot` подтверждает наличие полей
- [ ] SKILL.md обновлён
