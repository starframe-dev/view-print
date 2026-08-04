# Profiling: skip load, no load, trace run

## Контекст

Сейчас `capture` всегда делает `page.goto(url)` если URL передан. С
профилированием это создаёт две проблемы:

1. **Повторная навигация при `--profile`/`--trace`.** Если страница уже
   загружена в page (например, предыдущим `capture` или `tabs new`),
   повторный `goto` перезагружает её и trace/profile ловят в основном
   navigation events, а не те действия, которые мы хотим профилировать.

2. **Нет способа профилировать без capture.** Чтобы обернуть `click` +
   `fill` + `wait` в trace, нужно сначала сделать `capture` (для
   инициализации трассировки через auto-wrap флаги), что тянет
   навигацию.

## Цель

Дать три способа управлять загрузкой страницы в `capture`/`snapshot`
и возможность обернуть произвольные команды в trace без `capture`.

## API

### 1. `capture --skip-load` (умный пропуск)

Если URL передан И текущий `page.url()` совпадает с ним — пропустить
`page.goto`. Если не совпадает — перейти. Полезно для идемпотентных
вызовов и профилирования без двойной навигации.

```bash
viewprint -s X capture URL --skip-load       # если уже на URL, не грузит
viewprint -s X capture URL --skip-load --profile --trace trace.json
```

### 2. `capture --no-load` (никогда не грузит)

`capture` работает на текущей странице. URL игнорируется.
Полезно когда страница уже загружена через `tabs new`, `route` + ручную
навигацию, или мы хотим измерить timings без `goto` вообще.

```bash
viewprint -s X tabs new https://example.com
viewprint -s X wait --text "Loaded"
viewprint -s X capture --no-load --profile   # профилируем БЕЗ навигации
viewprint -s X click @e3
viewprint -s X capture --no-load --profile   # профилируем клик
```

Если страница не загружена (about:blank) — capture работает, но
возвращает пустой/минимальный граф (как `data:` URL).

### 3. `viewprint trace run --actions "..."` (trace без capture)

Оборачивает произвольные команды в trace session. Не делает `capture`,
не трогает навигацию — только запускает CDP `Tracing.start`, выполняет
команды, останавливает trace.

```bash
viewprint -s X trace run --actions '[
  ["tabs", "new", "https://example.com"],
  ["wait", {"text": "Loaded", "timeout": 5000}],
  ["click", "@e3"],
  ["fill", "@e5", "hello"]
]'
# → 422 events в /tmp/trace.json, никакого capture
```

Если URL первой команды = `tabs new <url>`, trace пишет events включая
навигацию. Если не делаем `tabs new` — page должен быть уже загружен
(или будет работать на текущей странице).

`--actions` принимает JSON в аргументе или через stdin
(`echo '...' | viewprint trace run`). Команды выполняются
последовательно через тот же механизм что и `batch`.

## Архитектура

### `BrowserSession.capture()`

Добавить параметры `options?: { skipLoad?: boolean, noLoad?: boolean }`:

```ts
async capture(
    url?: string,
    viewport?: { width: number; height: number },
    depth: number = 1,
    expand: Set<string> = new Set(),
    query?: string,
    options?: { skipLoad?: boolean, noLoad?: boolean }
): Promise<Graph> {
    return this.timed('capture', async () => {
        if (!this.page) {
            throw new Error('Session not started. Call start() first.')
        }

        const skipGoto = options?.noLoad === true
            || (options?.skipLoad === true && url && this.page.url() === url)

        if (url && !skipGoto) {
            await this.page.goto(url)
            this.state.url = url
            await this.restoreStorage()
        } else if (url) {
            // skipGoto: URL совпадает, не грузим. Обновим state.url для consistency.
            this.state.url = url
        }
        // ... остальное как было
    })
}
```

`skipLoad: true` И `noLoad: true` одновременно — `noLoad` имеет приоритет
(он сильнее).

### HTTP API

```http
POST /sessions/<name>/capture
{
  "url": "https://example.com",
  "skipLoad": true,
  "noLoad": false,
  "viewport": {...},
  "depth": 1
}
```

`skipLoad`/`noLoad` пробрасываются в `BrowserSession.capture()`.

### CLI

```bash
viewprint capture [url]
  --skip-load                 # не грузить если URL уже совпадает
  --no-load                   # не грузить вообще (URL игнорируется)
  --profile
  --trace <path>

viewprint trace run
  --actions <json>            # или stdin
  --output <path>             # default: ~/.viewprint/traces/trace-<timestamp>.json
  --categories <list>         # опционально, default categories
```

`viewprint trace run` flow:
1. `client.startTrace(session, categories)` — start CDP tracing
2. `client.batch(session, commands)` — выполнить команды
3. `client.stopTrace(session, output)` — stop + write file
4. Вывести в stderr: `# trace: <N> events, <bytes> -> <path>`

## Критерии приёмки

- [ ] `capture --skip-load` с совпадающим URL → не делает goto (verify
      через timings: capture duration без goto ≈ 10ms, с goto ≈ 500ms)
- [ ] `capture --skip-load` с несовпадающим URL → делает goto
- [ ] `capture --no-load` → НИКОГДА не делает goto, URL игнорируется
- [ ] `viewprint trace run --actions '[...]'` → trace.json создан,
      capture НЕ выполняется, page.goto выполняется только если
      команды его требуют (`tabs new <url>`)
- [ ] `pnpm test` — все старые + новые тесты проходят
- [ ] `pnpm run lint` — чисто
- [ ] `pnpm run build` — чисто
- [ ] E2E через глобальный `viewprint` подтверждает все три фичи
- [ ] SKILL.md обновлён

## Файлы

Изменяемые:
- `src/browser.ts` — `capture()`/`snapshot()` принимают options
- `src/daemon.ts` — `body.skipLoad`/`body.noLoad` в /capture endpoint
- `src/daemon-client.ts` — `capture()`/`snapshot()` пробрасывают options
- `src/cli.ts` — флаги + команда `trace run`
- `tests/browser.test.ts` — тесты на skipLoad/noLoad
- `tests/daemon.test.ts` — тесты на skipLoad/noLoad в HTTP API
- `specs/profiling-skip-load.md` — эта спека
- `~/.ai/{just,getic}/pi/skills/knowledge_view-print/SKILL.md` — обновить

## Открытые вопросы

- `--no-load` без указания URL → игнорируется URL даже если передан.
  Альтернатива: warning "URL ignored because --no-load". Решено: warning
  в stderr, но не error.
- `viewprint trace run` без `--actions` и без stdin → error.
- `trace run` использует существующий `batch` endpoint → переиспользует
  нормализацию команд. Не нужно дублировать логику.
