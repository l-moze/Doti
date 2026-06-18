import {
    repairDanglingHtmlTables,
    restorePreservedMarkdownFragments,
    type PreservedMarkdownFragment,
} from "@/lib/markdown-table-utils";
import { normalizeTranslationTypography } from "@/lib/translation-postprocess";

export type TranslationIntegrityIssueKind =
    | "placeholder-repaired"
    | "placeholder-unresolved"
    | "escaped-html-table"
    | "html-table-spacing"
    | "html-table-closed"
    | "display-math-normalized";

export interface TranslationIntegrityIssue {
    kind: TranslationIntegrityIssueKind;
    detail: string;
}

export interface TranslationIntegrityResult {
    text: string;
    changed: boolean;
    issues: TranslationIntegrityIssue[];
}

const PLACEHOLDER_RESIDUE_PATTERN = /@{0,2}\s*DOTI_[A-Z0-9_]*?_(\d{4})\s*@{0,2}/gi;
const ESCAPED_HTML_TABLE_PATTERN = /&lt;table\b[\s\S]*?&lt;\/table&gt;/gi;
const LOOSE_DISPLAY_MATH_PATTERN = /(^|\n)\$\s*\n([\s\S]*?)\n\$(?=\n|$)/g;

function decodeBasicHtmlEntities(value: string): string {
    return value
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&amp;/gi, "&");
}

function restorePlaceholderResiduesByIndex(
    markdown: string,
    fragments: PreservedMarkdownFragment[]
): { text: string; replacedCount: number } {
    if (!markdown || fragments.length === 0) {
        return { text: markdown, replacedCount: 0 };
    }

    const fragmentByIndex = new Map<string, string>();
    for (const fragment of fragments) {
        const match = fragment.marker.match(/_(\d{4})@@$/);
        if (!match) continue;
        fragmentByIndex.set(match[1], fragment.content);
    }

    let replacedCount = 0;
    const text = markdown.replace(PLACEHOLDER_RESIDUE_PATTERN, (match, index: string) => {
        const replacement = fragmentByIndex.get(index);
        if (!replacement) return match;
        replacedCount += 1;
        return replacement;
    });

    return { text, replacedCount };
}

function restoreEscapedHtmlTables(markdown: string): { text: string; restoredCount: number } {
    let restoredCount = 0;
    const text = markdown.replace(ESCAPED_HTML_TABLE_PATTERN, (match) => {
        restoredCount += 1;
        return decodeBasicHtmlEntities(match);
    });

    return { text, restoredCount };
}

function ensureHtmlTableBlockSpacing(markdown: string): { text: string; changed: boolean } {
    const withLeadingBreaks = markdown.replace(/([^\n])(<table\b)/gi, "$1\n\n$2");
    const withTrailingBreaks = withLeadingBreaks.replace(/(<\/table>)([^\n])/gi, "$1\n\n$2");
    return {
        text: withTrailingBreaks,
        changed: withTrailingBreaks !== markdown,
    };
}

function normalizeLooseDisplayMathBlocks(markdown: string): { text: string; changedCount: number } {
    let changedCount = 0;
    const text = markdown.replace(LOOSE_DISPLAY_MATH_PATTERN, (match, prefix: string, body: string) => {
        const normalizedBody = body.trim();
        if (!normalizedBody || normalizedBody.includes('\n$$') || normalizedBody.includes('$$\n')) {
            return match;
        }

        changedCount += 1;
        return `${prefix}$$\n${normalizedBody}\n$$`;
    });

    return { text, changedCount };
}

function countUnresolvedPlaceholders(markdown: string): number {
    const matches = markdown.match(PLACEHOLDER_RESIDUE_PATTERN);
    PLACEHOLDER_RESIDUE_PATTERN.lastIndex = 0;
    return matches?.length ?? 0;
}

export function runTranslationIntegrityPass(input: {
    text: string;
    targetLang: string;
    preservedFragments: PreservedMarkdownFragment[];
}): TranslationIntegrityResult {
    const issues: TranslationIntegrityIssue[] = [];
    let next = input.text;

    const restored = restorePreservedMarkdownFragments(next, input.preservedFragments);
    next = restored;

    const placeholderRepair = restorePlaceholderResiduesByIndex(next, input.preservedFragments);
    if (placeholderRepair.replacedCount > 0) {
        next = placeholderRepair.text;
        issues.push({
            kind: "placeholder-repaired",
            detail: `Recovered ${placeholderRepair.replacedCount} unresolved protected placeholder(s).`,
        });
    }

    const escapedTables = restoreEscapedHtmlTables(next);
    if (escapedTables.restoredCount > 0) {
        next = escapedTables.text;
        issues.push({
            kind: "escaped-html-table",
            detail: `Decoded ${escapedTables.restoredCount} escaped HTML table block(s).`,
        });
    }

    const tableSpacing = ensureHtmlTableBlockSpacing(next);
    if (tableSpacing.changed) {
        next = tableSpacing.text;
        issues.push({
            kind: "html-table-spacing",
            detail: "Inserted block spacing around HTML tables to stabilize Markdown rendering.",
        });
    }

    const repairedTables = repairDanglingHtmlTables(next);
    if (repairedTables !== next) {
        next = repairedTables;
        issues.push({
            kind: "html-table-closed",
            detail: "Closed dangling HTML table tags after translation.",
        });
    }

    const normalizedDisplayMath = normalizeLooseDisplayMathBlocks(next);
    if (normalizedDisplayMath.changedCount > 0) {
        next = normalizedDisplayMath.text;
        issues.push({
            kind: "display-math-normalized",
            detail: `Normalized ${normalizedDisplayMath.changedCount} loose display math block(s) back to $$ fences.`,
        });
    }

    const normalizedTypography = normalizeTranslationTypography(next, input.targetLang);
    next = normalizedTypography;

    const unresolvedPlaceholders = countUnresolvedPlaceholders(next);
    if (unresolvedPlaceholders > 0) {
        issues.push({
            kind: "placeholder-unresolved",
            detail: `${unresolvedPlaceholders} protected placeholder(s) still remain after repair.`,
        });
    }

    return {
        text: next,
        changed: next !== input.text,
        issues,
    };
}
