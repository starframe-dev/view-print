import type { BoundingBox, CascadeEntry, ElementNode, PseudoElementNode, RawSnapshotElement } from './types.js'

interface ViewPrintWindow extends Window {
    __viewPrintNextElementId?: number
}

export function extractSnapshotData(): RawSnapshotElement[] {
    const elements = Array.from(document.querySelectorAll('body, body *'))
    const result: RawSnapshotElement[] = []
    const elementToId = new Map<Element, string>()
    const idsInSnapshot = new Set<string>()
    const viewPrintWindow = window as ViewPrintWindow
    let nextElementId = viewPrintWindow.__viewPrintNextElementId ?? 1

    const getElementId = (element: Element): string => {
        const existingId = element.getAttribute('data-viewprint-id')
        if (existingId && /^e\d+$/.test(existingId) && !idsInSnapshot.has(existingId)) {
            idsInSnapshot.add(existingId)
            const numericId = Number(existingId.slice(1))
            nextElementId = Math.max(nextElementId, numericId + 1)
            return existingId
        }

        while (idsInSnapshot.has(`e${nextElementId}`)) {
            nextElementId += 1
        }
        const newId = `e${nextElementId}`
        nextElementId += 1
        idsInSnapshot.add(newId)
        return newId
    }

    function getVisibleText(element: Element): string | undefined {
        const texts: string[] = []
        for (const node of Array.from(element.childNodes)) {
            if (node.nodeType === Node.TEXT_NODE) {
                texts.push(node.textContent || '')
            }
        }

        const normalized = texts.join('').trim().replace(/\s+/g, ' ')
        return normalized ? normalized : undefined
    }

    function getRole(element: Element): string | undefined {
        const explicit = element.getAttribute('role')
        if (explicit) {
            return explicit
        }

        const tag = element.tagName.toLowerCase()
        const roleMap: Record<string, string> = {
            a: 'link',
            button: 'button',
            h1: 'heading',
            h2: 'heading',
            h3: 'heading',
            h4: 'heading',
            h5: 'heading',
            h6: 'heading',
            img: 'img',
            input: 'textbox',
            nav: 'navigation',
            main: 'main',
            header: 'banner',
            footer: 'contentinfo',
            aside: 'complementary',
            section: 'region',
            article: 'article',
            form: 'form',
            table: 'table',
            ul: 'list',
            ol: 'list',
            li: 'listitem',
            select: 'combobox',
            textarea: 'textbox'
        }

        return roleMap[tag]
    }

    function getAccessibleName(element: Element): string | undefined {
        const labelledBy = element.getAttribute('aria-labelledby')
        if (labelledBy) {
            const name = labelledBy.split(/\s+/)
                .map((id) => document.getElementById(id)?.textContent || '')
                .join(' ')
                .trim()
            if (name) {
                return name
            }
        }

        const ariaLabel = element.getAttribute('aria-label')
        if (ariaLabel) {
            return ariaLabel.trim()
        }

        const tag = element.tagName.toLowerCase()
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
            const input = element as HTMLInputElement
            if (input.labels && input.labels.length > 0) {
                const labelText = input.labels[0].textContent?.trim()
                if (labelText) {
                    return labelText
                }
            }
        }

        const alt = element.getAttribute('alt')
        if (alt) {
            return alt.trim()
        }

        const title = element.getAttribute('title')
        if (title) {
            return title.trim()
        }

        const placeholder = element.getAttribute('placeholder')
        if (placeholder) {
            return placeholder.trim()
        }

        if (tag === 'button' || tag === 'a' || tag === 'label') {
            const text = element.textContent?.trim()
            if (text) {
                return text
            }
        }

        return undefined
    }

    elements.forEach((element) => {
        const id = getElementId(element)
        element.setAttribute('data-viewprint-id', id)
        elementToId.set(element, id)
        const parentId = element.parentElement
            ? elementToId.get(element.parentElement)
            : undefined

        const tag = element.tagName.toLowerCase()
        const role = getRole(element)
        const name = getAccessibleName(element)

        const attributes: Record<string, string> = {}
        for (const attr of Array.from(element.attributes)) {
            attributes[attr.name] = attr.value
        }

        const text = tag === 'script' || tag === 'style'
            ? undefined
            : getVisibleText(element)

        const rect = element.getBoundingClientRect()
        const boundingBox = {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
        }

        result.push({
            id,
            parentId,
            tag,
            role,
            name,
            attributes,
            text,
            boundingBox
        })
    })

    viewPrintWindow.__viewPrintNextElementId = nextElementId
    return result
}

