# Контекст проекта

- [2026-08-08] Проблема: `this` в callback `mockImplementation(function () {})` теста имел неявный тип `any` и ломал `tsc --noEmit` → Решение: явно аннотировать callback как `function (this: BrowserSession) {}`.
- [2026-08-10] Проблема: неиспользуемый импорт `loadSession` в `daemon.ts` ломал `tsc --noEmit` → Решение: удалить импорт и проверять lint после каждого изменения API.
- [2026-08-11] Проблема: на `smm.nisharadar` `persistState()` получал enumerable-метод `localStorage.setItem` через `Object.entries(window.localStorage)`, после чего viewprint падал с `Invalid localStorage.setItem. Value must be a string.` → Решение: читать localStorage/sessionStorage только через `key(i)` + `getItem(key)` и добавить регрессионный тест.
