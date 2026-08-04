# Профилирование: Chrome perf trace, per-action timing, HTTP request tracing

## Контекст

View-print используется в AI-агентах для извлечения layout-графа страниц. Когда
страница медленно грузится, capture занимает 10+ секунд, или daemon
неожиданно тупит — нужны инструменты диагностики. Сейчас в проекте есть
только `startHar/stopHar` для network, но нет:

- **Chrome perf trace** через CDP `Tracing` domain — для понимания что
  делает браузер (layout, paint, JS execution).
- **Per-action timing** в BrowserSession — capture/click/fill/eval/etc.
  с метриками длительности.
- **HTTP request tracing** в daemon — middleware с request/response
  timing, чтобы видеть медленные endpoint'ы.

## Цель

Добавить три независимых инструмента профилирования, доступных через CLI
и/или runtime API. Каждый может быть включён отдельно.

## Архитектура

### 1. Chrome perf trace (`src/tracing.ts`)

Использует CDP `Tracing.start` / `Tracing.end` через Playwright
`page.context().newCDPSession(page)`. Категории по умолчанию —
`['-*', 'devtools.timeline', 'v8.execute', 'blink.console',
'blink.user_timing', 'loading', 'latencyInfo', 'disabled-by-default-devtools.timeline']`
(покрывают page load, layout, paint, JS exec).

`TracingSession`:
- `start(page, options?)` → запускает CDP tracing.
- `stop(page, outputPath)` → останавливает, получает events, пишет JSON
  (Chrome DevTools Trace Event Format).
- `report()` → возвращает summary: durationMs, eventCount, top categories.
- Только одна активная session на BrowserSession (state-машина).

Также low-level helper:
```ts
capturePerformanceTrace(page, options): Promise<TraceArtifacts>
```
с удобным wrapper: start → произвольная async операция → stop.

### 2. Per-action timing (`src/browser.ts`)

`BrowserSession.profiling: boolean` (default false). При включении каждый
action (`capture`, `snapshot`, `inspect`, `click`, `fill`, `type`, `hover`,
`focus`, `press`, `scroll`, `scrollIntoView`, `wait`, `eval`, `route`,
`unroute`, `newTab`, `switchTab`, `closeTab`, `screenshotPage`,
`screenshotElement`, `read`, `setCookie`, `clearCookies`,
`setLocalStorage`, `getLocalStorage`, ...) оборачивается в:

```ts
private async timed<T>(action: string, fn: () => Promise<T>): Promise<T> {
    if (!this.profiling) return fn()
    const start = performance.now()
    try {
        return await fn()
    } finally {
        this.timings.push({
            action,
            durationMs: performance.now() - start,
            timestamp: Date.now()
        })
    }
}
```

API:
- `enableProfiling()` / `disableProfiling()`
- `getTimings(): ActionTiming[]`
- `clearTimings()`
- `getTimingsReport()` → агрегаты: count, totalMs, avgMs, p50/p95/p99,
  breakdown by action.

`ActionTiming`:
```ts
{ action: string, durationMs: number, timestamp: number }
```

### 3. HTTP request tracing (`src/daemon.ts`)

Middleware в `handleRequest`:
- Замер `startTime = Date.now()` в начале.
- В `finally`: записать `[trace] METHOD /path STATUS Xms` в `process.stderr`
  И/или в файл через `VIEWPRINT_HTTP_TRACE_FILE` env.
- Всегда включено в debug-режиме (`VIEWPRINT_DEBUG=1`); по умолчанию —
  on (легковесный stderr лог).
- Формат JSON-lines для удобного парсинга:
  `{"method":"POST","path":"/sessions/foo/capture","status":200,"durationMs":45,"timestamp":1700000000000}`.

Не блокирует обработку: пишется синхронно в stderr (`process.stderr.write`),
в файл — через fs.appendFileSync (если указан файл).

## API endpoint'ы в daemon