export function inspectElement(elementId: string): ElementNode | null {
    function getVisibleText(element: Element): string | undefined {
        const texts: string[] = []
        for (const node of Array.from(element.childNodes)) {
            if (node.nodeType === Node.TEXT_NODE) {
                texts.push(node.textContent || '')
            }
        }

        const normalized = texts.join('').trim().replace(/\s+/g, ' ')
        return normalized ? normalized : undefined
    }

    function getRole(element: Element): string | undefined {
        const explicit = element.getAttribute('role')
        if (explicit) {
            return explicit
        }

        const tag = element.tagName.toLowerCase()
        const roleMap: Record<string, string> = {
            a: 'link',
            button: 'button',
            h1: 'heading',
            h2: 'heading',
            h3: 'heading',
            h4: 'heading',
            h5: 'heading',
            h6: 'heading',
            img: 'img',
            input: 'textbox',
            nav: 'navigation',
            main: 'main',
            header: 'banner',
            footer: 'contentinfo',
            aside: 'complementary',
            section: 'region',
            article: 'article',
            form: 'form',
            table: 'table',
            ul: 'list',
            ol: 'list',
            li: 'listitem',
            select: 'combobox',
            textarea: 'textbox'
        }

        return roleMap[tag]
    }

    function getAccessibleName(element: Element): string | undefined {
        const labelledBy = element.getAttribute('aria-labelledby')
        if (labelledBy) {
            const name = labelledBy.split(/\s+/)
                .map((id) => document.getElementById(id)?.textContent || '')
                .join(' ')
                .trim()
            if (name) {
                return name
            }
        }

        const ariaLabel = element.getAttribute('aria-label')
        if (ariaLabel) {
            return ariaLabel.trim()
        }

        const tag = element.tagName.toLowerCase()
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
            const input = element as HTMLInputElement
            if (input.labels && input.labels.length > 0) {
                const labelText = input.labels[0].textContent?.trim()
                if (labelText) {
                    return labelText
                }
            }
        }

        const alt = element.getAttribute('alt')
        if (alt) {
            return alt.trim()
        }

        const title = element.getAttribute('title')
        if (title) {
            return title.trim()
        }

        const placeholder = element.getAttribute('placeholder')
        if (placeholder) {
            return placeholder.trim()
        }

        if (tag === 'button' || tag === 'a' || tag === 'label') {
            const text = element.textContent?.trim()
            if (text) {
                return text
            }
        }

        return undefined
    }

    function getMatchingRules(element: Element): { selector: string; sheet: string; rule: CSSStyleRule }[] {
        const matched: { selector: string; sheet: string; rule: CSSStyleRule }[] = []
        const sheets = Array.from(document.styleSheets)

        for (const sheet of sheets) {
            try {
                const rules = Array.from(sheet.cssRules || sheet.rules || []) as CSSStyleRule[]
                for (const rule of rules) {
                    if (rule.type !== CSSRule.STYLE_RULE) {
                        continue
                    }
                    if (element.matches(rule.selectorText)) {
                        matched.push({
                            selector: rule.selectorText,
                            sheet: sheet.href || 'inline',
                            rule
                        })
                    }
                }
            } catch {
                // Cross-origin stylesheets may throw on accessing cssRules
            }
        }

        return matched
    }

    function buildCascade(element: Element, computedStyle: CSSStyleDeclaration, matchingRules: { selector: string; sheet: string; rule: CSSStyleRule }[]): CascadeEntry[] {
        const inheritedCssProperties = new Set([
            'color',
            'cursor',
            'direction',
            'font',
            'font-family',
            'font-size',
            'font-style',
            'font-variant',
            'font-weight',
            'letter-spacing',
            'line-height',
            'list-style',
            'list-style-image',
            'list-style-position',
            'list-style-type',
            'text-align',
            'text-indent',
            'text-transform',
            'visibility',
            'white-space',
            'word-spacing'
        ])

        const inlineStyle = (element as HTMLElement).style
        const entries: CascadeEntry[] = []

        for (let i = 0; i < computedStyle.length; i++) {
            const property = computedStyle[i]
            const value = computedStyle.getPropertyValue(property)
            const entry = resolveCascadeEntry(element, property, value, inlineStyle, matchingRules, inheritedCssProperties)
            if (entry) {
                entries.push(entry)
            }
        }

        return entries
    }

    function resolveCascadeEntry(
        element: Element,
        property: string,
        value: string,
        inlineStyle: CSSStyleDeclaration,
        matchingRules: { selector: string; sheet: string; rule: CSSStyleRule }[],
        inheritedCssProperties: Set<string>
    ): CascadeEntry | null {
        if (inlineStyle.getPropertyValue(property)) {
            return { property, value, source: 'inline' }
        }

        const matchingRule = findLastMatchingRule(property, matchingRules)
        if (matchingRule) {
            return {
                property,
                value,
                source: 'stylesheet',
                selector: matchingRule.selector,
                sheet: matchingRule.sheet
            }
        }

        if (inheritedCssProperties.has(property) && isInheritedValue(property, element, value)) {
            return { property, value, source: 'inherited' }
        }

        return null
    }

    function findLastMatchingRule(
        property: string,
        matchingRules: { selector: string; sheet: string; rule: CSSStyleRule }[]
    ): { selector: string; sheet: string } | undefined {
        for (let i = matchingRules.length - 1; i >= 0; i--) {
            const { selector, sheet, rule } = matchingRules[i]
            if (rule.style.getPropertyValue(property)) {
                return { selector, sheet }
            }
        }

        return undefined
    }

    function isInheritedValue(property: string, element: Element, value: string): boolean {
        const parent = element.parentElement
        if (!parent) {
            return false
        }

        const parentStyle = window.getComputedStyle(parent)
        return parentStyle.getPropertyValue(property) === value
    }

    function buildComputedStyles(computedStyle: CSSStyleDeclaration, cascade: CascadeEntry[]): Record<string, string> {
        const included = new Set(cascade.map((entry) => entry.property))
        const result: Record<string, string> = {}

        for (let i = 0; i < computedStyle.length; i++) {
            const property = computedStyle[i]
            if (included.has(property)) {
                result[property] = computedStyle.getPropertyValue(property)
            }
        }

        return result
    }

    function extractPseudoData(element: Element, pseudo: string): PseudoElementNode | undefined {
        const style = window.getComputedStyle(element, pseudo)
        if (style.content === 'none' || style.display === 'none') {
            return undefined
        }

        const matchingRules = getMatchingPseudoRules(element, pseudo)
        const parentRect = element.getBoundingClientRect()
        const boundingBox = computePseudoBoundingBox(parentRect, style)
        const cascade = buildPseudoCascade(style, matchingRules)
        const computedStyles = buildPseudoComputedStyles(style, cascade)

        const elementId = element.getAttribute('data-viewprint-id') || 'unknown'

        return {
            id: `${elementId}::${pseudo.slice(2)}`,
            parentId: elementId,
            pseudo: pseudo === '::before' ? 'before' : 'after',
            boundingBox,
            computedStyles,
            cascade
        }
    }

    function getMatchingPseudoRules(element: Element, pseudo: string): { selector: string; sheet: string; rule: CSSStyleRule }[] {
        const sheets = Array.from(document.styleSheets)
        const matched: { selector: string; sheet: string; rule: CSSStyleRule }[] = []

        for (const sheet of sheets) {
            try {
                const rules = Array.from(sheet.cssRules || sheet.rules || []) as CSSStyleRule[]
                for (const rule of rules) {
                    if (rule.type !== CSSRule.STYLE_RULE) {
                        continue
                    }
                    if (!rule.selectorText.includes(pseudo)) {
                        continue
                    }
                    if (element.matches(rule.selectorText)) {
                        matched.push({
                            selector: rule.selectorText,
                            sheet: sheet.href || 'inline',
                            rule
                        })
                    }
                }
            } catch {
                // Cross-origin stylesheets may throw on accessing cssRules
            }
        }

        return matched
    }

    function buildPseudoCascade(computedStyle: CSSStyleDeclaration, matchingRules: { selector: string; sheet: string; rule: CSSStyleRule }[]): CascadeEntry[] {
        const entries: CascadeEntry[] = []

        for (let i = 0; i < computedStyle.length; i++) {
            const property = computedStyle[i]
            const value = computedStyle.getPropertyValue(property)
            const matchingRule = findLastMatchingRule(property, matchingRules)

            if (matchingRule) {
                entries.push({
                    property,
                    value,
                    source: 'stylesheet',
                    selector: matchingRule.selector,
                    sheet: matchingRule.sheet
                })
            }
        }

        return entries
    }

    function buildPseudoComputedStyles(computedStyle: CSSStyleDeclaration, cascade: CascadeEntry[]): Record<string, string> {
        const included = new Set(cascade.map((entry) => entry.property))
        const result: Record<string, string> = {}

        for (let i = 0; i < computedStyle.length; i++) {
            const property = computedStyle[i]
            if (included.has(property)) {
                result[property] = computedStyle.getPropertyValue(property)
            }
        }

        return result
    }

    function computePseudoBoundingBox(parentRect: DOMRect, style: CSSStyleDeclaration): BoundingBox {
        let x = parentRect.x
        let y = parentRect.y
        let width = parentRect.width
        let height = parentRect.height

        const position = style.position
        if (position === 'absolute' || position === 'fixed' || position === 'relative') {
            const top = parseCssLength(style.top)
            const left = parseCssLength(style.left)
            if (!Number.isNaN(top)) y += top
            if (!Number.isNaN(left)) x += left
        }

        const styleWidth = parseCssLength(style.width)
        const styleHeight = parseCssLength(style.height)
        if (!Number.isNaN(styleWidth)) width = styleWidth
        if (!Number.isNaN(styleHeight)) height = styleHeight

        return { x, y, width, height }
    }

    function parseCssLength(value: string): number {
        if (value === 'auto' || value === '' || value === 'none') {
            return NaN
        }

        const match = value.match(/^(-?\d+(?:\.\d+)?)(px|em|rem|cm|mm|in|pt|pc|%)?$/i)
        if (!match) {
            return NaN
        }

        const num = parseFloat(match[1])
        const unit = match[2]?.toLowerCase()

        if (unit === '%') {
            return NaN
        }

        if (unit === 'em' || unit === 'rem') {
            return num * 16
        }

        return num
    }

    const element = document.querySelector(`[data-viewprint-id="${elementId}"]`)
    if (!element) {
        return null
    }

    const tag = element.tagName.toLowerCase()
    const role = getRole(element)
    const name = getAccessibleName(element)

    const attributes: Record<string, string> = {}
    for (const attr of Array.from(element.attributes)) {
        attributes[attr.name] = attr.value
    }

    const text = tag === 'script' || tag === 'style'
        ? undefined
        : getVisibleText(element)

    const rect = element.getBoundingClientRect()
    const boundingBox = {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
    }

    const matchingRules = getMatchingRules(element)
    const computedStyle = window.getComputedStyle(element)
    const cascade = buildCascade(element, computedStyle, matchingRules)
    const computedStyles = buildComputedStyles(computedStyle, cascade)

    const pseudo = {
        before: extractPseudoData(element, '::before'),
        after: extractPseudoData(element, '::after')
    }

    return {
        id: elementId,
        tag,
        role,
        name,
        attributes,
        text,
        boundingBox,
        computedStyles,
        cascade,
        pseudo
    }
}
