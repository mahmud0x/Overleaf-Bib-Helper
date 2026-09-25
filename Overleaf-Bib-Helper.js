// ==UserScript==
// @name         Overleaf Research Bib Toolkit
// @namespace    com.Xunjian.overleaf.merged
// @version      4.2.0
// @description  Unified Overleaf paper search, BibTeX retrieval, project bibliography manager, and citation hover previews with copy actions
// @author       Xunjian Yin (Bib Helper) + merged citation-preview enhancements
// @match        https://www.overleaf.com/project/*
// @match        https://overleaf.com/project/*
// @match        https://dl.acm.org/doi/*
// @icon         https://www.overleaf.com/favicon.ico
// @run-at       document-idle
// @noframes
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_deleteValue
// @homepageURL  https://github.com/MLNLP-World/Overleaf-Bib-Helper
// @supportURL   https://github.com/MLNLP-World/Overleaf-Bib-Helper/issues
// @connect      *
// @license      MIT
// ==/UserScript==

let showBox = false;
let injectInProgress = false;
let stylesInjected = false;
let injectScheduled = false;
let injectionWatcherStarted = false;
let searchSequence = 0;
let previewSequence = 0;
let copySequence = 0;
let focusBeforePopup = null;
const bibCache = new Map();
const citationSourceCache = new Map();

// Project-local citation hover library. The legacy localStorage key is kept so
// previously pasted bibliographies from the standalone hover script continue to work.
const CITATION_STORAGE_PREFIX = 'overleaf_bib_preview_';
const CITATION_RAW_SUFFIX = '_raw';
let citationDatabase = {};
let citationRawBib = '';
let citationHoverCard = null;
let citationHideTimer = null;
let citationHoveringCard = false;
let citationHoverSignature = '';
const OFFICIAL_BIB_LABELS = Object.freeze({
    NeurIPS: 'NeurIPS proceedings',
    PMLR: 'PMLR',
    ACLAnthology: 'ACL Anthology',
    OpenReview: 'OpenReview',
    CVF: 'CVF Open Access',
    BMVC: 'BMVC / BMVA proceedings',
    ECVA: 'ECVA / Springer',
    Springer: 'Springer Nature',
    AAAI: 'AAAI proceedings',
    IJCAI: 'IJCAI proceedings',
    KR: 'KR proceedings',
    IEEE: 'IEEE Xplore',
    ACM: 'ACM Digital Library',
});
const AAAI_JOURNALS = Object.freeze({
    aaai: 'AAAI', aaaiss: 'AAAI-SS', aiide: 'AIIDE', aies: 'AIES',
    hcomp: 'HCOMP', iaseai: 'IASEAI', icaps: 'ICAPS', icwsm: 'ICWSM', socs: 'SOCS',
});

// Overleaf's hosted redesign and older/self-hosted editor layouts coexist.
const TOOLBAR_SELECTORS = [
    '.ol-toolbar-layout-right',
    '.ol-cm-toolbar-button-group.ol-cm-toolbar-end',
    '.ide-redesign-toolbar-actions',
];

const DEFAULT_SCHOLAR_ORIGINS = [
    "https://scholar.google.com",
];

const FALLBACK_BRAND_RGB = { r: 19, g: 138, b: 7 }; // Overleaf green

function clampByte(value) {
    return Math.min(255, Math.max(0, Math.round(value)));
}

function parseCssColorToRgb(color) {
    const raw = String(color ?? '').trim();
    if (!raw) return null;

    const hexMatch = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hexMatch) {
        const hex = hexMatch[1];
        if (hex.length === 3) {
            const r = Number.parseInt(hex[0] + hex[0], 16);
            const g = Number.parseInt(hex[1] + hex[1], 16);
            const b = Number.parseInt(hex[2] + hex[2], 16);
            return { r, g, b };
        }
        const r = Number.parseInt(hex.slice(0, 2), 16);
        const g = Number.parseInt(hex.slice(2, 4), 16);
        const b = Number.parseInt(hex.slice(4, 6), 16);
        return { r, g, b };
    }

    const rgbMatch = raw.match(/^rgba?\(\s*([0-9.]+)[, ]+([0-9.]+)[, ]+([0-9.]+)(?:\s*[,/]\s*([0-9.]+))?\s*\)$/i);
    if (rgbMatch) {
        if (rgbMatch[4] !== undefined && Number.parseFloat(rgbMatch[4]) === 0) return null;
        const r = clampByte(Number.parseFloat(rgbMatch[1]));
        const g = clampByte(Number.parseFloat(rgbMatch[2]));
        const b = clampByte(Number.parseFloat(rgbMatch[3]));
        return { r, g, b };
    }

    const csvMatch = raw.match(/^([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})$/);
    if (csvMatch) {
        const r = clampByte(Number.parseInt(csvMatch[1], 10));
        const g = clampByte(Number.parseInt(csvMatch[2], 10));
        const b = clampByte(Number.parseInt(csvMatch[3], 10));
        return { r, g, b };
    }

    return null;
}

function getOverleafBrandRgb() {
    const rootStyles = getComputedStyle(document.documentElement);
    const varCandidates = [
        '--ol-green',
        '--ol-brand-green',
        '--brand-green',
        '--primary',
        '--primary-color',
        '--accent',
        '--accent-color',
        '--green',
    ];
    for (const varName of varCandidates) {
        const value = rootStyles.getPropertyValue(varName)?.trim();
        const rgb = parseCssColorToRgb(value);
        if (rgb) return rgb;
    }

    const selectorCandidates = [
        'button.btn-primary',
        '.btn-primary',
        '.btn--primary',
        '.ol-button--primary',
        'button[style*="background-color"]',
        'a[style*="background-color"]',
    ];
    for (const selector of selectorCandidates) {
        const el = document.querySelector(selector);
        if (!el) continue;
        const bg = getComputedStyle(el).backgroundColor;
        const rgb = parseCssColorToRgb(bg);
        if (rgb) return rgb;
    }

    return null;
}

