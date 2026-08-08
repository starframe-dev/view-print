# Контекст проекта

- [2026-08-08] Проблема: `this` в callback `mockImplementation(function () {})` теста имел неявный тип `any` и ломал `tsc --noEmit` → Решение: явно аннотировать callback как `function (this: BrowserSession) {}`.