```
POST /sessions/<name>/profile
  body: { enabled: boolean }
  → { profiling: boolean, timingsCount: number }

GET /sessions/<name>/profile
  → { timings: ActionTiming[], report: ActionReport }

DELETE /sessions/<name>/profile
  → { cleared: number }

POST /sessions/<name>/trace/start
  body: { categories?: string[] }
  → { started: true, categories: string[] }

POST /sessions/<name>/trace/stop
  body: { output?: string }
  → { stopped: true, path: string, eventCount: number, sizeBytes: number }

GET /sessions/<name>/trace/report
  → { report: TraceReport }
```

`TraceReport`:
```ts
{
  durationMs: number
  eventCount: number
  categoryCounts: Record<string, number>
  topEvents: Array<{ name: string, dur: number }>  // top 10 by duration
}
```

## CLI

```bash
# Chrome perf trace
viewprint trace start [-s <session>] [--categories c1,c2,...]
viewprint trace stop [-s <session>] [--output trace.json]
viewprint trace report [-s <session>]

# Per-action profiling (флаг на любой команде)
viewprint -s <session> capture <url> --profile
viewprint -s <session> click @e3 --profile

# Чтение артефактов
viewprint profile show [-s <session>]      # timings summary
viewprint profile clear [-s <session>]
```

По умолчанию `--profile` пишет summary в stderr после выполнения команды.
С `VIEWPRINT_PROFILE_JSON=1` выводит JSON.

## Хранение артефактов

- Chrome perf trace: `~/.viewprint/traces/<session>-<timestamp>.json`
  (default), или через `--output`.
- Per-action timings: in-memory в BrowserSession; не персистится
  между сессиями (опционально — `~/.viewprint/timings/<session>.json`
  при `VIEWPRINT_TIMINGS_PERSIST=1`).

## Критерии приёмки

- [ ] `viewprint trace start` → `POST /sessions/<name>/trace/start` →
      CDP `Tracing.start` отправлен, categories записаны.
- [ ] `viewprint trace stop` → `POST /sessions/<name>/trace/stop` →
      CDP `Tracing.end` собирает events, файл JSON создан, file size > 0.
- [ ] `viewprint trace report` возвращает агрегаты.
- [ ] `viewprint capture --profile` → timings собираются, summary выводится
      после команды.
- [ ] HTTP request log в stderr: каждый запрос → одна строка JSON.
- [ ] Unit-тесты: TracingSession state machine (start/stop/report);
      timings накапливаются и clearable; ActionReport aggregates
      (count/total/avg/p50/p95/p99).
- [ ] Integration тесты в daemon: /profile endpoints, /trace endpoints.
- [ ] `pnpm run lint` чисто.
- [ ] `pnpm run build` чисто.
- [ ] `pnpm test` — все тесты проходят (старые + новые).

## Открытые вопросы

- Web Vitals метрики (Stage 9 из старого roadmap) — отдельная задача,
  не входит в эту спеку.
- `--profile` на каждой команде — добавлять флаг или использовать
  глобальный `viewprint -s <session> --profile <command>`? Решено:
  per-command флаг, потому что `commander` уже поддерживает.

## Файлы

Новые:
- `src/tracing.ts` — Chrome perf trace через CDP
- `tests/tracing.test.ts` — unit тесты

Изменяемые:
- `src/browser.ts` — `profiling`/`timings`/`timed()` + `enableProfiling()`/
  `disableProfiling()`/`getTimings()`/`clearTimings()`/
  `getTimingsReport()`
- `src/types.ts` — `ActionTiming`, `ActionReport`, `TraceReport`
- `src/daemon.ts` — `/profile` и `/trace` endpoints + HTTP middleware
- `src/cli.ts` — команда `trace`, флаг `--profile` на actions, команда
  `profile show/clear`
- `src/daemon-client.ts` — если нужно (скорее нет, используется fetch
  напрямую)
- `tests/browser.test.ts` — тест на timings
- `tests/daemon.test.ts` — тесты на profile/trace endpoints
- `specs/profiling.md` — эта спека