function initBrandTheme() {
    const rgb = getOverleafBrandRgb() ?? FALLBACK_BRAND_RGB;
    const brand = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
    document.documentElement.style.setProperty('--obh-brand', brand);
    document.documentElement.style.setProperty('--obh-brand-weak', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.18)`);
    document.documentElement.style.setProperty('--obh-brand-hover', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.08)`);
    document.documentElement.style.setProperty('--obh-brand-hover-strong', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.14)`);
}

function injectObhStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    GM_addStyle(`
        #obh-toggle-icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            flex: 0 0 auto;
            height: 28px;
            width: auto;
            min-width: 32px;
            margin: 0 4px;
            padding: 0 6px;
            border: 0;
            border-radius: 4px;
            background: transparent;
            box-shadow: none;
            color: inherit;
            font: 12px/1.2 system-ui, sans-serif;
            cursor: pointer;
        }
        .obh-toggle.obh-active { color: var(--obh-brand, rgb(${FALLBACK_BRAND_RGB.r}, ${FALLBACK_BRAND_RGB.g}, ${FALLBACK_BRAND_RGB.b})); }

        .obh-popup {
            --obh-bg: #ffffff;
            --obh-fg: #111827;
            --obh-muted: #6b7280;
            --obh-border: rgba(17, 24, 39, 0.12);
            --obh-shadow: 0 18px 40px rgba(17, 24, 39, 0.18);
            --obh-surface: rgba(17, 24, 39, 0.03);
            --obh-input-bg: rgba(255, 255, 255, 0.95);
            --obh-hover: var(--obh-brand-hover, rgba(${FALLBACK_BRAND_RGB.r}, ${FALLBACK_BRAND_RGB.g}, ${FALLBACK_BRAND_RGB.b}, 0.08));
            --obh-hover-strong: var(--obh-brand-hover-strong, rgba(${FALLBACK_BRAND_RGB.r}, ${FALLBACK_BRAND_RGB.g}, ${FALLBACK_BRAND_RGB.b}, 0.14));
            --obh-accent: var(--obh-brand, rgb(${FALLBACK_BRAND_RGB.r}, ${FALLBACK_BRAND_RGB.g}, ${FALLBACK_BRAND_RGB.b}));
            --obh-accent-weak: var(--obh-brand-weak, rgba(${FALLBACK_BRAND_RGB.r}, ${FALLBACK_BRAND_RGB.g}, ${FALLBACK_BRAND_RGB.b}, 0.18));
            --obh-danger: #b42318;
            --obh-success: #067647;
            --obh-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji",
                "Segoe UI Emoji";

            box-sizing: border-box;
            width: min(600px, calc(100vw - 24px));
            max-height: calc(100vh - 24px);
            overflow: auto;
            padding: 12px;
            background: var(--obh-bg);
            color: var(--obh-fg);
            border: 1px solid var(--obh-border);
            border-radius: 6px;
            font-family: var(--obh-font);
            position: fixed;
            top: 0;
            left: 0;
            display: none;
            z-index: 2147483647;
        }

        .obh-popup[data-theme="dark"] {
                --obh-bg: #0b1220;
                --obh-fg: #e5e7eb;
                --obh-muted: #9ca3af;
                --obh-border: rgba(229, 231, 235, 0.14);
                --obh-shadow: 0 18px 40px rgba(0, 0, 0, 0.4);
                --obh-surface: rgba(229, 231, 235, 0.06);
                --obh-input-bg: rgba(15, 23, 42, 0.8);
                --obh-danger: #f97066;
                --obh-success: #32d583;
        }

        .obh-popup * { box-sizing: border-box; }
        .obh-popup [hidden] { display: none !important; }
        .obh-popup button, .obh-popup input, .obh-popup select, .obh-popup textarea { font-family: inherit; }
        .obh-popup input { min-width: 0; }
        .obh-popup button:focus-visible, #obh-toggle-icon:focus-visible, .obh-popup summary:focus-visible {
            outline: 2px solid var(--obh-brand, #138a07);
            outline-offset: 2px;
        }
        .obh-popup .obh-icon-button, .obh-popup .obh-search-input, .obh-popup .obh-primary-button,
        .obh-popup .obh-select, .obh-popup .obh-year-input, .obh-popup .obh-status, .obh-popup .obh-results {
            border-radius: 4px;
        }
        .obh-advanced { margin-top: 10px; font-size: 12px; }
        .obh-advanced summary { cursor: pointer; color: var(--obh-muted); }
        .obh-result-actions { display: flex; flex-wrap: wrap; gap: 6px; }
        .obh-result-title { overflow-wrap: anywhere; }
        .obh-popup .obh-result-action { border-radius: 4px; opacity: 1; line-height: 1.5; font: inherit; font-size: 11px; }
        .obh-preview { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--obh-border); }
        .obh-preview label { display: block; font-size: 12px; margin: 8px 0 4px; }
        .obh-preview textarea {
            display: block; width: 100%; height: 190px; resize: vertical; padding: 8px;
            font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace;
            color: var(--obh-fg); background: var(--obh-input-bg); border: 1px solid var(--obh-border);
        }
        .obh-preview .obh-result-actions { margin-top: 8px; }
        @media (max-width: 440px) {
            .obh-group-header, .obh-result { flex-wrap: wrap; }
            .obh-result-main { flex-basis: 100%; }
        }
        @media (prefers-reduced-motion: reduce) { .obh-status-loading::before { animation: none; } }

        .obh-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            margin-bottom: 10px;
        }

        .obh-brand {
            display: flex;
            align-items: center;
            gap: 10px;
            min-width: 0;
        }

        .obh-badge {
            width: 28px;
            height: 28px;
            border-radius: 10px;
            background: var(--obh-accent-weak);
            color: var(--obh-accent);
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 800;
            font-size: 13px;
            flex: 0 0 auto;
        }

        .obh-title {
            font-weight: 650;
            font-size: 13px;
            line-height: 1.2;
        }

        .obh-subtitle {
            font-size: 11px;
            color: var(--obh-muted);
            line-height: 1.2;
            margin-top: 2px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .obh-icon-button {
            width: 30px;
            height: 30px;
            border-radius: 10px;
            border: 1px solid var(--obh-border);
            background: transparent;
            color: var(--obh-fg);
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
        }

        .obh-icon-button:hover {
            border-color: var(--obh-accent);
            background: var(--obh-accent-weak);
        }

        .obh-icon-button:active { transform: translateY(1px); }

        .obh-search-row {
            display: flex;
            gap: 8px;
            align-items: center;
        }

        .obh-search-input {
            flex: 1;
            height: 34px;
            border-radius: 12px;
            border: 1px solid var(--obh-border);
            padding: 0 10px;
            font-size: 13px;
            background: var(--obh-input-bg);
            color: var(--obh-fg);
        }

        .obh-search-input::placeholder { color: var(--obh-muted); }

        .obh-search-input:focus {
            outline: none;
            border-color: var(--obh-accent);
            box-shadow: 0 0 0 3px var(--obh-accent-weak);
        }

        .obh-primary-button {
            width: 38px;
            height: 34px;
            border-radius: 12px;
            border: 1px solid transparent;
            background: var(--obh-accent);
            color: white;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .obh-primary-button:hover { filter: brightness(0.98); }
        .obh-primary-button:active { transform: translateY(1px); }
        .obh-primary-button svg { fill: currentColor; }
        .obh-primary-button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
        }

        .obh-controls {
            margin-top: 10px;
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
        }

        .obh-control {
            flex: 1 1 120px;
            min-width: 120px;
        }

        .obh-control label {
            display: block;
            font-size: 11px;
            color: var(--obh-muted);
            margin: 0 0 4px 2px;
        }

        .obh-select {
            width: 100%;
            height: 34px;
            border-radius: 12px;
            border: 1px solid var(--obh-border);
            padding: 0 8px;
            background: var(--obh-input-bg);
            color: var(--obh-fg);
            font-size: 13px;
        }

        .obh-select:focus {
            outline: none;
            border-color: var(--obh-accent);
            box-shadow: 0 0 0 3px var(--obh-accent-weak);
        }

        .obh-year-range {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .obh-year-input {
            flex: 1;
            height: 34px;
            border-radius: 12px;
            border: 1px solid var(--obh-border);
            padding: 0 10px;
            font-size: 13px;
            background: var(--obh-input-bg);
            color: var(--obh-fg);
        }

        .obh-year-input::placeholder { color: var(--obh-muted); }

        .obh-year-input:focus {
            outline: none;
            border-color: var(--obh-accent);
            box-shadow: 0 0 0 3px var(--obh-accent-weak);
        }

        .obh-year-sep {
            color: var(--obh-muted);
            font-size: 12px;
            user-select: none;
        }

        .obh-status {
            margin-top: 10px;
            padding: 8px 10px;
            border-radius: 12px;
            border: 1px solid var(--obh-border);
            background: var(--obh-surface);
            font-size: 12px;
            color: var(--obh-muted);
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .obh-status:empty { display: none; }

        @keyframes obh-spin { to { transform: rotate(360deg); } }

        .obh-status-loading::before {
            content: "";
            width: 12px;
            height: 12px;
            border-radius: 999px;
            border: 2px solid rgba(127, 127, 127, 0.35);
            border-top-color: var(--obh-accent);
            display: inline-block;
            animation: obh-spin 0.8s linear infinite;
        }

        .obh-status-error {
            color: var(--obh-danger);
            border-color: rgba(180, 35, 24, 0.28);
            background: rgba(180, 35, 24, 0.06);
        }

        .obh-status-success {
            color: var(--obh-success);
            border-color: rgba(6, 118, 71, 0.28);
            background: rgba(6, 118, 71, 0.06);
        }

        .obh-results {
            margin-top: 10px;
            border: 1px solid var(--obh-border);
            border-radius: 12px;
            overflow: auto;
            max-height: 340px;
            background: var(--obh-surface);
        }
        .obh-results:empty { display: none; }

        .obh-results > * + * { border-top: 1px solid var(--obh-border); }

        .obh-result {
            padding: 9px 10px;
            cursor: pointer;
            display: flex;
            align-items: flex-start;
            gap: 10px;
        }

        .obh-result + .obh-result { border-top: 1px solid var(--obh-border); }
        .obh-result:hover { background: var(--obh-hover); }
        .obh-result:active { background: var(--obh-hover-strong); }

        .obh-result-main { flex: 1; min-width: 0; }

        .obh-result-title {
            font-weight: 650;
            font-size: 12.5px;
            color: var(--obh-fg);
            line-height: 1.25;
        }

        .obh-result-meta {
            margin-top: 3px;
            font-size: 11px;
            color: var(--obh-muted);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .obh-result-action {
            flex: 0 0 auto;
            font-size: 11px;
            color: var(--obh-accent);
            border: 1px solid var(--obh-border);
            padding: 2px 8px;
            border-radius: 999px;
            background: var(--obh-input-bg);
            opacity: 0.75;
            margin-top: 1px;
            cursor: pointer;
            user-select: none;
            white-space: nowrap;
        }

        .obh-result:hover .obh-result-action { opacity: 1; }
        .obh-result.obh-copied { background: rgba(6, 118, 71, 0.12); }
        .obh-group-header.obh-copied { background: rgba(6, 118, 71, 0.12); }

        .obh-group-header {
            padding: 9px 10px;
            cursor: pointer;
            display: flex;
            align-items: flex-start;
            gap: 10px;
        }

        .obh-group-header:hover { background: var(--obh-hover); }
        .obh-group-header:active { background: var(--obh-hover-strong); }

        .obh-group-actions {
            display: flex;
            flex: 0 0 auto;
            gap: 6px;
            align-items: flex-start;
        }

        .obh-versions { display: none; }

        .obh-group.obh-expanded .obh-versions {
            display: block;
            border-top: 1px solid var(--obh-border);
        }

        .obh-versions .obh-result {
            padding-left: 24px;
            background: transparent;
        }

        .obh-tabs {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 4px;
            padding: 4px;
            margin-bottom: 10px;
            border: 1px solid var(--obh-border);
            border-radius: 10px;
            background: var(--obh-surface);
        }

        .obh-tab {
            min-height: 32px;
            border: 0;
            border-radius: 7px;
            background: transparent;
            color: var(--obh-muted);
            font-size: 12px;
            font-weight: 650;
            cursor: pointer;
        }

        .obh-tab:hover {
            color: var(--obh-fg);
            background: var(--obh-hover);
        }

        .obh-tab[aria-selected="true"] {
            color: white;
            background: var(--obh-accent);
        }

        .obh-tab-panel[hidden] { display: none !important; }

        .obh-library-card {
            padding: 11px;
            border: 1px solid var(--obh-border);
            border-radius: 10px;
            background: var(--obh-surface);
        }

        .obh-library-heading {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 12px;
            margin-bottom: 8px;
        }

        .obh-library-heading strong {
            font-size: 12.5px;
        }

        .obh-library-help {
            margin-top: 3px;
            color: var(--obh-muted);
            font-size: 11px;
            line-height: 1.4;
        }

        .obh-library-count {
            flex: 0 0 auto;
            padding: 3px 7px;
            border-radius: 999px;
            background: var(--obh-accent-weak);
            color: var(--obh-accent);
            font-size: 11px;
            font-weight: 700;
            white-space: nowrap;
        }

        .obh-library-textarea {
            width: 100%;
            height: 280px;
            resize: vertical;
            padding: 9px 10px;
            border: 1px solid var(--obh-border);
            border-radius: 8px;
            background: var(--obh-input-bg);
            color: var(--obh-fg);
            font: 11.5px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
        }

        .obh-library-textarea:focus {
            outline: none;
            border-color: var(--obh-accent);
            box-shadow: 0 0 0 3px var(--obh-accent-weak);
        }

        .obh-library-actions {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            margin-top: 8px;
            flex-wrap: wrap;
        }

        .obh-button-row {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
        }

        .obh-secondary-button, .obh-danger-button {
            min-height: 31px;
            padding: 0 10px;
            border-radius: 7px;
            border: 1px solid var(--obh-border);
            background: var(--obh-input-bg);
            color: var(--obh-fg);
            font-size: 11.5px;
            cursor: pointer;
        }

        .obh-secondary-button:hover {
            border-color: var(--obh-accent);
            background: var(--obh-hover);
        }

        .obh-danger-button { color: var(--obh-danger); }
        .obh-danger-button:hover { background: rgba(180, 35, 24, 0.08); }

        .obh-save-button {
            min-height: 31px;
            padding: 0 12px;
            border: 1px solid transparent;
            border-radius: 7px;
            background: var(--obh-accent);
            color: white;
            font-size: 11.5px;
            font-weight: 700;
            cursor: pointer;
        }

        .obh-tip {
            margin-top: 9px;
            padding: 8px 9px;
            border-radius: 8px;
            background: var(--obh-accent-weak);
            color: var(--obh-fg);
            font-size: 11px;
            line-height: 1.4;
        }

        #obh-citation-hover {
            position: fixed;
            z-index: 2147483647;
            display: none;
            width: min(460px, calc(100vw - 20px));
            max-height: min(520px, calc(100vh - 20px));
            overflow: auto;
            padding: 0;
            background: #111827;
            color: #f3f4f6;
            border: 1px solid rgba(255,255,255,.16);
            border-radius: 10px;
            box-shadow: 0 16px 42px rgba(0,0,0,.42);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            font-size: 12px;
            line-height: 1.4;
        }

        #obh-citation-hover * { box-sizing: border-box; }
        .obh-cite-entry { padding: 11px 12px; }
        .obh-cite-entry + .obh-cite-entry { border-top: 1px solid rgba(255,255,255,.12); }
        .obh-cite-key { color: #93c5fd; font: 600 11px/1.3 ui-monospace, SFMono-Regular, Consolas, monospace; margin-bottom: 5px; }
        .obh-cite-authors { color: #f9fafb; font-weight: 650; margin-bottom: 3px; }
        .obh-cite-title-button {
            display: block;
            width: 100%;
            padding: 0;
            border: 0;
            background: transparent;
            color: #f3f4f6;
            text-align: left;
            font: italic 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            cursor: pointer;
        }
        .obh-cite-title-button:hover { color: #93c5fd; text-decoration: underline; }
        .obh-cite-title-static { color: #f3f4f6; font-style: italic; }
        .obh-cite-meta { color: #9ca3af; margin-top: 4px; }
        .obh-cite-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
        .obh-cite-action {
            min-height: 27px;
            padding: 0 8px;
            border: 1px solid rgba(255,255,255,.16);
            border-radius: 6px;
            background: rgba(255,255,255,.06);
            color: #e5e7eb;
            font-size: 11px;
            cursor: pointer;
        }
        .obh-cite-action:hover { border-color: #60a5fa; background: rgba(96,165,250,.12); }
        .obh-cite-source { color: #93c5fd; }
        .obh-cite-missing { color: #fca5a5; }

        .obh-footer {
            margin-top: 10px;
            display: flex;
            justify-content: space-between;
            gap: 10px;
            font-size: 11px;
            color: var(--obh-muted);
            user-select: none;
        }
    `);
}

function normalizeOrigin(origin) {
    if (!origin) return null;
    try {
        const url = new URL(origin);
        if (url.protocol !== "https:") return null;
        return `${url.protocol}//${url.host}`;
    } catch {
        return null;
    }
}

function getScholarOrigins() {
    const stored = GM_getValue("origins", []);
    const storedList = Array.isArray(stored) ? stored : [];
    const merged = [...new Set([...DEFAULT_SCHOLAR_ORIGINS, ...storedList].map(normalizeOrigin).filter(Boolean))];
    GM_setValue("origins", merged);
    return merged;
}

function getCurrentScholarOrigin() {
    const raw = GM_getValue("configure.origin", DEFAULT_SCHOLAR_ORIGINS[0]);
    const normalized = normalizeOrigin(raw) ?? DEFAULT_SCHOLAR_ORIGINS[0];
    if (normalized !== raw) GM_setValue("configure.origin", normalized);
    return normalized;
}

function setCurrentScholarOrigin(origin) {
    const normalized = normalizeOrigin(origin);
    if (!normalized) return false;
    GM_setValue("configure.origin", normalized);
    return true;
}

(function () {
    'use strict';
    if (location.hostname === 'dl.acm.org') {
        runACMCitationBridge();
        return;
    }
    initBrandTheme();
    injectObhStyles();
    registerGlobalShortcuts();
    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('Open Bib Toolkit (Alt+Shift+B)', openHelper);
        GM_registerMenuCommand('Manage project BibTeX', () => openHelper('library'));
    }
    loadCitationLibrary();
    initCitationHoverPreview();
    startInjectionWatcher();
})();

function isVisible(el) {
    if (!el?.isConnected) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

function registerGlobalShortcuts() {
    document.addEventListener('keydown', (event) => {
        if (event.isComposing) return;
        if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyB') {
            event.preventDefault();
            event.stopPropagation();
            openHelper();
        } else if (event.key === 'Escape' && showBox) {
            togglePopup(document.getElementById('obh-popup'), false);
            event.preventDefault();
            event.stopPropagation();
        }
    }, true);

    document.addEventListener('pointerdown', (event) => {
        if (!showBox) return;
        const popup = document.getElementById('obh-popup');
        const icon = document.getElementById('obh-toggle-icon');
        if (popup?.contains(event.target) || icon?.contains(event.target)) return;
        togglePopup(popup, false, false);
    }, true);
    window.addEventListener('resize', () => { scheduleEnsureInjected(); positionPopup(); });
    document.addEventListener('scroll', positionPopup, true);
}

function startInjectionWatcher() {
    if (injectionWatcherStarted) return;
    if (!document.body) {
        window.addEventListener('DOMContentLoaded', startInjectionWatcher, { once: true });
        return;
    }
    injectionWatcherStarted = true;
    scheduleEnsureInjected();
    const observer = new MutationObserver((records) => {
        // Ignore our own result rendering and position updates.
        if (records.some(record => !record.target.closest?.('#obh-popup, #obh-toggle-icon'))) {
            scheduleEnsureInjected();
        }
    });
    observer.observe(document.body, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['class', 'style', 'hidden'],
    });
}

function scheduleEnsureInjected() {
    if (injectScheduled) return;
    injectScheduled = true;
    setTimeout(() => {
        injectScheduled = false;
        ensureInjected();
    }, 120);
}

function ensureInjected() {
    if (injectInProgress || !document.body) return;
    let toolbar = null;
    for (const selector of TOOLBAR_SELECTORS) {
        toolbar = Array.from(document.querySelectorAll(selector)).find(isVisible);
        if (toolbar) break;
    }
    if (toolbar) injectUi(toolbar);
    if (showBox) positionPopup();
}

function getPopup() {
    let popup = document.getElementById('obh-popup');
    if (!popup) {
        popup = createBox();
        document.body.appendChild(popup);
        bindPopupEvents(popup);
    }
    return popup;
}

function injectUi(toolbar) {
    injectInProgress = true;
    try {
        let icon = document.getElementById('obh-toggle-icon');
        if (!icon) {
            icon = createToggleIcon();
            // CodeMirror handles bubbled mouse presses as editor selection gestures.
            icon.addEventListener('pointerdown', event => event.stopPropagation());
            icon.addEventListener('mousedown', event => {
                event.preventDefault();
                event.stopPropagation();
            });
            icon.onclick = event => {
                event.stopPropagation();
                togglePopup(getPopup());
            };
        }
        // React may replace or hide its toolbar when switching files/layouts.
        if (icon.parentElement !== toolbar) toolbar.appendChild(icon);
        icon.classList.toggle('obh-active', showBox);
        icon.setAttribute('aria-expanded', String(showBox));
    } finally {
        injectInProgress = false;
    }
}

function bindPopupEvents(popup) {
    popup.querySelector('#obh-close').onclick = () => togglePopup(popup, false);
    popup.querySelector('#obh-tab-search').onclick = () => setToolTab(popup, 'search');
    popup.querySelector('#obh-tab-library').onclick = () => setToolTab(popup, 'library');
    popup.querySelector('#obh-library-save').onclick = () => saveCitationLibraryFromUI(popup);
    popup.querySelector('#obh-library-clear').onclick = () => clearCitationLibraryFromUI(popup);
    popup.querySelector('#obh-search-word').onclick = () => queryArticle();
    popup.querySelector('#obh-search-input').onkeydown = (event) => {
        if (event.key === 'Enter' && !event.isComposing) {
            event.preventDefault();
            queryArticle();
        }
    };
    popup.querySelector('.obh-advanced').ontoggle = positionPopup;
    popup.querySelector('#obh-search-content').onclick = (event) => {
        const target = event.target instanceof Element ? event.target : event.target?.parentElement;
        if (!target || target.closest('a')) return;
        const action = target.closest('[data-obh-action]');
        const group = target.closest('.obh-group');
        const item = target.closest('.obh-result');
        if (action?.dataset.obhAction === 'toggle-versions') {
            toggleGroupVersions(group);
            return;
        }
        if (action) {
            const source = item?.dataset.source ?? group?.dataset.bestSource;
            const cid = item?.dataset.cid ?? group?.dataset.bestCid;
            const origin = item?.dataset.origin ?? group?.dataset.origin;
            if (action.dataset.obhAction === 'preview') {
                previewBib(source, cid, origin);
            } else {
                copyBibToClipboard(source, cid, item ?? group?.querySelector('.obh-group-header'), origin);
            }
        } else if (item) {
            copyBibToClipboard(item.dataset.source, item.dataset.cid, item, item.dataset.origin);
        } else if (target.closest('.obh-group-header')) {
            toggleGroupVersions(group);
        }
    };
    popup.querySelector('#obh-close-preview').onclick = () => {
        previewSequence++;
        popup.querySelector('#obh-preview').hidden = true;
        positionPopup();
    };
    popup.querySelector('#obh-citation-key').onchange = () => {
        try {
            const area = popup.querySelector('#obh-bib-preview');
            area.value = replaceCitationKey(area.value, popup.querySelector('#obh-citation-key').value.trim());
            setStatus(popup.querySelector('#obh-preview-status'), 'success', 'Citation key updated.');
        } catch (error) {
            setStatus(popup.querySelector('#obh-preview-status'), 'error', error.message);
        }
    };
    popup.querySelector('#obh-bib-preview').oninput = () => {
        popup.querySelector('#obh-citation-key').value = citationKey(popup.querySelector('#obh-bib-preview').value);
    };
    for (const mode of ['preview', 'key', 'cite']) {
        popup.querySelector(`#obh-copy-${mode}`).onclick = () => copyPreview(mode);
    }
    popup.querySelector('#obh-download-bib').onclick = downloadPreview;
}

function openHelper(tab) {
    ensureInjected();
    const popup = getPopup();
    if (tab === 'search' || tab === 'library') setToolTab(popup, tab, false);
    togglePopup(popup, true);
}

function togglePopup(popup, visible = !showBox, restoreFocus = true) {
    if (!popup) return;
    const opening = visible && !showBox;
    if (opening) {
        focusBeforePopup = document.activeElement;
        const selection = window.getSelection()?.toString().trim();
        if (selection && selection.length <= 500 && !popup.contains(document.activeElement)) {
            popup.querySelector('#obh-search-input').value = selection;
        }
    }
    showBox = visible;
    popup.style.display = visible ? 'block' : 'none';
    const icon = document.getElementById('obh-toggle-icon');
    icon?.classList.toggle('obh-active', visible);
    icon?.setAttribute('aria-expanded', String(visible));
    if (visible) {
        initBrandTheme();
        const editor = Array.from(document.querySelectorAll('.cm-editor')).find(isVisible);
        const background = editor ? parseCssColorToRgb(getComputedStyle(editor).backgroundColor) : null;
        popup.dataset.theme = background && (background.r * 0.299 + background.g * 0.587 + background.b * 0.114) < 128 ? 'dark' : 'light';
        const activeTab = GM_getValue('ui.activeTab', 'search') === 'library' ? 'library' : 'search';
        setToolTab(popup, activeTab, false);
        positionPopup();
        if (activeTab === 'search') {
            const input = popup.querySelector('#obh-search-input');
            input.focus();
            input.select();
        } else {
            const area = popup.querySelector('#obh-library-textarea');
            area.focus();
        }
    } else if (restoreFocus && isVisible(focusBeforePopup)) {
        focusBeforePopup.focus();
    }
}

function positionPopup() {
    const popup = document.getElementById('obh-popup');
    if (!showBox || !popup) return;
    const icon = document.getElementById('obh-toggle-icon');
    const rect = isVisible(icon) ? icon.getBoundingClientRect() : null;
    const width = popup.offsetWidth;
    const height = popup.offsetHeight;
    const margin = 12;
    const x = rect ? rect.right - width : (window.innerWidth - width) / 2;
    let y = rect ? rect.bottom + 6 : margin;
    if (rect && y + height > window.innerHeight - margin && rect.top - height - 6 >= margin) {
        y = rect.top - height - 6;
    }
    popup.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - width - margin))}px`;
    popup.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - height - margin))}px`;
}

async function queryArticle() {
    const sequence = ++searchSequence;
    copySequence++;
    previewSequence++;
    const preview = document.getElementById('obh-preview');
    if (preview) preview.hidden = true;
    const statusEl = document.getElementById("obh-status");
    const resultsEl = document.getElementById("obh-search-content");
    const searchButton = document.getElementById("obh-search-word");
    if (!resultsEl) return;
    resultsEl.replaceChildren();

    const word = (document.getElementById('obh-search-input')?.value ?? "").trim();
    if (!word) {
        if (searchButton) searchButton.disabled = false;
        setStatus(statusEl, 'info', "Please enter a query.");
        return;
    }
    GM_setValue('lastQuery', word);
    rememberQuery(word);

    const source = document.getElementById("obh-source")?.value ?? "DBLP";
    const bibPreference = document.getElementById('obh-bib-source')?.value ?? 'official';
    const resultCount = Number.parseInt(document.getElementById("obh-resultCount")?.value ?? "5", 10) || 5;
    const versionPref = document.getElementById("obh-versionPref")?.value ?? GM_getValue("versionPref", "published");
    const sortMode = document.getElementById("obh-sort")?.value ?? GM_getValue("sortMode", "relevance");
    let yearFrom = parseYearInput(document.getElementById("obh-yearFrom")?.value);
    let yearTo = parseYearInput(document.getElementById("obh-yearTo")?.value);
    if (yearFrom && yearTo && yearFrom > yearTo) [yearFrom, yearTo] = [yearTo, yearFrom];
    const origin = getCurrentScholarOrigin();

    if (searchButton) searchButton.disabled = true;
    setStatus(statusEl, 'loading', source === "GoogleScholar" ? "Searching Google Scholar..." : "Searching DBLP...");

    try {
        const lists = source === "DBLP"
            ? await getArticleIDListDBLP(word, resultCount)
            : await getArticleIDListGoogleScholar(word, resultCount, { yearFrom, yearTo, sortMode, origin });
        if (sequence !== searchSequence) return;

        if (!lists || lists.length === 0) {
            setStatus(statusEl, 'info', "No results found. Try different keywords.");
            return;
        }

        const filtered = source === 'DBLP' ? filterByYearRange(lists, yearFrom, yearTo) : lists;
        const groups = buildGroupedResults(filtered, source, { versionPref, sortMode }).slice(0, resultCount);

        if (!groups || groups.length === 0) {
            setStatus(statusEl, 'info', 'No results match your filters.');
            return;
        }

        renderSearchResults(resultsEl, groups, bibPreference);

        const paperCount = groups.length;
        const versionCount = groups.reduce((sum, g) => sum + (g.versions?.length ?? 0), 0);
        const multiVersionCount = groups.filter(g => (g.versions?.length ?? 0) > 1).length;
        const warningCount = groups.filter(g => g.note).length;

        const paperText = `${paperCount} paper${paperCount === 1 ? '' : 's'}`;
        const versionText = `${versionCount} version${versionCount === 1 ? '' : 's'}`;
        const extra = multiVersionCount ? ` • ${multiVersionCount} with versions` : '';
        const warnings = warningCount ? ` • ${warningCount} preprint-only` : '';
        setStatus(statusEl, 'success', `${paperText}${extra} • ${versionText}${warnings}. Preview to edit the citation key or copy a citation.`);
    } catch (err) {
        if (sequence !== searchSequence) return;
        showRequestError(err, source, statusEl);
    } finally {
        if (sequence === searchSequence) {
            if (searchButton) searchButton.disabled = false;
            positionPopup();
        }
    }
}

function createToggleIcon() {
    const iconBox = document.createElement('button');
    iconBox.type = 'button';
    iconBox.className = 'ol-cm-toolbar-button obh-toggle';
    iconBox.style.display = 'flex';
    iconBox.style.justifyContent = 'center';
    iconBox.style.alignItems = 'center';
    iconBox.id = 'obh-toggle-icon';
    iconBox.title = 'Overleaf Bib Toolkit (Alt+Shift+B)';
    iconBox.setAttribute('aria-label', 'Overleaf Bib Toolkit');
    iconBox.setAttribute('aria-controls', 'obh-popup');
    iconBox.setAttribute('aria-expanded', String(showBox));
    iconBox.setAttribute('aria-haspopup', 'dialog');
    iconBox.textContent = 'Bib';
    return iconBox;
}

function createBox() {
    const box = document.createElement('div');
    box.id = 'obh-popup';
    box.className = 'obh-popup';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Overleaf Bib Toolkit');
    box.innerHTML = `
        <div class="obh-header">
            <div class="obh-brand">
                <div style="min-width:0;">
                    <div class="obh-title">Bib Toolkit</div>
                    <div class="obh-subtitle">Search papers · manage BibTeX · inspect citations</div>
                </div>
            </div>
            <button id="obh-close" class="obh-icon-button" type="button" aria-label="Close">
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" d="M18.3 5.71a1 1 0 0 0-1.41 0L12 10.59 7.11 5.7a1 1 0 1 0-1.41 1.42L10.59 12l-4.9 4.89a1 1 0 1 0 1.41 1.42L12 13.41l4.89 4.9a1 1 0 0 0 1.42-1.41L13.41 12l4.9-4.89a1 1 0 0 0-.01-1.4z"/>
                </svg>
            </button>
        </div>

        <div class="obh-tabs" role="tablist" aria-label="Bib Toolkit views">
            <button id="obh-tab-search" class="obh-tab" type="button" role="tab" aria-selected="true" aria-controls="obh-search-panel">Search papers</button>
            <button id="obh-tab-library" class="obh-tab" type="button" role="tab" aria-selected="false" aria-controls="obh-library-panel">My BibTeX</button>
        </div>

        <div id="obh-search-panel" class="obh-tab-panel" role="tabpanel" aria-labelledby="obh-tab-search">
        <div class="obh-search-row">
            <input id="obh-search-input" class="obh-search-input" aria-label="Search papers" placeholder="Title, author, keywords" autocomplete="off" list="obh-recent-queries" />
            <datalist id="obh-recent-queries"></datalist>
            <button id="obh-search-word" class="obh-primary-button" type="button" aria-label="Search">
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
                </svg>
            </button>
        </div>

        <div class="obh-controls">
            <div class="obh-control">
                <label for="obh-source">Search</label>
                <select id="obh-source" class="obh-select">
                    <option value="DBLP">DBLP</option>
                    <option value="GoogleScholar">Google Scholar</option>
                </select>
            </div>
            <div id="obh-bib-source-row" class="obh-control">
                <label for="obh-bib-source">BibTeX</label>
                <select id="obh-bib-source" class="obh-select">
                    <option value="official">Official venue when available</option>
                    <option value="search">DBLP</option>
                </select>
            </div>
        </div>
        <details class="obh-advanced">
            <summary>Search options: versions, years, mirror, result count</summary>
            <div class="obh-controls">
            <div id="obh-versionpref-row" class="obh-control">
                <label for="obh-versionPref">Version</label>
                <select id="obh-versionPref" class="obh-select">
                    <option value="published">Published first (Recommended)</option>
                    <option value="hidePreprints">Hide preprints</option>
                    <option value="any">Any</option>
                    <option value="preprint">Preprints first</option>
                </select>
            </div>
            <div id="obh-scholar-origin-row" class="obh-control" style="display:none;">
                <label for="obh-scholar-origin">Mirror</label>
                <select id="obh-scholar-origin" class="obh-select"></select>
            </div>
            <div class="obh-control">
                <label for="obh-sort">Order</label>
                <select id="obh-sort" class="obh-select">
                    <option value="relevance">Relevance</option>
                    <option value="newest">Newest first</option>
                    <option value="oldest">Oldest first</option>
                </select>
            </div>
            <div class="obh-control" style="flex: 1 1 240px; min-width: 240px;">
                <label>Year range</label>
                <div class="obh-year-range">
                    <input id="obh-yearFrom" class="obh-year-input" aria-label="From year" inputmode="numeric" placeholder="From" />
                    <span class="obh-year-sep">–</span>
                    <input id="obh-yearTo" class="obh-year-input" aria-label="To year" inputmode="numeric" placeholder="To" />
                </div>
            </div>
            <div class="obh-control">
                <label for="obh-resultCount">Results</label>
                <select id="obh-resultCount" class="obh-select">
                    <option value="5">5</option>
                    <option value="10">10</option>
                    <option value="20">20</option>
                    <option value="50">50</option>
                </select>
            </div>
        </div>
        </details>

        <div id="obh-status" class="obh-status" role="status" aria-live="polite"></div>
        <div id="obh-search-content" class="obh-results" aria-label="Search results"></div>

        <section id="obh-preview" class="obh-preview" aria-label="BibTeX preview" hidden>
            <div class="obh-header">
                <strong class="obh-title">BibTeX preview</strong>
                <button id="obh-close-preview" class="obh-result-action" type="button">Close preview</button>
            </div>
            <div id="obh-preview-source" class="obh-result-meta"></div>
            <label for="obh-citation-key">Citation key</label>
            <input id="obh-citation-key" class="obh-search-input" autocomplete="off" />
            <label for="obh-bib-preview">BibTeX (editable)</label>
            <textarea id="obh-bib-preview" spellcheck="false"></textarea>
            <div class="obh-result-actions">
                <button id="obh-copy-preview" class="obh-result-action" type="button">Copy BibTeX</button>
                <button id="obh-copy-key" class="obh-result-action" type="button">Copy key</button>
                <button id="obh-copy-cite" class="obh-result-action" type="button">Copy \\cite{key}</button>
                <button id="obh-download-bib" class="obh-result-action" type="button">Download .bib</button>
            </div>
            <div id="obh-preview-status" class="obh-status" role="status" aria-live="polite"></div>
        </section>
        </div>

        <div id="obh-library-panel" class="obh-tab-panel" role="tabpanel" aria-labelledby="obh-tab-library" hidden>
            <div class="obh-library-card">
                <div class="obh-library-heading">
                    <div>
                        <strong>Project bibliography</strong>
                        <div class="obh-library-help">Paste the complete contents of your .bib file. It is stored only for this Overleaf project and powers citation hover previews.</div>
                    </div>
                    <span id="obh-library-count" class="obh-library-count">0 entries</span>
                </div>
                <textarea id="obh-library-textarea" class="obh-library-textarea" spellcheck="false" placeholder="@inproceedings{key,
  author = {...},
  title = {...},
  ...
}"></textarea>
                <div class="obh-library-actions">
                    <div class="obh-button-row">
                        <button id="obh-library-save" class="obh-save-button" type="button">Parse & save</button>
                        <button id="obh-library-clear" class="obh-danger-button" type="button">Clear saved</button>
                    </div>
                    <span id="obh-library-project" class="obh-library-help"></span>
                </div>
                <div id="obh-library-status" class="obh-status" role="status" aria-live="polite"></div>
                <div class="obh-tip"><strong>Hover a citation:</strong> move the pointer over <code>\cite{key}</code> in the editor. The card shows authors, title, venue, and year, with quick actions to <strong>Copy title</strong> or copy the citation command.</div>
            </div>
        </div>

        <div class="obh-footer">
            <span>Alt+Shift+B: open toolkit · Enter: search</span>
            <span>Esc: close</span>
        </div>
    `;

    const sourceSelect = box.querySelector('#obh-source');
    const bibSourceSelect = box.querySelector('#obh-bib-source');
    const versionRow = box.querySelector('#obh-versionpref-row');
    const versionSelect = box.querySelector('#obh-versionPref');
    const sortSelect = box.querySelector('#obh-sort');
    const yearFromInput = box.querySelector('#obh-yearFrom');
    const yearToInput = box.querySelector('#obh-yearTo');
    const countSelect = box.querySelector('#obh-resultCount');
    const originRow = box.querySelector('#obh-scholar-origin-row');
    const originSelect = box.querySelector('#obh-scholar-origin');
    const searchInput = box.querySelector('#obh-search-input');
    const statusEl = box.querySelector('#obh-status');

    if (!sourceSelect || !versionRow || !versionSelect || !sortSelect || !yearFromInput || !yearToInput || !countSelect || !originRow || !originSelect || !searchInput || !statusEl) {
        return box;
    }

    sourceSelect.value = GM_getValue('searchSource', 'DBLP');
    bibSourceSelect.value = GM_getValue('bibSource', 'official') === 'search' ? 'search' : 'official';
    versionSelect.value = GM_getValue('versionPref', 'published');
    sortSelect.value = GM_getValue('sortMode', 'relevance');
    yearFromInput.value = GM_getValue('yearFrom', '');
    yearToInput.value = GM_getValue('yearTo', '');
    countSelect.value = GM_getValue('resultCount', '10');
    searchInput.value = GM_getValue('lastQuery', '');

    const refreshOrigins = () => {
        const origins = getScholarOrigins();
        const current = getCurrentScholarOrigin();
        const resolvedCurrent = origins.includes(current) ? current : origins[0];
        setCurrentScholarOrigin(resolvedCurrent);

        originSelect.replaceChildren();
        for (const origin of origins) {
            const option = document.createElement("option");
            option.value = origin;
            option.textContent = origin.replace(/^https:\/\//, "");
            originSelect.appendChild(option);
        }
        const custom = document.createElement("option");
        custom.value = "__custom__";
        custom.textContent = "Add custom…";
        originSelect.appendChild(custom);

        originSelect.value = resolvedCurrent;
    };

    const updateControlVisibility = () => {
        const isScholar = sourceSelect.value === 'GoogleScholar';
        originRow.style.display = isScholar ? 'block' : 'none';
        versionRow.style.display = isScholar ? 'none' : 'block';
        box.querySelector('#obh-bib-source-row').hidden = isScholar;

        const oldestOption = sortSelect.querySelector('option[value="oldest"]');
        if (oldestOption) oldestOption.disabled = isScholar;
        if (isScholar && sortSelect.value === 'oldest') sortSelect.value = 'relevance';
    };

    sourceSelect.addEventListener('change', () => {
        invalidateSearch(box);
        GM_setValue('searchSource', sourceSelect.value);
        updateControlVisibility();
        setStatus(statusEl, 'info', sourceSelect.value === 'GoogleScholar'
            ? 'Scholar may require verification. Use the verification link on errors, or switch to DBLP.'
            : 'Find papers with DBLP; use original BibTeX from supported official venues. Each result shows its citation source.');
    });
    bibSourceSelect.addEventListener('change', () => {
        invalidateSearch(box);
        GM_setValue('bibSource', bibSourceSelect.value);
        if (searchInput.value.trim()) queryArticle();
    });
    versionSelect.addEventListener('change', () => GM_setValue('versionPref', versionSelect.value));
    sortSelect.addEventListener('change', () => GM_setValue('sortMode', sortSelect.value));
    yearFromInput.addEventListener('change', () => {
        const sanitized = sanitizeYearInput(yearFromInput.value);
        yearFromInput.value = sanitized;
        GM_setValue('yearFrom', sanitized);
    });
    yearToInput.addEventListener('change', () => {
        const sanitized = sanitizeYearInput(yearToInput.value);
        yearToInput.value = sanitized;
        GM_setValue('yearTo', sanitized);
    });
    countSelect.addEventListener('change', () => GM_setValue('resultCount', countSelect.value));

    originSelect.addEventListener('change', () => {
        if (originSelect.value === '__custom__') {
            const proposed = prompt('Enter a Google Scholar mirror origin (https://...):', getCurrentScholarOrigin());
            const normalized = normalizeOrigin((proposed ?? '').trim());
            if (!normalized) {
                if (proposed !== null) setStatus(statusEl, 'error', 'Please enter a valid https:// mirror origin.');
                refreshOrigins();
                return;
            }
            const updated = [...new Set([...getScholarOrigins(), normalized])];
            GM_setValue('origins', updated);
            setCurrentScholarOrigin(normalized);
            refreshOrigins();
            return;
        }
        setCurrentScholarOrigin(originSelect.value);
    });

    refreshOrigins();
    updateControlVisibility();
    refreshRecentQueries(box);
    setStatus(statusEl, 'info', sourceSelect.value === 'GoogleScholar'
        ? 'Scholar may require verification. Use the verification link on errors, or switch to DBLP.'
        : 'Find papers with DBLP; use original BibTeX from supported official venues. Each result shows its citation source.');

    refreshCitationLibraryUI(box);
    setToolTab(box, GM_getValue('ui.activeTab', 'search'), false);
    return box;
}

function setStatus(statusEl, kind, text) {
    if (!statusEl) return;
    const base = 'obh-status';
    const variant = kind ? ` obh-status-${kind}` : '';
    statusEl.className = base + variant;
    statusEl.textContent = text ?? '';
    positionPopup();
}

function markCopied(el) {
    if (!el) return;
    el.classList.add('obh-copied');
    setTimeout(() => el.classList.remove('obh-copied'), 650);
}

function toggleGroupVersions(groupEl) {
    if (!groupEl) return;
    const expanded = groupEl.classList.toggle('obh-expanded');
    const toggleEl = groupEl.querySelector?.('[data-obh-action="toggle-versions"]');
    if (!toggleEl) return;
    const count = groupEl.dataset.versionCount || '';
    toggleEl.textContent = expanded ? 'Hide versions' : `Versions (${count || '…'})`;
    toggleEl.setAttribute('aria-expanded', String(expanded));
    positionPopup();
}

function invalidateSearch(popup) {
    searchSequence++;
    copySequence++;
    previewSequence++;
    popup.querySelector('#obh-search-content').replaceChildren();
    popup.querySelector('#obh-search-word').disabled = false;
    popup.querySelector('#obh-preview').hidden = true;
}

function refreshRecentQueries(root = document) {
    const list = root.querySelector('#obh-recent-queries');
    if (!list) return;
    const history = GM_getValue('recentQueries', []);
    list.replaceChildren();
    for (const query of (Array.isArray(history) ? history : []).filter(q => typeof q === 'string').slice(0, 10)) {
        const option = document.createElement('option');
        option.value = query;
        list.appendChild(option);
    }
}

function rememberQuery(query) {
    const history = GM_getValue('recentQueries', []);
    GM_setValue('recentQueries', [...new Set([query, ...(Array.isArray(history) ? history : [])])].slice(0, 10));
    refreshRecentQueries();
}

function showRequestError(error, source, status = document.getElementById('obh-status')) {
    setStatus(status, 'error', error?.message || 'Request failed. Please retry.');
    const verificationUrl = normalizeOrigin(error?.verificationUrl) ? error.verificationUrl : null;
    if (verificationUrl) {
        const verify = document.createElement('button');
        verify.type = 'button';
        verify.className = 'obh-result-action';
        verify.textContent = 'Open verification page';
        verify.onclick = () => GM_openInTab(verificationUrl, { active: true, insert: true });
        status.appendChild(verify);
    }
    if (source === 'GoogleScholar') {
        const fallback = document.createElement('button');
        fallback.type = 'button';
        fallback.className = 'obh-result-action';
        fallback.textContent = 'Search DBLP instead';
        fallback.onclick = () => {
            const select = document.getElementById('obh-source');
            select.value = 'DBLP';
            select.dispatchEvent(new Event('change', { bubbles: true }));
            queryArticle();
        };
        status.appendChild(fallback);
    }
    if (Object.hasOwn(OFFICIAL_BIB_LABELS, source)) {
        const fallback = document.createElement('button');
        fallback.type = 'button';
        fallback.className = 'obh-result-action';
        fallback.textContent = 'Use DBLP BibTeX';
        fallback.onclick = () => {
            const select = document.getElementById('obh-bib-source');
            select.value = 'search';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        };
        status.appendChild(fallback);
    }
    positionPopup();
}

function fetchBib(source, cid, origin) {
    if (!cid || !['DBLP', 'GoogleScholar'].includes(source) && !Object.hasOwn(OFFICIAL_BIB_LABELS, source)) {
        return Promise.reject(new Error('Invalid paper.'));
    }
    const key = JSON.stringify([source, origin || '', cid]);
    if (bibCache.has(key)) return bibCache.get(key);
    const pending = Promise.resolve().then(() => {
        if (Object.hasOwn(OFFICIAL_BIB_LABELS, source)) return getBibTexOfficial(source, cid);
        return source === 'DBLP' ? getBibTexDBLP(cid) : getBibTexGoogleScholar(cid, origin || getCurrentScholarOrigin());
    })
        .then(validateBibTeX).catch(error => {
            if (bibCache.get(key) === pending) bibCache.delete(key);
            throw error;
        });
    bibCache.set(key, pending);
    if (bibCache.size > 50) bibCache.delete(bibCache.keys().next().value);
    return pending;
}

async function copyBibToClipboard(source, cid, highlightEl, origin) {
    if (!source || !cid) return;
    const sequence = ++copySequence;
    const status = document.getElementById('obh-status');
    setStatus(status, 'loading', `Fetching BibTeX from ${bibSourceLabel(source)}…`);
    try {
        const bib = await fetchBib(source, cid, origin);
        if (sequence !== copySequence) return;
        await GM_setClipboard(bib, 'text');
        markCopied(highlightEl);
        setStatus(status, 'success', `BibTeX copied from ${bibSourceLabel(source)}. Paste it into your .bib file.`);
    } catch (error) {
        if (sequence === copySequence) showRequestError(error, source, status);
    }
}

function citationKey(bib) {
    try {
        const { records } = parseBibTeXRecords(bib);
        return records.length === 1 ? records[0].key : '';
    } catch { return ''; }
}

function replaceCitationKey(bib, key) {
    if (!/^[\p{L}\p{N}_:.+\-/]+$/u.test(key)) {
        throw new Error('Use letters, numbers, _, :, ., +, -, or / in the citation key.');
    }
    const parsed = parseBibTeXRecords(bib);
    if (parsed.records.length !== 1) throw new Error('Preview supports one BibTeX entry at a time.');
    const record = parsed.records[0];
    return parsed.bib.slice(0, record.keyStart) + key + parsed.bib.slice(record.keyEnd);
}

async function previewBib(source, cid, origin) {
    const sequence = ++previewSequence;
    const previewTrigger = document.activeElement;
    const preview = document.getElementById('obh-preview');
    const status = document.getElementById('obh-preview-status');
    const area = document.getElementById('obh-bib-preview');
    const keyInput = document.getElementById('obh-citation-key');
    const sourceEl = document.getElementById('obh-preview-source');
    preview.hidden = false;
    sourceEl.replaceChildren();
    area.value = '';
    keyInput.value = '';
    const actions = preview.querySelectorAll('input, textarea, .obh-result-actions button');
    actions.forEach(el => { el.disabled = true; });
    setStatus(status, 'loading', 'Loading BibTeX preview…');
    positionPopup();
    try {
        const bib = await fetchBib(source, cid, origin);
        if (sequence !== previewSequence) return;
        if (parseBibTeXRecords(bib).records.length !== 1) throw new Error('Preview supports one BibTeX entry at a time.');
        area.value = bib;
        sourceEl.append('BibTeX source: ');
        const sourceLink = document.createElement('a');
        sourceLink.textContent = bibSourceLabel(source);
        if (source !== 'GoogleScholar') {
            sourceLink.href = cid;
            sourceLink.target = '_blank';
            sourceLink.rel = 'noopener noreferrer';
        }
        sourceEl.append(sourceLink);
        keyInput.value = citationKey(bib);
        actions.forEach(el => { el.disabled = false; });
        setStatus(status, 'info', 'Edit the key or BibTeX before copying. Add the entry to your .bib file before using its citation.');
        if (showBox && document.activeElement === previewTrigger) {
            keyInput.focus();
            keyInput.scrollIntoView({ block: 'nearest' });
        }
    } catch (error) {
        if (sequence === previewSequence) showRequestError(error, source, status);
    } finally {
        if (sequence === previewSequence) positionPopup();
    }
}

function currentPreviewBib() {
    const area = document.getElementById('obh-bib-preview');
    const key = document.getElementById('obh-citation-key').value.trim();
    const bib = replaceCitationKey(validateBibTeX(area.value), key);
    area.value = bib;
    return bib;
}

async function copyPreview(mode) {
    const sequence = ++copySequence;
    const status = document.getElementById('obh-preview-status');
    try {
        const bib = currentPreviewBib();
        const key = citationKey(bib);
        const text = mode === 'cite' ? `\\cite{${key}}` : mode === 'key' ? key : bib;
        await GM_setClipboard(text, 'text');
        if (sequence === copySequence) setStatus(status, 'success', mode === 'preview' ? 'BibTeX copied.' : mode === 'key' ? 'Citation key copied.' : 'Citation command copied.');
    } catch (error) {
        setStatus(status, 'error', error.message || 'Copy failed.');
    }
}

function downloadPreview() {
    const status = document.getElementById('obh-preview-status');
    try {
        const bib = currentPreviewBib();
        const url = URL.createObjectURL(new Blob([bib + '\n'], { type: 'application/x-bibtex;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = citationKey(bib).replace(/[^a-z0-9_.-]/gi, '_') + '.bib';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setStatus(status, 'success', 'BibTeX file downloaded.');
    } catch (error) {
        setStatus(status, 'error', error.message);
    }
}

function normalizeKeyText(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return '';
    try {
        return raw
            .toLowerCase()
            .normalize('NFKD')
            .replace(/\p{M}/gu, '')
            .replace(/[^\p{L}\p{N}]+/gu, ' ')
            .trim()
            .replace(/\s+/g, ' ');
    } catch {
        return raw.toLowerCase().trim().replace(/\s+/g, ' ');
    }
}

function normalizeTitleKey(title) {
    const key = normalizeKeyText(title);
    return key || String(title ?? '').trim().toLowerCase();
}

function getFirstAuthor(authorText) {
    const raw = String(authorText ?? '').trim();
    if (!raw) return '';
    return raw.split(/,| and |\u2026|\.{3}/i)[0]?.trim() ?? '';
}

function makeGroupKey(title, authorText) {
    const titleKey = normalizeTitleKey(title);
    const authorKey = normalizeKeyText(getFirstAuthor(authorText));
    return authorKey ? `${titleKey}::${authorKey}` : titleKey;
}

function groupSearchResults(results, source) {
    const map = new Map();
    const groups = [];
    results.forEach((item, index) => {
        const key = makeGroupKey(item.title, item.author);
        let group = map.get(key);
        if (!group) {
            group = {
                key,
                source,
                title: item.title,
                author: item.author,
                firstIndex: index,
                note: '',
                versions: []
            };
            map.set(key, group);
            groups.push(group);
        }
        group.versions.push(item);
    });
    return groups;
}

function orderDblpVersions(versions, versionPref, sortMode) {
    const isPreprint = (item) => getDblpVersionKind(item) === 'preprint';
    const published = versions.filter(item => !isPreprint(item));
    const preprints = versions.filter(item => isPreprint(item));
    const order = (items) => sortDblpArticles(items, sortMode);

    if (versionPref === 'hidePreprints') {
        return { ordered: order(published), note: '' };
    }
    if (versionPref === 'published') return { ordered: order(published).concat(order(preprints)), note: '' };
    if (versionPref === 'preprint') return { ordered: order(preprints).concat(order(published)), note: '' };
    return { ordered: order(versions), note: '' };
}

function sortGroupsByBestYear(groups, sortMode) {
    if (sortMode !== 'newest' && sortMode !== 'oldest') return groups;
    const desc = sortMode === 'newest';
    return groups
        .map((group, index) => ({ group, index, year: parseArticleYear(group.best?.year) }))
        .sort((a, b) => {
            if (a.year == null && b.year == null) return a.index - b.index;
            if (a.year == null) return 1;
            if (b.year == null) return -1;
            if (a.year !== b.year) return desc ? (b.year - a.year) : (a.year - b.year);
            return a.index - b.index;
        })
        .map(entry => entry.group);
}

function buildGroupedResults(results, source, { versionPref, sortMode } = {}) {
    const groups = groupSearchResults(results, source);

    for (const group of groups) {
        if (source === 'DBLP') {
            const { ordered, note } = orderDblpVersions(group.versions, versionPref ?? 'published', sortMode ?? 'relevance');
            group.versions = ordered;
            group.note = note;
        }
        group.best = group.versions[0] ?? null;
    }

    const nonemptyGroups = groups.filter(group => group.best);
    if (source === 'DBLP') {
        return sortGroupsByBestYear(nonemptyGroups, sortMode ?? 'relevance');
    }

    return nonemptyGroups;
}

function formatVersionMeta(article, source) {
    if (source === 'DBLP') {
        const parts = [];
        if (article.year) parts.push(String(article.year).trim());
        if (article.venue) parts.push(String(article.venue).trim());
        const kind = getDblpVersionKind(article);
        parts.push(kind === 'preprint' ? 'Preprint' : 'Published');
        if (article.author) parts.push(String(article.author).trim());
        return parts.filter(Boolean).join(' • ');
    }
    return String(article.author ?? '').trim();
}

function bibSourceLabel(source) {
    return OFFICIAL_BIB_LABELS[source] || (source === 'GoogleScholar' ? 'Google Scholar' : 'DBLP');
}

function getArticleBibTarget(article, source, preference = 'official') {
    if (source === 'DBLP' && preference === 'official' && getDblpVersionKind(article) !== 'preprint') {
        // Prefer the conference's open proceedings to a publisher DOI when the
        // same DBLP record supplies both (e.g. CVF and IEEE for a CVPR paper).
        const priority = ['CVF', 'BMVC', 'NeurIPS', 'PMLR', 'ACLAnthology', 'AAAI', 'IJCAI', 'KR', 'ECVA', 'Springer', 'OpenReview', 'ACM', 'IEEE'];
        const targets = (article.electronicEditions || []).map(getOfficialSource).filter(Boolean);
        targets.sort((a, b) => priority.indexOf(a.source) - priority.indexOf(b.source));
        if (targets.length) return targets[0];
    }
    return { source, cid: source === 'DBLP' ? article.url : article.id, origin: article.origin || '' };
}

function appendBibSource(container, target) {
    const label = document.createElement('div');
    label.className = 'obh-result-meta';
    label.textContent = `BibTeX: ${bibSourceLabel(target.source)}`;
    container.appendChild(label);
}

function buildSingleResultRow(article, source, bibPreference = 'official') {
    const target = getArticleBibTarget(article, source, bibPreference);
    const item = document.createElement("div");
    item.className = "obh-result";
    item.dataset.source = target.source;
    item.dataset.cid = target.cid;
    item.dataset.origin = target.origin || '';

    const main = document.createElement("div");
    main.className = "obh-result-main";

    const titleEl = document.createElement("div");
    titleEl.className = "obh-result-title";
    titleEl.textContent = article.title || "(No title)";

    const metaEl = document.createElement("div");
    metaEl.className = "obh-result-meta";
    metaEl.textContent = formatVersionMeta(article, source);

    const actions = document.createElement('div');
    actions.className = 'obh-result-actions';
    const action = document.createElement("button");
    action.type = 'button';
    action.dataset.obhAction = 'copy';
    action.className = "obh-result-action";
    action.textContent = target.source === 'ACM' ? 'Open ACM & copy' : 'Copy';
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'obh-result-action';
    preview.dataset.obhAction = 'preview';
    preview.textContent = target.source === 'ACM' ? 'Open ACM preview' : 'Preview';
    actions.append(action, preview);
    appendSourceLink(actions, article, target);

    main.appendChild(titleEl);
    main.appendChild(metaEl);
    appendBibSource(main, target);
    item.appendChild(main);
    item.appendChild(actions);
    return item;
}

function buildGroupedResultRow(group, bibPreference = 'official') {
    const target = getArticleBibTarget(group.best, group.source, bibPreference);
    const groupEl = document.createElement("div");
    groupEl.className = "obh-group";
    groupEl.dataset.bestSource = target.source;
    groupEl.dataset.bestCid = target.cid || '';
    groupEl.dataset.versionCount = String(group.versions.length);
    groupEl.dataset.origin = target.origin || '';

    const header = document.createElement("div");
    header.className = "obh-group-header";

    const main = document.createElement("div");
    main.className = "obh-result-main";

    const titleEl = document.createElement("div");
    titleEl.className = "obh-result-title";
    titleEl.textContent = group.title || "(No title)";

    const metaEl = document.createElement("div");
    metaEl.className = "obh-result-meta";
    metaEl.textContent = group.best ? formatVersionMeta(group.best, group.source) : '';

    main.appendChild(titleEl);
    main.appendChild(metaEl);
    appendBibSource(main, target);

    const actions = document.createElement("div");
    actions.className = "obh-group-actions";

    const copyBest = document.createElement("button");
    copyBest.type = 'button';
    copyBest.className = "obh-result-action";
    copyBest.textContent = target.source === 'ACM' ? 'Open ACM & copy' : 'Copy best';
    copyBest.setAttribute("data-obh-action", "copy-best");

    const toggle = document.createElement("button");
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.className = "obh-result-action";
    toggle.textContent = `Versions (${group.versions.length})`;
    toggle.setAttribute("data-obh-action", "toggle-versions");

    actions.appendChild(copyBest);
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'obh-result-action';
    preview.dataset.obhAction = 'preview';
    preview.textContent = target.source === 'ACM' ? 'Open ACM preview' : 'Preview';
    actions.appendChild(preview);
    actions.appendChild(toggle);
    appendSourceLink(actions, group.best, target);

    header.appendChild(main);
    header.appendChild(actions);
    groupEl.appendChild(header);

    const versions = document.createElement("div");
    versions.className = "obh-versions";
    for (const version of group.versions) {
        versions.appendChild(buildSingleResultRow(version, group.source, bibPreference));
    }
    groupEl.appendChild(versions);
    return groupEl;
}

function renderSearchResults(contentEl, groups, bibPreference = 'official') {
    contentEl.replaceChildren();
    for (const group of groups) {
        if (group.versions.length <= 1) {
            contentEl.appendChild(buildSingleResultRow(group.versions[0], group.source, bibPreference));
        } else {
            contentEl.appendChild(buildGroupedResultRow(group, bibPreference));
        }
    }
}

function appendSourceLink(container, article, target) {
    const raw = Object.hasOwn(OFFICIAL_BIB_LABELS, target.source) ? target.cid : article.url;
    if (!raw) return;
    try {
        const url = new URL(raw);
        if (!['https:', 'http:'].includes(url.protocol)) return;
        const link = document.createElement('a');
        link.className = 'obh-result-action';
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Source';
        container.appendChild(link);
    } catch { /* Some Scholar citation-only records have no source link. */ }
}

function sanitizeYearInput(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    const match = raw.match(/\d{4}/);
    if (!match) return '';
    return match[0];
}

function parseYearInput(value) {
    const sanitized = sanitizeYearInput(value);
    if (!sanitized) return null;
    const year = Number.parseInt(sanitized, 10);
    return Number.isFinite(year) ? year : null;
}

function parseArticleYear(value) {
    const year = Number.parseInt(String(value ?? '').trim(), 10);
    return Number.isFinite(year) ? year : null;
}

function filterByYearRange(items, yearFrom, yearTo) {
    if (!yearFrom && !yearTo) return items;
    const from = yearFrom ?? -Infinity;
    const to = yearTo ?? Infinity;
    const low = Math.min(from, to);
    const high = Math.max(from, to);
    return items.filter(item => {
        const year = parseArticleYear(item?.year);
        if (!year) return false;
        return year >= low && year <= high;
    });
}

function sortDblpArticles(items, sortMode) {
    if (sortMode !== 'newest' && sortMode !== 'oldest') return items;
    const desc = sortMode === 'newest';
    return items
        .map((article, index) => ({ article, index, year: parseArticleYear(article?.year) }))
        .sort((a, b) => {
            if (a.year == null && b.year == null) return a.index - b.index;
            if (a.year == null) return 1;
            if (b.year == null) return -1;
            if (a.year !== b.year) return desc ? (b.year - a.year) : (a.year - b.year);
            return a.index - b.index;
        })
        .map(entry => entry.article);
}

function getDblpVersionKind(article) {
    const url = String(article?.url ?? '').toLowerCase();
    const venue = String(article?.venue ?? '').toLowerCase();
    const type = String(article?.type ?? '').toLowerCase();

    if (url.includes('/journals/corr/') || venue === 'corr') return 'preprint';
    if (venue.includes('arxiv')) return 'preprint';
    if (type.includes('informal')) return 'preprint';
    return 'published';
}

// DBLP Functions
const dblpOrigin = "https://dblp.org";

// All providers share bounded requests. Verification stays an explicit UI action.
function requestText(url, { timeout = 20000, verificationUrl = '', provider = 'Google Scholar', withURL = false, validateURL, method = 'GET', headers, data } = {}) {
    return new Promise((resolve, reject) => {
        const fail = (message, needsVerification = false, status = null) => {
            const error = new Error(message);
            error.requestUrl = url;
            if (status != null) error.httpStatus = status;
            if (needsVerification && verificationUrl) error.verificationUrl = verificationUrl;
            reject(error);
        };
        try {
            GM_xmlhttpRequest({
                url,
                method,
                ...(headers ? { headers } : {}),
                ...(data != null ? { data } : {}),
                timeout,
                onload: response => {
                    const status = Number(response.status);
                    const text = String(response.responseText ?? '');
                    const needsVerification = Boolean(verificationUrl) &&
                        (status === 403 || status === 418 || status === 429 || isLikelyScholarVerificationPage(text) ||
                            /id=["']anubis_challenge|id=["']challenge-form|cf-chl-/i.test(text));
                    if (needsVerification) {
                        fail(provider + ' requires verification or is limiting requests. Open the verification page, then retry.', true, status);
                        return;
                    }
                    if (!Number.isFinite(status) || status < 200 || status >= 300) {
                        fail('Request failed (HTTP ' + (Number.isFinite(status) ? status : 'unknown') + ').', false, status);
                        return;
                    }
                    const finalURL = response.finalUrl || url;
                    if (validateURL && !validateURL(finalURL)) {
                        fail(provider + ' redirected to an unexpected page. Open the source page or use DBLP BibTeX.');
                        return;
                    }
                    resolve(withURL ? { text, url: finalURL } : text);
                },
                ontimeout: () => fail('Request timed out. Please retry or choose another source.'),
                onabort: () => fail('Request was cancelled.'),
                onerror: () => fail('Network request failed. Check your connection or choose another source.')
            });
        } catch (error) {
            reject(error);
        }
    });
}

// Offsets refer to the trimmed bib string, so key edits preserve every other byte.
// Auxiliary records and percent comments are never treated as citation entries.
function parseBibTeXRecords(text) {
    const bib = String(text ?? '').trim();
    let cursor = 0;
    const records = [];
    const invalid = () => new Error('The source did not return a complete BibTeX entry.');
    const skipTrivia = () => {
        while (cursor < bib.length) {
            if (/\s/.test(bib[cursor])) {
                cursor++;
            } else if (bib[cursor] === '%') {
                const newline = bib.indexOf('\n', cursor);
                cursor = newline === -1 ? bib.length : newline + 1;
            } else {
                break;
            }
        }
    };

    skipTrivia();
    while (cursor < bib.length) {
        const recordStart = cursor;
        const header = /^@([a-z][a-z0-9_-]*)\s*([{(])/i.exec(bib.slice(cursor));
        if (!header) throw invalid();
        const type = header[1].toLowerCase();
        const opening = header[2];
        const bodyStart = cursor + header[0].length;
        cursor = bodyStart;
        let depth = 1;
        let braceDepth = 0;
        let quoted = false;
        let escaped = false;

        for (; cursor < bib.length; cursor++) {
            const char = bib[cursor];
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }
            if (opening === '{') {
                if (char === '"' && depth === 1 && type !== 'comment') quoted = !quoted;
                if (char === '{') depth++;
                if (char === '}') depth--;
            } else {
                if (char === '{') braceDepth++;
                if (char === '}') {
                    braceDepth--;
                    if (braceDepth < 0) throw invalid();
                }
                if (char === '"' && braceDepth === 0 && type !== 'comment') quoted = !quoted;
                if (!quoted && braceDepth === 0) {
                    if (char === '(') depth++;
                    if (char === ')') depth--;
                }
            }
            if (depth === 0) break;
        }

        if (depth !== 0 || braceDepth !== 0 || quoted || escaped) throw invalid();
        const body = bib.slice(bodyStart, cursor);
        if (!['comment', 'preamble', 'string'].includes(type)) {
            const keyMatch = /^\s*([^,\s{}()]+)\s*,/.exec(body);
            if (!keyMatch || !/\b[a-z][a-z0-9_-]*\s*=/i.test(body.slice(keyMatch[0].length))) throw invalid();
            const key = keyMatch[1];
            const keyStart = bodyStart + keyMatch[0].indexOf(key);
            records.push({ type, key, keyStart, keyEnd: keyStart + key.length, start: recordStart, end: cursor + 1 });
        }
        cursor++;
        skipTrivia();
    }
    if (!records.length) throw invalid();
    return { bib, records };
}

// Reject HTML/error responses and incomplete records before caching or copying.
function validateBibTeX(text) {
    return parseBibTeXRecords(text).bib;
}

async function getArticleIDListDBLP(query, resultCount) {
    // Filter and group a bounded candidate set before the UI applies its result limit.
    const requested = Number.parseInt(resultCount, 10) || 5;
    const candidateCount = Math.max(40, Math.min(200, requested * 4));
    const url = dblpOrigin + '/search/publ/api?q=' + encodeURIComponent(query) + '&h=' + candidateCount;
    const xml = await requestText(url, { verificationUrl: url, provider: 'DBLP' });
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    if (doc.querySelector('parsererror') || doc.documentElement?.localName !== 'result' || !doc.querySelector('hits')) {
        throw new Error('DBLP returned an invalid search response. Please retry.');
    }

    const articles = [];
    for (const hit of doc.querySelectorAll('hit')) {
        const info = hit.querySelector('info');
        if (!info) throw new Error('DBLP returned an incomplete publication record.');
        const title = info.querySelector('title')?.textContent?.trim() ?? '';
        const publicationURL = info.querySelector('url')?.textContent?.trim() ?? '';
        if (!title || !getBibTexURLDBLP(publicationURL)) continue;
        articles.push({
            url: publicationURL,
            title,
            author: Array.from(info.querySelectorAll('author')).map(author => author.textContent?.trim() ?? '').filter(Boolean).join(', '),
            venue: info.querySelector('venue')?.textContent?.trim() ?? '',
            year: info.querySelector('year')?.textContent?.trim() ?? '',
            type: info.querySelector('type')?.textContent?.trim() ?? '',
            electronicEditions: Array.from(info.querySelectorAll('ee')).map(ee => ee.textContent?.trim() ?? '').filter(Boolean)
        });
    }
    return articles;
}

function getBibTexURLDBLP(publicationURL) {
    try {
        const url = new URL(String(publicationURL ?? ''), dblpOrigin);
        if (!/^https?:$/.test(url.protocol) || !/^(?:www\.)?dblp\.(?:org|uni-trier\.de)$/i.test(url.hostname)) return null;
        const record = url.pathname.match(/^\/rec\/(.+?)(?:\.(?:html|bib))?$/i)?.[1];
        if (!record || record.endsWith('/')) return null;
        return dblpOrigin + '/rec/' + record + '.bib';
    } catch {
        return null;
    }
}

async function getBibTexDBLP(publicationURL) {
    const bibtexURL = getBibTexURLDBLP(publicationURL);
    if (!bibtexURL) throw new Error('Invalid DBLP publication URL.');
    return validateBibTeX(await requestText(bibtexURL, { verificationUrl: bibtexURL, provider: 'DBLP' }));
}

// DBLP supplies discovery and the publication's electronic-edition links. These
// adapters read the original official export; they never synthesize a citation.
function officialURL(raw) {
    try {
        const url = new URL(raw);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
        url.protocol = 'https:';
        return url;
    } catch { return null; }
}

function isNeuripsHost(host) {
    return ['proceedings.neurips.cc', 'papers.nips.cc', 'proceedings.nips.cc', 'papers.neurips.cc'].includes(host);
}

function normalizeDOI(value) {
    let raw = String(value ?? '').trim().replace(/[{}]/g, '').replace(/\\_/g, '_');
    const url = officialURL(raw);
    if (url) {
        if (!['doi.org', 'dx.doi.org'].includes(url.hostname)) return '';
        try { raw = decodeURIComponent(url.pathname.slice(1)); } catch { return ''; }
    }
    if (!/^10\.\d{4,9}\/[A-Za-z\d._;()/:+-]+$/.test(raw) || raw.split('/').some(part => part === '.' || part === '..')) return '';
    return raw;
}

function sourceFromDOI(doi) {
    if (/^10\.(?:1145|5555)\//i.test(doi)) return { source: 'ACM', cid: 'https://dl.acm.org/doi/' + doi };
    if (/^10\.1007\//i.test(doi)) return { source: 'Springer', cid: 'https://link.springer.com/chapter/' + doi };
    if (/^10\.1109\//i.test(doi)) return { source: 'IEEE', cid: 'https://doi.org/' + doi };
    const ijcai = /^10\.24963\/(ijcai|kr)\.(20\d{2})\/(\d+)$/i.exec(doi);
    if (ijcai && Number(ijcai[3]) > 0) {
        const [, venue, year, number] = ijcai;
        if (venue.toLowerCase() === 'kr') return { source: 'KR', cid: `https://proceedings.kr.org/${year}/${Number(number)}/` };
        if (Number(year) >= 2017) return { source: 'IJCAI', cid: `https://www.ijcai.org/proceedings/${year}/${Number(number)}` };
    }
    const aaai = /^10\.1609\/([a-z]+)\.v\d+i\d+\.(\d+)$/i.exec(doi);
    if (aaai && Object.hasOwn(AAAI_JOURNALS, aaai[1].toLowerCase())) {
        return { source: 'AAAI', cid: `https://ojs.aaai.org/index.php/${AAAI_JOURNALS[aaai[1].toLowerCase()]}/article/view/${Number(aaai[2])}` };
    }
    if (/^10\.18653\/v1\//i.test(doi)) return getOfficialSource('https://aclanthology.org/' + doi.split('/').slice(2).join('/') + '/');
    return null;
}

function ieeeArticleID(url) {
    if (url?.hostname !== 'ieeexplore.ieee.org') return '';
    const pathID = /^\/(?:abstract\/)?document\/(\d+)\/?$/.exec(url.pathname)?.[1];
    const queryID = /^\/(?:xpl|xpls|stamp)\//.test(url.pathname) ? url.searchParams.get('arnumber') : '';
    return /^\d+$/.test(pathID || queryID || '') ? pathID || queryID : '';
}

function getOfficialSource(rawURL) {
    const bmvc = getBMVCSource(rawURL);
    if (bmvc) return bmvc;
    const doi = normalizeDOI(rawURL);
    if (doi) return sourceFromDOI(doi);
    const url = officialURL(rawURL);
    if (!url) return null;
    if (url.hostname === 'dl.acm.org') {
        const acmDOI = normalizeDOI(url.pathname.replace(/^\/doi\/(?:abs\/|full\/|pdf\/|epdf\/)?/, ''));
        if (/^10\.(?:1145|5555)\//i.test(acmDOI)) return sourceFromDOI(acmDOI);
    }
    if (['openaccess.thecvf.com', 'www.openaccess.thecvf.com'].includes(url.hostname)) {
        const path = url.pathname.replace('/papers/', '/html/').replace(/_paper\.pdf$/, '_paper.html');
        if (/^\/(?:content\/[^/]+(?:\/[^/]+)?|content_[A-Za-z\d_]+)\/html\/(?:w\d+\/)?[^/]+_paper\.html$/.test(path)) {
            return { source: 'CVF', cid: 'https://openaccess.thecvf.com' + path };
        }
    }
    if (['ecva.net', 'www.ecva.net'].includes(url.hostname) && /^\/papers\/eccv_\d{4}\/papers_ECCV\/html\/[^/]+_paper\.php$/.test(url.pathname)) {
        return { source: 'ECVA', cid: 'https://www.ecva.net' + url.pathname };
    }
    if (['link.springer.com', 'link.springernature.com'].includes(url.hostname)) {
        const springerDOI = normalizeDOI(url.pathname.replace(/^\/(?:chapter\/|article\/|book\/)?/, ''));
        if (/^10\.1007\//i.test(springerDOI)) return sourceFromDOI(springerDOI);
    }
    if (['ijcai.org', 'www.ijcai.org'].includes(url.hostname)) {
        const match = /^\/proceedings\/(20\d{2})\/(?:bibtex\/)?(\d+)(?:\.pdf)?\/?$/.exec(url.pathname);
        if (match) return sourceFromDOI(`10.24963/ijcai.${match[1]}/${match[2]}`);
    }
    if (url.hostname === 'proceedings.kr.org') {
        const match = /^\/(20\d{2})\/(\d+)(?:\/bibtex)?\/?$/.exec(url.pathname) || /^\/(20\d{2})\/bibtex\/(\d+)\/?$/.exec(url.pathname);
        if (match) return sourceFromDOI(`10.24963/kr.${match[1]}/${match[2]}`);
    }
    if (url.hostname === 'ojs.aaai.org') {
        const match = /^\/index\.php\/([A-Za-z\d-]+)\/article\/(?:view|download)\/(\d+)(?:\/\d+)*\/?$/.exec(url.pathname);
        if (match) return { source: 'AAAI', cid: `https://ojs.aaai.org/index.php/${match[1]}/article/view/${Number(match[2])}` };
    }
    if (['aaai.org', 'www.aaai.org'].includes(url.hostname) && (
        /^\/ocs\/index\.php\/[^/]+\/[^/]+\/paper\/view\/\d+\/?$/.test(url.pathname) ||
        /^\/papers\/[^/]+\/?$/.test(url.pathname)
    )) return { source: 'AAAI', cid: 'https://aaai.org' + url.pathname };
    const ieeeID = ieeeArticleID(url);
    if (ieeeID) return { source: 'IEEE', cid: `https://ieeexplore.ieee.org/document/${ieeeID}/` };
    if (isNeuripsHost(url.hostname)) {
        const path = url.pathname.replace(/^\/paper\/(\d{4})\//, '/paper_files/paper/$1/');
        if (/^\/paper_files\/paper\/\d{4}\/hash\/[a-f\d]{32}-Abstract(?:-[A-Za-z_]+)?\.html$/.test(path) ||
            /^\/paper\/(?:\d+-[A-Za-z\d_-]+)\/?$/.test(path)) {
            return { source: 'NeurIPS', cid: 'https://proceedings.neurips.cc' + path };
        }
    }
    if (url.hostname === 'proceedings.mlr.press' && /^\/v\d+\/[a-z\d_-]+\.html$/i.test(url.pathname)) {
        return { source: 'PMLR', cid: 'https://proceedings.mlr.press' + url.pathname };
    }
    let anthologyID = '';
    if (url.hostname === 'aclanthology.org') {
        anthologyID = url.pathname.replace(/^\//, '').replace(/\/$|\.(?:bib|pdf)$/, '');
    } else if (['aclweb.org', 'www.aclweb.org'].includes(url.hostname) && url.pathname.startsWith('/anthology/')) {
        anthologyID = url.pathname.slice('/anthology/'.length).replace(/\/$|\.(?:bib|pdf)$/, '');
    } else if (['doi.org', 'dx.doi.org'].includes(url.hostname) && url.pathname.startsWith('/10.18653/v1/')) {
        anthologyID = url.pathname.slice('/10.18653/v1/'.length);
    }
    if (/^(?:[A-Z]\d{2}-\d{4,5}|\d{4}\.[a-z\d-]+\.\d+)$/i.test(anthologyID)) {
        if (/^[a-z]\d{2}-/i.test(anthologyID)) anthologyID = anthologyID[0].toUpperCase() + anthologyID.slice(1);
        return { source: 'ACLAnthology', cid: 'https://aclanthology.org/' + anthologyID + '/' };
    }
    if (url.hostname === 'openreview.net' && /^\/(?:forum|pdf)\/?$/.test(url.pathname)) {
        const id = url.searchParams.get('id') || '';
        if (/^[A-Za-z\d_-]{1,128}$/.test(id)) return { source: 'OpenReview', cid: 'https://openreview.net/forum?id=' + encodeURIComponent(id) };
    }
    return null;
}

function neuripsPaperIdentity(rawURL) {
    const url = officialURL(rawURL);
    if (!url || !isNeuripsHost(url.hostname)) return '';
    return url.pathname.match(/\/paper\/(\d{4})\/(?:hash|file)\/([a-f\d]{32})-/)?.slice(1).join('/') || '';
}

function isNeuripsBibURL(rawURL) {
    const url = officialURL(rawURL);
    return Boolean(url && isNeuripsHost(url.hostname) && (
        /^\/(?:paper_files\/)?paper\/\d{4}\/file\/[a-f\d]{32}-Bibtex(?:-[A-Za-z_]+)?\.bib$/.test(url.pathname) ||
        /^\/paper_files\/paper\/\d+-\/bibtex$/.test(url.pathname)
    ));
}

function validateOfficialBib(text) {
    const parsed = parseBibTeXRecords(text);
    if (parsed.records.length !== 1) throw new Error('The official source did not return exactly one BibTeX entry.');
    return parsed.bib;
}

// Read a top-level field without rewriting its TeX or mistaking text inside an
// abstract for a field. Used only to inspect the official publication status.
function readBibField(bib, name) {
    const { records } = parseBibTeXRecords(bib);
    const record = records[0];
    let cursor = record.keyEnd + 1;
    while (cursor < record.end - 1) {
        if (/[\s,]/.test(bib[cursor])) { cursor++; continue; }
        if (bib[cursor] === '%') {
            const next = bib.indexOf('\n', cursor);
            cursor = next < 0 ? record.end : next + 1;
            continue;
        }
        const field = /^([a-z][a-z\d_-]*)\s*=\s*/i.exec(bib.slice(cursor));
        if (!field) return '';
        cursor += field[0].length;
        const start = cursor;
        let depth = 0;
        let quoted = false;
        let escaped = false;
        for (; cursor < record.end - 1; cursor++) {
            const char = bib[cursor];
            if (escaped) { escaped = false; continue; }
            if (char === '\\') { escaped = true; continue; }
            if (char === '{') depth++;
            if (char === '}') depth--;
            if (char === '"' && depth === 0) quoted = !quoted;
            if (char === ',' && depth === 0 && !quoted) break;
        }
        if (field[1].toLowerCase() === name.toLowerCase()) {
            return bib.slice(start, cursor).trim().replace(/^[{"]|[}"]$/g, '');
        }
    }
    return '';
}

function validatePublisherBib(text, { doi = '', doiKey = false, requireAuthor = false } = {}) {
    const bib = validateOfficialBib(text);
    const present = field => readBibField(bib, field).replace(/[{}\s]/g, '');
    if (!present('title') || !(present('author') || !requireAuthor && present('editor'))) {
        throw new Error('The official export is missing its title or authors.');
    }
    if (doi) {
        const rawDOI = readBibField(bib, 'doi').trim();
        const explicit = normalizeDOI(rawDOI);
        if (rawDOI && !explicit) throw new Error('The official export contains an invalid DOI.');
        const key = doiKey ? normalizeDOI(parseBibTeXRecords(bib).records[0].key) : '';
        const actual = explicit || key;
        if (!actual || actual.toLowerCase() !== doi.toLowerCase()) {
            throw new Error('The official BibTeX DOI does not match this paper.');
        }
    }
    return bib;
}

function parseOfficialHTML(text) {
    return new DOMParser().parseFromString(text, 'text/html');
}

function singleBibBlock(doc, selector) {
    const blocks = Array.from(doc.querySelectorAll(selector));
    if (blocks.length !== 1) throw new Error('The official page did not provide exactly one BibTeX export.');
    return blocks[0].value ?? blocks[0].textContent;
}

async function fetchOfficialPage(target) {
    return requestText(target.cid, {
        provider: bibSourceLabel(target.source), verificationUrl: target.cid, withURL: true,
        validateURL: final => getOfficialSource(final)?.cid === target.cid,
    });
}

async function getBibTexSpringer(cid) {
    const doi = normalizeDOI(new URL(cid).pathname.slice('/chapter/'.length));
    const exportURL = 'https://citation-needed.springer.com/v2/references/' + doi + '?format=bibtex&flavour=citation';
    const bib = await requestText(exportURL, {
        provider: 'Springer Nature', verificationUrl: cid,
        validateURL: final => {
            const url = officialURL(final);
            return url?.hostname === 'citation-needed.springer.com' &&
                normalizeDOI(url.pathname.slice('/v2/references/'.length)).toLowerCase() === doi.toLowerCase() &&
                url.pathname.startsWith('/v2/references/') && url.searchParams.get('format') === 'bibtex';
        },
    });
    // Springer uses the DOI as the official citation key and may omit a DOI field.
    return validatePublisherBib(bib, { doi, doiKey: true });
}

function getBMVCSource(rawURL) {
    const archivedPaper = (year, number) => ({
        source: 'BMVC',
        cid: `https://www.bmva-archive.org.uk/bmvc/${year}/papers/paper${String(Number(number)).padStart(3, '0')}/index.html`,
    });
    const modernPaper = (year, number) => {
        const base = {
            2023: 'https://proceedings.bmvc2023.org/',
            2024: 'https://bmvc2024.org/proceedings/',
            2025: 'https://bmvc2025.bmva.org/proceedings/',
        }[year];
        return { source: 'BMVC', cid: base + Number(number) + '/' };
    };
    // Only these archived main proceedings have verified single-record exports.
    const doi = /^10\.5244\/C\.(29|30|31)\.(\d{1,3})$/i.exec(normalizeDOI(rawURL));
    if (doi && Number(doi[2]) > 0) return archivedPaper(Number(doi[1]) + 1986, doi[2]);
    const url = officialURL(rawURL);
    if (!url) return null;
    const modernSources = {
        'proceedings.bmvc2023.org': { year: 2023, path: /^\/(\d{1,6})\/?$/ },
        'bmvc2024.org': { year: 2024, path: /^\/proceedings\/(\d{1,6})\/?$/ },
        'bmvc2025.bmva.org': { year: 2025, path: /^\/proceedings\/(\d{1,6})\/?$/ },
    };
    const modern = Object.hasOwn(modernSources, url.hostname) ? modernSources[url.hostname] : null;
    const number = modern?.path.exec(url.pathname)?.[1];
    if (number && Number(number) > 0) return modernPaper(modern.year, number);
    const pdfYear = url.hostname === 'papers.bmvc2023.org' ? 2023 : url.hostname === 'papers.bmvc2024.org' ? 2024 : 0;
    const pdf = /^\/(\d{1,6})\.pdf$/.exec(url.pathname);
    if (pdfYear && pdf && Number(pdf[1]) > 0) return modernPaper(pdfYear, pdf[1]);
    const archiveHost = ['bmva-archive.org.uk', 'www.bmva-archive.org.uk'].includes(url.hostname);
    if (archiveHost) {
        // The 2024 and 2025 paper archives use different directory layouts.
        const recent = /^\/bmvc\/(2024)\/papers\/Paper_(\d{1,6})\/paper\.pdf$/.exec(url.pathname) ||
            /^\/bmvc\/(2025)\/assets\/papers\/Paper_(\d{1,6})\/paper\.pdf$/.exec(url.pathname);
        if (recent && Number(recent[2]) > 0) return modernPaper(recent[1], recent[2]);
    }
    if (archiveHost || ['bmva.org', 'www.bmva.org'].includes(url.hostname)) {
        // Old bmva.org paper pages now contain a JavaScript redirect to this archive.
        const old = /^\/bmvc\/(201[5-7])\/papers\/paper(\d{3})\/(?:index\.html|paper(\d{3})\.pdf)$/.exec(url.pathname);
        if (old && Number(old[2]) > 0 && (!old[3] || old[3] === old[2])) return archivedPaper(old[1], old[2]);
    }
    return null;
}

async function getBibTexBMVC(target) {
    const page = await fetchOfficialPage(target);
    const bib = validatePublisherBib(singleBibBlock(parseOfficialHTML(page.text), 'pre.highlight > code, pre.citation'));
    const archived = /^\/bmvc\/(201[5-7])\/papers\/paper(\d{3})\/index\.html$/.exec(new URL(target.cid).pathname);
    if (archived) return validatePublisherBib(bib, { doi: `10.5244/C.${Number(archived[1]) - 1986}.${Number(archived[2])}` });
    if (getBMVCSource(readBibField(bib, 'url'))?.cid !== target.cid) {
        throw new Error('The official BMVC BibTeX URL does not match this paper.');
    }
    return bib;
}

async function getBibTexECVA(target) {
    const page = await fetchOfficialPage(target);
    const doc = parseOfficialHTML(page.text);
    const links = Array.from(doc.querySelectorAll('a[href]')).map(a => getOfficialSource(new URL(a.getAttribute('href'), page.url).href));
    const editions = [...new Set(links.filter(link => link?.source === 'Springer').map(link => link.cid))];
    if (editions.length !== 1) throw new Error('ECVA did not identify a unique Springer chapter for this paper.');
    return getBibTexSpringer(editions[0]);
}

async function getBibTexIJCAI(target) {
    const [, year, number] = /^\/proceedings\/(\d{4})\/(\d+)$/.exec(new URL(target.cid).pathname);
    const doi = `10.24963/ijcai.${year}/${number}`;
    const exportURL = `https://www.ijcai.org/proceedings/${year}/bibtex/${number}`;
    const bib = await requestText(exportURL, {
        provider: 'IJCAI', verificationUrl: target.cid,
        validateURL: final => getOfficialSource(final)?.cid === target.cid && new URL(final).pathname.includes('/bibtex/'),
    });
    // Invalid paper IDs can return HTTP 200 with an empty, syntactically valid template.
    return validatePublisherBib(bib, { doi, requireAuthor: true });
}

async function getBibTexKR(target) {
    const page = await fetchOfficialPage(target);
    const doc = parseOfficialHTML(page.text);
    const link = Array.from(doc.querySelectorAll('a[href]')).find(a => /^bibtex$/i.test(a.textContent.trim()));
    if (!link) throw new Error('KR did not provide a BibTeX export for this paper.');
    const exportURL = new URL(link.getAttribute('href'), page.url).href;
    const isExport = raw => getOfficialSource(raw)?.cid === target.cid && new URL(raw).pathname.includes('/bibtex');
    if (!isExport(exportURL)) throw new Error('KR linked to an unexpected BibTeX export.');
    const text = await requestText(exportURL, { provider: 'KR', verificationUrl: target.cid, validateURL: isExport });
    const bib = /^\s*@/.test(text) ? text : singleBibBlock(parseOfficialHTML(text), 'pre');
    const [, year, number] = /^\/(\d{4})\/(\d+)\/$/.exec(new URL(target.cid).pathname);
    return validatePublisherBib(bib, { doi: `10.24963/kr.${year}/${number}` });
}

async function getBibTexAAAI(initialTarget) {
    let target = initialTarget;
    if (new URL(target.cid).hostname !== 'ojs.aaai.org') {
        // Old OCS IDs changed during migration. Resolve the actual official DOI.
        const oldPage = await requestText(target.cid, {
            provider: 'AAAI', verificationUrl: target.cid, withURL: true,
            validateURL: final => ['aaai.org', 'www.aaai.org', 'ojs.aaai.org'].includes(officialURL(final)?.hostname),
        });
        const doc = parseOfficialHTML(oldPage.text);
        const doi = doc.querySelector('meta[name="citation_doi" i]')?.content ||
            Array.from(doc.querySelectorAll('a[href]')).map(a => normalizeDOI(a.getAttribute('href'))).find(value => /^10\.1609\//i.test(value)) ||
            Array.from(doc.querySelectorAll('.paper-section-wrap')).find(section => /^DOI\s*:/i.test(section.querySelector('h4')?.textContent.trim() || ''))?.querySelector('.attribute-output')?.textContent.trim();
        const resolved = sourceFromDOI(normalizeDOI(doi));
        if (!resolved || resolved.source !== 'AAAI') throw new Error('The legacy AAAI page did not identify its current official citation.');
        target = resolved;
    }
    const page = await fetchOfficialPage(target);
    const doc = parseOfficialHTML(page.text);
    const [, journal, articleID] = /^\/index\.php\/([^/]+)\/article\/view\/(\d+)$/.exec(new URL(target.cid).pathname);
    const doi = normalizeDOI(doc.querySelector('meta[name="citation_doi" i]')?.content);
    if (doi && sourceFromDOI(doi)?.cid !== target.cid) throw new Error('AAAI returned a different article DOI.');
    const link = doc.querySelector('a[href*="/citationstylelanguage/download/bibtex"]');
    if (!link) throw new Error('AAAI did not provide an original BibTeX export on this paper page.');
    const exportURL = new URL(link.getAttribute('href'), page.url);
    const validExport = raw => {
        const url = officialURL(raw);
        return url?.hostname === 'ojs.aaai.org' && url.pathname === `/index.php/${journal}/citationstylelanguage/download/bibtex` &&
            url.searchParams.getAll('submissionId').length === 1 && url.searchParams.get('submissionId') === articleID &&
            url.searchParams.getAll('publicationId').length <= 1 &&
            (!url.searchParams.has('publicationId') || /^\d+$/.test(url.searchParams.get('publicationId'))) &&
            url.searchParams.get('publicationId') === exportURL.searchParams.get('publicationId');
    };
    if (!validExport(exportURL.href)) throw new Error('AAAI linked to a different article’s BibTeX.');
    const bib = validatePublisherBib(await requestText(exportURL.href, {
        provider: 'AAAI', verificationUrl: target.cid, validateURL: validExport,
    }), { doi });
    if (!doi && sourceFromDOI(normalizeDOI(readBibField(bib, 'doi')))?.cid !== target.cid) {
        throw new Error('The AAAI export could not be matched to this paper.');
    }
    return bib;
}

async function getBibTexIEEE(target) {
    let cid = target.cid;
    const expectedDOI = normalizeDOI(cid);
    if (expectedDOI) {
        const response = await requestText(cid, {
            provider: 'IEEE Xplore', verificationUrl: cid, withURL: true,
            validateURL: final => Boolean(ieeeArticleID(officialURL(final))),
        });
        cid = getOfficialSource(response.url).cid;
    }
    const articleID = ieeeArticleID(new URL(cid));
    const exportURL = 'https://ieeexplore.ieee.org/xpl/downloadCitations?legacy=true';
    // The publisher's download form accepts a single record ID and BibTeX format.
    const text = await requestText(exportURL, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: new URLSearchParams({ recordIds: articleID, 'citations-format': 'citation-only', 'download-format': 'download-bibtex' }).toString(),
        provider: 'IEEE Xplore', verificationUrl: cid,
        validateURL: final => officialURL(final)?.href === exportURL,
    });
    const bib = validatePublisherBib(text, { doi: expectedDOI });
    if (!expectedDOI && parseBibTeXRecords(bib).records[0].key !== articleID) {
        throw new Error('The IEEE export could not be matched to this paper.');
    }
    return bib;
}

function validateACMBib(text, cid) {
    const doi = normalizeDOI(new URL(cid).pathname.slice('/doi/'.length));
    const bib = validatePublisherBib(text);
    // ACM's 10.5555 records are internal identifiers. The official AAMAS
    // export omits DOI/URL and uses the identifier suffix as its citation key.
    if (doi.startsWith('10.5555/') && !readBibField(bib, 'doi').trim()) {
        const key = parseBibTeXRecords(bib).records[0].key;
        if (key !== doi && key !== doi.slice('10.5555/'.length)) {
            throw new Error('The official ACM citation identifier does not match this paper.');
        }
        return bib;
    }
    return validatePublisherBib(bib, { doi });
}

function getBibTexACM(cid) {
    // ACM generates its export in the official citation dialog. Reuse that
    // renderer in a temporary publisher tab instead of rebuilding CSL fields.
    return new Promise((resolve, reject) => {
        const token = crypto.randomUUID().replace(/-/g, '');
        const requestKey = 'obh-acm-request:' + token;
        const resultKey = 'obh-acm-result:' + token;
        let listener;
        let timer;
        let tab;
        let settled = false;
        const finish = (error, bib) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(bib);
            // A publisher tab may already be closed. Cleanup must never strand
            // the citation Promise after its result has been validated.
            try { if (listener != null) GM_removeValueChangeListener(listener); } catch { /* Already removed. */ }
            try { GM_deleteValue(requestKey); GM_deleteValue(resultKey); } catch { /* Requests expire independently. */ }
            if (!error) {
                try { tab?.close?.(); } catch { /* The citation is still valid. */ }
            }
        };
        try {
            listener = GM_addValueChangeListener(resultKey, (_name, _old, result) => {
                if (!result || typeof result !== 'object') return;
                try {
                    if (result.cid !== cid) throw new Error('The ACM citation came from a different paper.');
                    if (result.error) throw new Error(result.error);
                    finish(null, validateACMBib(result.bib, cid));
                } catch (error) { finish(error); }
            });
            GM_setValue(requestKey, { cid, expiresAt: Date.now() + 90000 });
            timer = setTimeout(() => {
                const error = new Error('ACM preview did not finish. Complete any website verification, then retry or use DBLP.');
                error.verificationUrl = cid;
                finish(error);
            }, 90000);
            tab = GM_openInTab(cid + '#obh-acm=' + token, { active: true, insert: true });
            if (tab) tab.onclose = () => finish(new Error('The ACM tab was closed. Retry the citation or use DBLP.'));
        } catch (error) { finish(error); }
    });
}

function runACMCitationBridge() {
    // Inert on ordinary ACM visits. Only a live request from this userscript,
    // bound to the exact DOI and a random token, may activate the dialog.
    const token = /^#obh-acm=([a-f\d]{32})$/.exec(location.hash)?.[1];
    if (!token) return;
    const requestKey = 'obh-acm-request:' + token;
    const resultKey = 'obh-acm-result:' + token;
    const request = GM_getValue(requestKey, null);
    const target = getOfficialSource(location.href);
    if (!request || request.cid !== target?.cid || !Number.isFinite(request.expiresAt) ||
        request.expiresAt <= Date.now() || request.expiresAt > Date.now() + 95000) return;
    let lastTriggerAt = -Infinity;
    let formatChanged = false;
    const respond = result => GM_setValue(resultKey, { cid: request.cid, ...result });
    const poll = () => {
        if (!GM_getValue(requestKey, null) || Date.now() >= request.expiresAt) return;
        try {
            const dialog = document.querySelector('#exportCitation');
            // Publisher handlers may attach after the visible button. Retry
            // opening until the dialog appears, then leave its export alone.
            if (!isVisible(dialog) && Date.now() - lastTriggerAt >= 1500) {
                const button = document.querySelector('button[aria-label="Export Citation"], [data-target="#exportCitation"]');
                if (button && isVisible(button)) { lastTriggerAt = Date.now(); button.click(); }
            }
            const format = dialog?.querySelector('#citation-format');
            if (format && format.value !== 'bibtex' && !formatChanged) {
                formatChanged = true;
                format.value = 'bibtex';
                format.dispatchEvent(new Event('change', { bubbles: true }));
            }
            const content = dialog?.querySelector('input[name="content"]')?.value;
            const download = dialog?.querySelector('.download__btn');
            const ready = dialog && isVisible(dialog) && format?.value === 'bibtex' && content?.trim() &&
                download && !download.classList.contains('disabled') && !download.disabled;
            if (ready) {
                respond({ bib: validateACMBib(content, request.cid) });
                return;
            }
        } catch (error) {
            respond({ error: error.message || 'The ACM citation dialog could not be read.' });
            return;
        }
        setTimeout(poll, 300);
    };
    poll();
}

async function getBibTexOfficial(source, cid) {
    const target = getOfficialSource(cid);
    if (!target || target.source !== source) throw new Error('Invalid official publication URL.');
    const provider = bibSourceLabel(source);
    const requestOptions = { provider, verificationUrl: target.cid };
    if (source === 'CVF') {
        const page = await fetchOfficialPage(target);
        return validatePublisherBib(singleBibBlock(parseOfficialHTML(page.text), '.bibref'));
    }
    if (source === 'ECVA') return getBibTexECVA(target);
    if (source === 'BMVC') return getBibTexBMVC(target);
    if (source === 'Springer') return getBibTexSpringer(target.cid);
    if (source === 'AAAI') return getBibTexAAAI(target);
    if (source === 'IJCAI') return getBibTexIJCAI(target);
    if (source === 'KR') return getBibTexKR(target);
    if (source === 'IEEE') return getBibTexIEEE(target);
    if (source === 'ACM') return getBibTexACM(target.cid);
    if (source === 'OpenReview') return getBibTexOpenReview(target.cid);
    if (source === 'ACLAnthology') {
        const exportURL = target.cid.replace(/\/$/, '.bib');
        return validateOfficialBib(await requestText(exportURL, {
            ...requestOptions,
            validateURL: final => officialURL(final)?.href === exportURL,
        }));
    }

    const page = await requestText(target.cid, {
        ...requestOptions, withURL: true,
        validateURL: final => {
            const resolved = getOfficialSource(final);
            if (!resolved || resolved.source !== source) return false;
            if (source !== 'NeurIPS') return resolved.cid === target.cid;
            const expected = neuripsPaperIdentity(target.cid);
            return !expected || neuripsPaperIdentity(resolved.cid) === expected;
        },
    });
    const doc = new DOMParser().parseFromString(page.text, 'text/html');
    if (source === 'PMLR') {
        const bib = doc.querySelector('code#bibtex')?.textContent;
        if (!bib) throw new Error('PMLR did not provide a BibTeX export on this paper page.');
        return validateOfficialBib(bib);
    }

    const link = Array.from(doc.querySelectorAll('a[href]')).find(a => /^bibtex$/i.test(a.textContent.trim()));
    if (!link) throw new Error('NeurIPS did not provide a BibTeX link on this paper page.');
    const exportURL = new URL(link.getAttribute('href'), page.url).href;
    if (!isNeuripsBibURL(exportURL)) throw new Error('NeurIPS returned an unexpected BibTeX link.');
    const expected = neuripsPaperIdentity(page.url);
    const validateExport = final => {
        if (!isNeuripsBibURL(final)) return false;
        const actual = neuripsPaperIdentity(final);
        return actual ? actual === expected : final === exportURL;
    };
    if (!validateExport(exportURL)) throw new Error('NeurIPS linked to a different paper’s BibTeX.');
    return validateOfficialBib(await requestText(exportURL, { ...requestOptions, validateURL: validateExport }));
}

async function getBibTexOpenReview(forumURL) {
    const id = new URL(forumURL).searchParams.get('id');
    let note = null;
    for (const origin of ['https://api2.openreview.net', 'https://api.openreview.net']) {
        const apiURL = origin + '/notes?id=' + encodeURIComponent(id);
        let text;
        try {
            text = await requestText(apiURL, {
                provider: 'OpenReview', verificationUrl: forumURL,
                validateURL: final => officialURL(final)?.href === apiURL,
            });
        } catch (error) {
            // A v1 record can be absent in v2. Do not retry rate limits or verification errors.
            if (error.httpStatus === 404 && origin === 'https://api2.openreview.net') continue;
            throw error;
        }
        let data;
        try { data = JSON.parse(text); } catch { throw new Error('OpenReview returned an invalid note response.'); }
        if (!Array.isArray(data.notes)) throw new Error('OpenReview returned an invalid note response.');
        if (!data.notes.length) continue;
        note = data.notes.find(entry => entry.id === id);
        if (!note) throw new Error('OpenReview returned a different paper.');
        break;
    }
    if (!note) throw new Error('This paper was not found in OpenReview.');
    if (note.forum && note.forum !== id) throw new Error('OpenReview returned a discussion note instead of the paper.');
    const field = name => {
        const value = note.content?.[name];
        return typeof value === 'string' ? value : typeof value?.value === 'string' ? value.value : '';
    };
    const raw = field('_bibtex');
    if (!raw) throw new Error('OpenReview has no official BibTeX export for this paper.');
    const bib = validateOfficialBib(raw);
    // Legacy venueid alone also appeared on rejected notes. Check the actual
    // official citation and explicit status instead of treating every forum as accepted.
    const negative = /submitted|submission|under[\s_/-]*review|rejected|withdrawn|withdrawal|desk[\s_-]*reject/i;
    const booktitle = readBibField(bib, 'booktitle');
    const status = readBibField(bib, 'note');
    if (negative.test(field('venue') + ' ' + field('venueid')) ||
        negative.test((booktitle + ' ' + status).replace(/[{}]/g, '')) ||
        parseBibTeXRecords(bib).records[0].type !== 'inproceedings' || !booktitle.trim()) {
        throw new Error('OpenReview does not identify this citation as a published conference version.');
    }
    const citationURL = getOfficialSource(readBibField(bib, 'url').replace(/[{}]/g, '').replace(/\\&/g, '&'));
    if (citationURL?.source === 'OpenReview' && citationURL.cid !== forumURL) {
        throw new Error('OpenReview’s BibTeX points to a different paper.');
    }
    return bib;
}


// -----------------------------------------------------------------------------
// Project BibTeX library + interactive citation hover preview
// -----------------------------------------------------------------------------

function getOverleafProjectId() {
    const match = location.pathname.match(/\/project\/([^/]+)/);
    return match ? match[1] : 'default';
}

function citationStorageKey() {
    return CITATION_STORAGE_PREFIX + getOverleafProjectId();
}

function citationRawStorageKey() {
    return citationStorageKey() + CITATION_RAW_SUFFIX;
}

function loadCitationLibrary() {
    try {
        citationDatabase = JSON.parse(localStorage.getItem(citationStorageKey()) || '{}');
        if (!citationDatabase || typeof citationDatabase !== 'object' || Array.isArray(citationDatabase)) citationDatabase = {};
    } catch {
        citationDatabase = {};
    }
    citationRawBib = localStorage.getItem(citationRawStorageKey()) || '';
}

function persistCitationLibrary() {
    localStorage.setItem(citationStorageKey(), JSON.stringify(citationDatabase));
    localStorage.setItem(citationRawStorageKey(), citationRawBib);
}

function setToolTab(popup, tab, focus = true) {
    if (!popup) return;
    const selected = tab === 'library' ? 'library' : 'search';
    GM_setValue('ui.activeTab', selected);

    const searchTab = popup.querySelector('#obh-tab-search');
    const libraryTab = popup.querySelector('#obh-tab-library');
    const searchPanel = popup.querySelector('#obh-search-panel');
    const libraryPanel = popup.querySelector('#obh-library-panel');

    searchTab?.setAttribute('aria-selected', String(selected === 'search'));
    libraryTab?.setAttribute('aria-selected', String(selected === 'library'));
    if (searchPanel) searchPanel.hidden = selected !== 'search';
    if (libraryPanel) libraryPanel.hidden = selected !== 'library';

    if (selected === 'library') refreshCitationLibraryUI(popup);
    positionPopup();

    if (!focus || !showBox) return;
    if (selected === 'search') {
        const input = popup.querySelector('#obh-search-input');
        input?.focus();
        input?.select();
    } else {
        popup.querySelector('#obh-library-textarea')?.focus();
    }
}

function refreshCitationLibraryUI(root = document) {
    const area = root.querySelector('#obh-library-textarea');
    const count = root.querySelector('#obh-library-count');
    const project = root.querySelector('#obh-library-project');
    const status = root.querySelector('#obh-library-status');
    if (!area || !count) return;

    if (area.dataset.projectId !== getOverleafProjectId()) {
        area.value = citationRawBib;
        area.dataset.projectId = getOverleafProjectId();
    }

    const n = Object.keys(citationDatabase).length;
    count.textContent = `${n} entr${n === 1 ? 'y' : 'ies'}`;
    if (project) project.textContent = `Project ${getOverleafProjectId().slice(0, 8)}…`;
    if (status && !status.textContent) {
        setStatus(status, 'info', n
            ? `${n} saved citation entr${n === 1 ? 'y is' : 'ies are'} ready for hover previews.`
            : 'No project bibliography is saved yet.');
    }
}

function saveCitationLibraryFromUI(popup = document) {
    const area = popup.querySelector('#obh-library-textarea');
    const status = popup.querySelector('#obh-library-status');
    const raw = area?.value.trim() ?? '';
    if (!raw) {
        setStatus(status, 'error', 'Paste your BibTeX file first.');
        return;
    }

    try {
        const parsed = parseCitationBibliography(raw);
        const n = Object.keys(parsed).length;
        if (!n) throw new Error('No citation entries were found.');
        citationDatabase = parsed;
        citationRawBib = raw;
        persistCitationLibrary();
        refreshCitationLibraryUI(popup);
        setStatus(status, 'success', `Saved ${n} citation entr${n === 1 ? 'y' : 'ies'} for this project.`);
    } catch (error) {
        setStatus(status, 'error', error?.message || 'Could not parse the BibTeX file.');
    }
}

function clearCitationLibraryFromUI(popup = document) {
    citationDatabase = {};
    citationRawBib = '';
    localStorage.removeItem(citationStorageKey());
    localStorage.removeItem(citationRawStorageKey());
    const area = popup.querySelector('#obh-library-textarea');
    if (area) area.value = '';
    const status = popup.querySelector('#obh-library-status');
    refreshCitationLibraryUI(popup);
    setStatus(status, 'success', 'Saved project bibliography cleared.');
    hideCitationHover(true);
}

function cleanCitationBibValue(value) {
    if (!value) return '';
    let text = String(value).trim();
    if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('"') && text.endsWith('"'))) {
        text = text.slice(1, -1);
    }
    return text
        .replace(/\\url\{([^}]*)\}/g, '$1')
        .replace(/\\href\{([^}]*)\}\{([^}]*)\}/g, '$2')
        .replace(/\\(?:textit|textbf|emph|mathrm|mathbf|mathit)\{([^}]*)\}/g, '$1')
        .replace(/\\&/g, '&')
        .replace(/\\_/g, '_')
        .replace(/\\%/g, '%')
        .replace(/\\#/g, '#')
        .replace(/\\textregistered/g, '®')
        .replace(/\\textquoteright/g, '’')
        .replace(/[{}]/g, '')
        .replace(/~/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseCitationFields(body) {
    const fields = {};
    let i = 0;
    while (i < body.length) {
        while (i < body.length && /[\s,]/.test(body[i])) i++;
        const keyStart = i;
        while (i < body.length && /[A-Za-z0-9_-]/.test(body[i])) i++;
        const fieldName = body.slice(keyStart, i).trim().toLowerCase();
        if (!fieldName) { i++; continue; }
        while (i < body.length && /\s/.test(body[i])) i++;
        if (body[i] !== '=') {
            while (i < body.length && body[i] !== ',') i++;
            continue;
        }
        i++;
        while (i < body.length && /\s/.test(body[i])) i++;

        let value = '';
        if (body[i] === '{') {
            let depth = 0;
            let escaped = false;
            const start = i;
            while (i < body.length) {
                const ch = body[i];
                if (escaped) { escaped = false; i++; continue; }
                if (ch === '\\') { escaped = true; i++; continue; }
                if (ch === '{') depth++;
                if (ch === '}') {
                    depth--;
                    if (depth === 0) { i++; break; }
                }
                i++;
            }
            value = body.slice(start, i);
        } else if (body[i] === '"') {
            const start = i;
            i++;
            let escaped = false;
            while (i < body.length) {
                const ch = body[i];
                if (escaped) { escaped = false; i++; continue; }
                if (ch === '\\') { escaped = true; i++; continue; }
                if (ch === '"') { i++; break; }
                i++;
            }
            value = body.slice(start, i);
        } else {
            const start = i;
            while (i < body.length && body[i] !== ',') i++;
            value = body.slice(start, i);
        }
        fields[fieldName] = cleanCitationBibValue(value);
    }
    return fields;
}

function parseCitationBibliography(text) {
    const result = {};
    const entryRegex = /@([A-Za-z][A-Za-z0-9_-]*)\s*([\{(])\s*([^,\s]+)\s*,/g;
    let match;

    while ((match = entryRegex.exec(text)) !== null) {
        const type = match[1].toLowerCase();
        if (['comment', 'preamble', 'string'].includes(type)) continue;
        const opening = match[2];
        const closing = opening === '{' ? '}' : ')';
        const citationKey = match[3].trim();
        let pos = entryRegex.lastIndex;
        let depth = 1;
        let braceDepth = 0;
        let inQuote = false;
        let escaped = false;

        while (pos < text.length && depth > 0) {
            const ch = text[pos];
            if (escaped) { escaped = false; pos++; continue; }
            if (ch === '\\') { escaped = true; pos++; continue; }
            if (opening === '{') {
                if (ch === '"' && depth === 1) inQuote = !inQuote;
                if (!inQuote) {
                    if (ch === '{') depth++;
                    else if (ch === '}') depth--;
                }
            } else {
                if (ch === '{') braceDepth++;
                else if (ch === '}') braceDepth--;
                else if (ch === '"' && braceDepth === 0) inQuote = !inQuote;
                else if (!inQuote && braceDepth === 0) {
                    if (ch === '(') depth++;
                    else if (ch === ')') depth--;
                }
            }
            pos++;
        }

        if (depth !== 0) throw new Error(`Incomplete BibTeX entry: ${citationKey}`);
        const body = text.slice(entryRegex.lastIndex, pos - 1);
        result[citationKey] = { type, key: citationKey, ...parseCitationFields(body) };
        entryRegex.lastIndex = pos;
        if (text[pos - 1] !== closing) break;
    }
    return result;
}

function formatCitationAuthors(authors) {
    if (!authors) return 'Unknown author';
    const parts = String(authors).split(/\s+and\s+/i).map(part => part.trim()).filter(Boolean);
    if (parts.length <= 1) return parts[0] || 'Unknown author';
    if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
    return `${parts[0]} et al.`;
}

function citationVenue(entry) {
    return entry.booktitle || entry.journal || entry.publisher || entry.organization || entry.howpublished || entry.school || entry.institution || '';
}

function safeHttpURL(raw) {
    if (!raw) return '';
    try {
        const url = new URL(String(raw).trim());
        return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
    } catch { return ''; }
}

function extractCitationURL(value) {
    const direct = safeHttpURL(value);
    if (direct) return direct;
    const match = String(value || '').match(/https?:\/\/[^\s<>{}\\"']+/i);
    return match ? safeHttpURL(match[0].replace(/[),.;]+$/, '')) : '';
}

function citationEntrySource(entry) {
    if (!entry) return '';

    const direct = extractCitationURL(entry.url) || extractCitationURL(entry.howpublished) || extractCitationURL(entry.note);
    if (direct) return direct;

    const doiRaw = String(entry.doi || '').trim();
    if (doiRaw) {
        const doi = normalizeDOI(doiRaw) || normalizeDOI(doiRaw.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, ''));
        if (doi) {
            const official = sourceFromDOI(doi);
            return safeHttpURL(official?.cid) || `https://doi.org/${doi}`;
        }
    }

    const eprint = String(entry.eprint || '').trim().replace(/^arxiv:/i, '');
    const archive = String(entry.archiveprefix || entry.eprinttype || '').trim();
    if (eprint && (/arxiv/i.test(archive) || /^\d{4}\.\d{4,5}(?:v\d+)?$/i.test(eprint) || /^[a-z-]+\/\d{7}(?:v\d+)?$/i.test(eprint))) {
        return `https://arxiv.org/abs/${encodeURIComponent(eprint).replace(/%2F/gi, '/')}`;
    }

    return '';
}

function citationSourceLabel(url) {
    try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        if (host === 'doi.org') return 'DOI';
        if (host === 'arxiv.org') return 'arXiv';
        if (host.includes('ieeexplore.ieee.org')) return 'IEEE Xplore';
        if (host.includes('dl.acm.org')) return 'ACM DL';
        if (host.includes('openreview.net')) return 'OpenReview';
        if (host.includes('usenix.org')) return 'USENIX';
        if (host.includes('dblp.org')) return 'DBLP';
        if (host.includes('aclanthology.org')) return 'ACL Anthology';
        if (host.includes('proceedings.neurips.cc')) return 'NeurIPS';
        return host;
    } catch { return 'Source'; }
}

function escapeCitationHTML(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
}

function escapeCitationAttr(text) {
    return escapeCitationHTML(text).replace(/`/g, '&#96;');
}

async function resolveCitationPaperSource(key) {
    const entry = citationDatabase[key];
    if (!entry) throw new Error('Citation not found in the saved project BibTeX.');

    const direct = citationEntrySource(entry);
    if (direct) return direct;

    if (citationSourceCache.has(key)) return citationSourceCache.get(key);

    const pending = (async () => {
        const title = String(entry.title || '').trim();
        if (!title) throw new Error('This BibTeX entry has no title to resolve.');

        const results = await getArticleIDListDBLP(title, 10);
        if (!results?.length) throw new Error('No matching paper source was found in DBLP.');

        const wantedTitle = normalizeTitleKey(title);
        const wantedYear = String(entry.year || '').match(/\d{4}/)?.[0] || '';
        const wantedAuthor = normalizeKeyText(getFirstAuthor(entry.author || ''));

        const scored = results.map((article, index) => {
            const articleTitle = normalizeTitleKey(article.title || '');
            const articleYear = String(article.year || '').trim();
            const articleAuthor = normalizeKeyText(getFirstAuthor(article.author || ''));
            let score = 0;
            if (articleTitle === wantedTitle) score += 100;
            else if (articleTitle.includes(wantedTitle) || wantedTitle.includes(articleTitle)) score += 60;
            if (wantedYear && articleYear === wantedYear) score += 20;
            if (wantedAuthor && articleAuthor === wantedAuthor) score += 15;
            return { article, score, index };
        }).sort((a, b) => b.score - a.score || a.index - b.index);

        const article = scored[0].article;
        const officialTargets = (article.electronicEditions || [])
            .map(getOfficialSource)
            .filter(Boolean);
        const priority = ['CVF', 'BMVC', 'NeurIPS', 'PMLR', 'ACLAnthology', 'AAAI', 'IJCAI', 'KR', 'ECVA', 'Springer', 'OpenReview', 'ACM', 'IEEE'];
        officialTargets.sort((a, b) => {
            const ai = priority.indexOf(a.source);
            const bi = priority.indexOf(b.source);
            return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
        });

        if (officialTargets.length) {
            const officialURL = safeHttpURL(officialTargets[0].cid);
            if (officialURL) return officialURL;
        }

        for (const raw of article.electronicEditions || []) {
            const url = safeHttpURL(raw);
            if (url) return url;
        }

        const dblpURL = safeHttpURL(article.url);
        if (dblpURL) return dblpURL;
        throw new Error('A paper record was found, but it has no usable source URL.');
    })().catch(error => {
        citationSourceCache.delete(key);
        throw error;
    });

    citationSourceCache.set(key, pending);
    return pending;
}

function buildCitationEntryHTML(key) {
    const entry = citationDatabase[key];
    if (!entry) {
        return `
            <div class="obh-cite-entry">
                <div class="obh-cite-key">${escapeCitationHTML(key)}</div>
                <div class="obh-cite-missing">Citation not found in the saved project BibTeX.</div>
                <div class="obh-cite-actions">
                    <button type="button" class="obh-cite-action" data-obh-cite-library="1">Manage BibTeX</button>
                </div>
            </div>`;
    }

    const authors = formatCitationAuthors(entry.author);
    const title = entry.title || 'Untitled';
    const venue = citationVenue(entry);
    const year = entry.year || '';
    const meta = [venue, year].filter(Boolean).join(', ');
    const keyAttr = escapeCitationAttr(key);

    return `
        <div class="obh-cite-entry">
            <div class="obh-cite-key">${escapeCitationHTML(key)}</div>
            <div class="obh-cite-authors">${escapeCitationHTML(authors)}</div>
            <div class="obh-cite-title-static">${escapeCitationHTML(title)}</div>
            ${meta ? `<div class="obh-cite-meta">${escapeCitationHTML(meta)}</div>` : ''}
            <div class="obh-cite-actions">
                <button type="button" class="obh-cite-action" data-obh-copy-title="${keyAttr}">Copy title</button>
                <button type="button" class="obh-cite-action" data-obh-cite-copy="${keyAttr}">Copy \\cite{${escapeCitationHTML(key)}}</button>
            </div>
        </div>`;
}

function createCitationHoverCard() {
    if (citationHoverCard?.isConnected) return citationHoverCard;
    citationHoverCard = document.createElement('div');
    citationHoverCard.id = 'obh-citation-hover';
    citationHoverCard.setAttribute('role', 'dialog');
    citationHoverCard.setAttribute('aria-label', 'Citation preview');

    citationHoverCard.addEventListener('pointerenter', () => {
        citationHoveringCard = true;
        if (citationHideTimer) clearTimeout(citationHideTimer);
    });
    citationHoverCard.addEventListener('pointerleave', () => {
        citationHoveringCard = false;
        hideCitationHover();
    });
    citationHoverCard.addEventListener('click', async event => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;

        const copyTitle = target.closest('[data-obh-copy-title]');
        if (copyTitle) {
            const key = copyTitle.getAttribute('data-obh-copy-title');
            const title = citationDatabase[key]?.title || '';
            if (!title) return;
            await GM_setClipboard(title, 'text');
            const old = copyTitle.textContent;
            copyTitle.textContent = 'Title copied';
            setTimeout(() => { if (copyTitle.isConnected) copyTitle.textContent = old; }, 700);
            return;
        }

        const copy = target.closest('[data-obh-cite-copy]');
        if (copy) {
            const key = copy.getAttribute('data-obh-cite-copy');
            await GM_setClipboard(`\\cite{${key}}`, 'text');
            const old = copy.textContent;
            copy.textContent = 'Copied';
            setTimeout(() => { if (copy.isConnected) copy.textContent = old; }, 700);
            return;
        }

        if (target.closest('[data-obh-cite-library]')) {
            hideCitationHover(true);
            openHelper('library');
        }
    });

    document.body.appendChild(citationHoverCard);
    return citationHoverCard;
}

function positionCitationHover(x, y) {
    const card = createCitationHoverCard();
    const margin = 10;
    let left = x + 14;
    let top = y + 14;
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
    const rect = card.getBoundingClientRect();
    if (rect.right > window.innerWidth - margin) left = Math.max(margin, x - rect.width - 14);
    if (rect.bottom > window.innerHeight - margin) top = Math.max(margin, y - rect.height - 14);
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
}

function showCitationHover(keys, x, y) {
    if (citationHideTimer) clearTimeout(citationHideTimer);
    const card = createCitationHoverCard();
    const signature = keys.join('\u0000');
    const firstShow = signature !== citationHoverSignature || card.style.display === 'none';
    if (firstShow) {
        card.innerHTML = keys.map(buildCitationEntryHTML).join('');
        citationHoverSignature = signature;
    }
    card.style.display = 'block';
    if (firstShow) positionCitationHover(x, y);
}

function hideCitationHover(immediate = false) {
    if (!citationHoverCard) return;
    if (citationHideTimer) clearTimeout(citationHideTimer);
    const run = () => {
        if (citationHoveringCard && !immediate) return;
        citationHoverCard.style.display = 'none';
        citationHoverSignature = '';
    };
    if (immediate) run();
    else citationHideTimer = setTimeout(run, 170);
}

function citationCaretFromPoint(x, y) {
    if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(x, y);
        if (!pos) return null;
        return { node: pos.offsetNode, offset: pos.offset };
    }
    if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(x, y);
        if (!range) return null;
        return { node: range.startContainer, offset: range.startOffset };
    }
    return null;
}

function citationLineElement(node) {
    let el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    while (el) {
        if (el.classList?.contains('cm-line') || el.classList?.contains('ace_line')) return el;
        el = el.parentElement;
    }
    return null;
}

function citationTextOffset(element, targetNode, targetOffset) {
    let offset = 0;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
        if (node === targetNode) return offset + targetOffset;
        offset += node.textContent.length;
    }
    return -1;
}

function citationKeysAtOffset(text, offset) {
    const regex = /\\(?:cite|citep|citet|citealp|citealt|parencite|textcite|autocite|footcite|supercite)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^}]*)\}/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        if (offset >= match.index && offset <= regex.lastIndex) {
            return match[1].split(',').map(key => key.trim()).filter(Boolean);
        }
    }
    return null;
}

function initCitationHoverPreview() {
    document.addEventListener('mousemove', event => {
        if (citationHoverCard?.contains(event.target)) return;
        if (document.getElementById('obh-popup')?.contains(event.target)) {
            hideCitationHover();
            return;
        }

        const caret = citationCaretFromPoint(event.clientX, event.clientY);
        if (!caret) { hideCitationHover(); return; }
        const line = citationLineElement(caret.node);
        if (!line) { hideCitationHover(); return; }
        const offset = citationTextOffset(line, caret.node, caret.offset);
        if (offset < 0) { hideCitationHover(); return; }
        const keys = citationKeysAtOffset(line.textContent, offset);
        if (!keys) { hideCitationHover(); return; }
        showCitationHover(keys, event.clientX, event.clientY);
    }, true);

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && citationHoverCard?.style.display === 'block') hideCitationHover(true);
    }, true);

    window.addEventListener('blur', () => hideCitationHover(true));
}

// Google Scholar Functions
function scholarURLWithStart(query, start, { yearFrom, yearTo, sortMode, origin = getCurrentScholarOrigin() } = {}) {
    const resolvedOrigin = normalizeOrigin(origin);
    if (!resolvedOrigin) throw new Error('Invalid Google Scholar mirror origin.');
    const startValue = Number.isFinite(start) ? Math.max(0, Math.trunc(start)) : 0;
    const params = new URLSearchParams();
    params.set('hl', 'zh-CN');
    params.set('q', query ?? '');
    params.set('start', String(startValue));

    if (Number.isFinite(yearFrom)) params.set('as_ylo', String(yearFrom));
    if (Number.isFinite(yearTo)) params.set('as_yhi', String(yearTo));
    if (sortMode === 'newest') params.set('scisbd', '1');

    return resolvedOrigin + '/scholar?' + params.toString();
}

function scholarRefPageURL(id, origin = getCurrentScholarOrigin()) {
    const resolvedOrigin = normalizeOrigin(origin);
    if (!resolvedOrigin) throw new Error('Invalid Google Scholar mirror origin.');
    const params = new URLSearchParams({
        q: 'info:' + id + ':scholar.google.com/',
        output: 'cite',
        scirp: '1',
        hl: 'zh-CN'
    });
    return resolvedOrigin + '/scholar?' + params.toString();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isLikelyScholarVerificationPage(html, doc) {
    if (doc?.querySelector?.('form#gs_captcha_f, input[name="captcha"], #captcha, .recaptcha, .g-recaptcha')) return true;
    return /unusual traffic|not a robot|verify you are|gs_captcha|g-recaptcha/i.test(html);
}

function scholarVerificationError(verificationUrl) {
    const error = new Error('Google Scholar requires verification. Open the verification link, then retry.');
    error.verificationUrl = verificationUrl;
    return error;
}

function parseGoogleScholarSearchResults(html, origin = getCurrentScholarOrigin()) {
    const resolvedOrigin = normalizeOrigin(origin);
    if (!resolvedOrigin) throw new Error('Invalid Google Scholar mirror origin.');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (isLikelyScholarVerificationPage(html, doc)) {
        throw scholarVerificationError(resolvedOrigin);
    }

    const results = [];
    for (const article of doc.querySelectorAll('div[data-cid]')) {
        const cid = article.getAttribute('data-cid') || '';
        if (!cid) continue;
        const heading = article.querySelector('h3');
        const title = heading?.textContent?.trim().replace(/^\[(?:PDF|HTML|BOOK|CITATION)\]\s*/i, '') ?? '';
        const author = article.querySelector('div.gs_a')?.textContent?.trim() ?? '';
        if (!title) continue;
        let publicationURL = '';
        const href = heading?.querySelector('a[href]')?.getAttribute('href');
        if (href) {
            try {
                const url = new URL(href, resolvedOrigin);
                if (/^https?:$/.test(url.protocol)) publicationURL = url.href;
            } catch {
                // A malformed optional publication link does not invalidate the result.
            }
        }
        results.push({ id: cid, title, author, url: publicationURL, origin: resolvedOrigin });
    }
    return results;
}

async function fetchScholarSearchPage(query, start, options = {}) {
    const url = scholarURLWithStart(query, start, options);
    return requestText(url, { verificationUrl: url });
}

async function getArticleIDListGoogleScholar(query, resultCount, options = {}) {
    const maxResults = Number.parseInt(resultCount, 10) || 5;
    const desired = Math.max(1, Math.min(maxResults, 50));
    // A later mirror selection must not change pagination or these results' export source.
    const origin = normalizeOrigin(options.origin ?? getCurrentScholarOrigin());
    if (!origin) throw new Error('Invalid Google Scholar mirror origin.');
    const searchOptions = { ...options, origin };
    const seen = new Set();
    const collected = [];

    const maxRequests = Math.min(10, Math.ceil(desired / 10) + 2);
    let start = 0;
    for (let requestIndex = 0; requestIndex < maxRequests && collected.length < desired; requestIndex++) {
        const html = await fetchScholarSearchPage(query, start, searchOptions);
        const pageResults = parseGoogleScholarSearchResults(html, origin);
        if (pageResults.length === 0) break;

        let added = 0;
        for (const item of pageResults) {
            if (seen.has(item.id)) continue;
            seen.add(item.id);
            collected.push(item);
            added++;
            if (collected.length >= desired) break;
        }
        if (!added || collected.length >= desired) break;
        start += 10;
        await sleep(300);
    }
    return collected;
}

async function getRefPageGoogleScholar(id, origin = getCurrentScholarOrigin()) {
    const url = scholarRefPageURL(id, origin);
    return requestText(url, { verificationUrl: url });
}

async function getBibTexGoogleScholar(id, origin = getCurrentScholarOrigin()) {
    const resolvedOrigin = normalizeOrigin(origin);
    if (!resolvedOrigin) throw new Error('Invalid Google Scholar mirror origin.');
    const citeURL = scholarRefPageURL(id, resolvedOrigin);
    const page = await getRefPageGoogleScholar(id, resolvedOrigin);
    const doc = new DOMParser().parseFromString(page, 'text/html');
    if (isLikelyScholarVerificationPage(page, doc)) throw scholarVerificationError(citeURL);

    const bibtexAnchor = Array.from(doc.querySelectorAll('a.gs_citi, a[href*="scholar.bib"]')).find(anchor =>
        /\bBibTeX\b/i.test(anchor.textContent ?? '') || /\/scholar\.bib(?:[?#]|$)/i.test(anchor.getAttribute('href') ?? '')
    );
    if (!bibtexAnchor) {
        throw new Error('Google Scholar did not provide a BibTeX export link. Try another result or mirror.');
    }
    const bibtexURL = new URL(bibtexAnchor.getAttribute('href'), citeURL);
    if (bibtexURL.protocol !== 'https:') throw new Error('Google Scholar returned an invalid BibTeX export URL.');
    return validateBibTeX(await requestText(bibtexURL.href, { verificationUrl: citeURL }));
}
