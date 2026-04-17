export type PreservedMarkdownFragmentKind =
    | "html-table"
    | "markdown-table"
    | "code-block"
    | "inline-code"
    | "math-block"
    | "math-inline"
    | "glossary-term";

export interface PreservedMarkdownFragment {
    marker: string;
    content: string;
    kind: PreservedMarkdownFragmentKind;
}

const HTML_TABLE_PATTERN = /<table\b[\s\S]*?<\/table>/gi;
const PRESERVE_MARKER_ROOT = "@@DOTI_";
const PRESERVE_MARKER_SUFFIX = "@@";
const MARKDOWN_ALIGNMENT_ROW_PATTERN = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)\|?\s*$/;
const MARKDOWN_TABLE_ROW_PATTERN = /^\s*\|?(?:[^|\n]+\|){1,}[^|\n]*\|?\s*$/;
const TABLE_TAG_PATTERN = /<\/?(table|thead|tbody|tfoot|tr|td|th)\b[^>]*>/gi;
const TABLE_BOUNDARY_PATTERN = /^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+|!\[|\$\$|\\\[|\\begin\{)/;
const DOTI_MARKER_PATTERN = /(@{0,2}DOTI_[A-Z_]+_\d+@{0,2})/gi;
const BARE_LATEX_STRONG_COMMAND_PATTERN = /\\(?:frac|dfrac|tfrac|sum|prod|int|iint|iiint|oint|lim|log|ln|exp|max|min|sup|inf|det|operatorname|boldsymbol|mathbf|mathcal|mathbb|mathfrak|mathit|mathrm|left|right|bigl|bigr|Bigl|Bigr|tag|hat|widehat|tilde|widetilde|bar|overline|underline|sqrt|partial|nabla|cdot|times|leq|geq|neq|approx|sim|infty|forall|exists|mid|to|mapsto|rightarrow|leftarrow|iff|implies|alpha|beta|gamma|delta|theta|lambda|mu|pi|phi|psi|omega)\b/;
const BARE_LATEX_COMMAND_PATTERN = /\\[a-zA-Z]+/g;
const BARE_LATEX_STRUCTURAL_PATTERN = /(?:[_^]\s*\{|[_^][A-Za-z0-9\\({[]|\\left\b|\\right\b|\\tag\s*\{|\\mid\b|\\det\b|\\partial\b|\\boldsymbol\b|\\operatorname\b|\\frac\b|[=<>])/;

const MARKER_KIND_MAP: Record<PreservedMarkdownFragmentKind, string> = {
    "html-table": "HTML_TABLE_BLOCK",
    "markdown-table": "MARKDOWN_TABLE_BLOCK",
    "code-block": "CODE_BLOCK",
    "inline-code": "CODE_INLINE",
    "math-block": "MATH_BLOCK",
    "math-inline": "MATH_INLINE",
    "glossary-term": "GLOSSARY_TERM",
};

export interface GlossaryTermCandidate {
    source: string;
    target: string;
    category?: string;
}

function buildPreserveMarker(kind: PreservedMarkdownFragmentKind, index: number): string {
    return `${PRESERVE_MARKER_ROOT}${MARKER_KIND_MAP[kind]}_${String(index + 1).padStart(4, "0")}${PRESERVE_MARKER_SUFFIX}`;
}

function createPreservedFragment(
    content: string,
    kind: PreservedMarkdownFragmentKind,
    fragments: PreservedMarkdownFragment[]
): string {
    const marker = buildPreserveMarker(kind, fragments.length);
    fragments.push({ marker, content, kind });
    return marker;
}

function protectWithPattern(
    markdown: string,
    pattern: RegExp,
    kind: PreservedMarkdownFragmentKind,
    fragments: PreservedMarkdownFragment[]
): string {
    return markdown.replace(pattern, (match) => createPreservedFragment(match, kind, fragments));
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWordLikeCharacter(value: string | undefined): boolean {
    return Boolean(value && /[\p{L}\p{N}_]/u.test(value));
}

function buildTermMatchPattern(source: string): RegExp {
    const escapedSource = escapeRegExp(source.trim());
    const firstChar = source.trim()[0];
    const lastChar = source.trim().at(-1);
    const prefix = isWordLikeCharacter(firstChar) ? "(?<![\\p{L}\\p{N}_])" : "";
    const suffix = isWordLikeCharacter(lastChar) ? "(?![\\p{L}\\p{N}_])" : "";
    return new RegExp(`${prefix}${escapedSource}${suffix}`, "giu");
}

function rangesOverlap(start: number, end: number, ranges: Array<{ start: number; end: number }>): boolean {
    return ranges.some((range) => start < range.end && end > range.start);
}

function protectGlossaryTermsInPlainSegment(
    segment: string,
    terms: GlossaryTermCandidate[],
    fragments: PreservedMarkdownFragment[]
): string {
    if (!segment || terms.length === 0) {
        return segment;
    }

    const matches: Array<{ start: number; end: number; target: string }> = [];

    for (const term of terms) {
        const pattern = buildTermMatchPattern(term.source);
        let match: RegExpExecArray | null = pattern.exec(segment);

        while (match) {
            const start = match.index;
            const end = start + match[0].length;

            if (!rangesOverlap(start, end, matches)) {
                matches.push({ start, end, target: term.target });
            }

            match = pattern.exec(segment);
        }
    }

    if (matches.length === 0) {
        return segment;
    }

    matches.sort((left, right) => left.start - right.start);

    let output = "";
    let cursor = 0;

    for (const match of matches) {
        output += segment.slice(cursor, match.start);
        output += createPreservedFragment(match.target, "glossary-term", fragments);
        cursor = match.end;
    }

    output += segment.slice(cursor);
    return output;
}

function shouldLockGlossaryTerm(term: GlossaryTermCandidate): boolean {
    const source = term.source.trim();
    const category = term.category?.toLowerCase() || "";

    if (!source) {
        return false;
    }

    if (/(^|\b)(lock|exact|brand|name)(\b|$)/.test(category)) {
        return true;
    }

    if (/[A-Z]{2,}/.test(source)) {
        return true;
    }

    if (/\d/.test(source)) {
        return true;
    }

    if (/[+/_]/.test(source)) {
        return true;
    }

    if (/-/.test(source) && /[A-Z0-9]/.test(source)) {
        return true;
    }

    if (/^[A-Z][a-zA-Z0-9]{1,23}$/.test(source)) {
        return true;
    }

    return false;
}

function normalizeGlossaryTerms(terms: GlossaryTermCandidate[]): GlossaryTermCandidate[] {
    return Array.from(
        new Map(
            terms
                .filter((term) => term.source.trim() && term.target.trim())
                .sort((left, right) => right.source.length - left.source.length)
                .map((term) => [`${term.source.toLowerCase()}::${term.target}`, term] as const)
        ).values()
    );
}

function protectFencedCodeBlocks(markdown: string, fragments: PreservedMarkdownFragment[]): string {
    const lines = markdown.split(/\r?\n/);
    const output: string[] = [];

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const match = line.match(/^\s*(`{3,}|~{3,})/);

        if (!match) {
            output.push(line);
            continue;
        }

        const opener = match[1];
        const fenceChar = opener[0];
        const fenceLength = opener.length;
        const fencePattern = new RegExp(`^\\s*${fenceChar}{${fenceLength},}\\s*$`);
        const blockLines = [line];

        while (index + 1 < lines.length) {
            index += 1;
            blockLines.push(lines[index]);

            if (fencePattern.test(lines[index])) {
                break;
            }
        }

        output.push(createPreservedFragment(blockLines.join("\n"), "code-block", fragments));
    }

    return output.join("\n");
}

function protectHtmlTables(markdown: string, fragments: PreservedMarkdownFragment[]): string {
    return protectWithPattern(markdown, HTML_TABLE_PATTERN, "html-table", fragments);
}

function protectBlockMath(markdown: string, fragments: PreservedMarkdownFragment[]): string {
    const blockPatterns: Array<{ pattern: RegExp; kind: PreservedMarkdownFragmentKind }> = [
        { pattern: /\$\$[\s\S]+?\$\$/g, kind: "math-block" },
        { pattern: /\\\[[\s\S]+?\\\]/g, kind: "math-block" },
        { pattern: /\\begin\{([a-zA-Z0-9*]+)\}[\s\S]*?\\end\{\1\}/g, kind: "math-block" },
    ];

    const protectedMarkdown = blockPatterns.reduce((nextMarkdown, entry) => (
        protectWithPattern(nextMarkdown, entry.pattern, entry.kind, fragments)
    ), markdown);

    return protectSingleDollarMathBlocks(protectedMarkdown, fragments);
}

function protectSingleDollarMathBlocks(markdown: string, fragments: PreservedMarkdownFragment[]): string {
    const lines = markdown.split(/\r?\n/);
    const output: string[] = [];

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];

        if (line.trim() !== "$") {
            output.push(line);
            continue;
        }

        const blockLines = [line];
        let endIndex = index;
        let foundClosingFence = false;

        while (endIndex + 1 < lines.length) {
            endIndex += 1;
            blockLines.push(lines[endIndex]);

            if (lines[endIndex].trim() === "$") {
                foundClosingFence = true;
                break;
            }
        }

        if (foundClosingFence && blockLines.length > 2) {
            output.push(createPreservedFragment(blockLines.join("\n"), "math-block", fragments));
        } else {
            output.push(...blockLines);
        }

        index = endIndex;
    }

    return output.join("\n");
}

function looksLikeBareLatexMathLine(line: string): boolean {
    const trimmed = line.trim();

    if (!trimmed) {
        return false;
    }

    if (/^@{0,2}DOTI_[A-Z_]+_\d+@{0,2}$/i.test(trimmed)) {
        return false;
    }

    if (TABLE_BOUNDARY_PATTERN.test(trimmed)) {
        return false;
    }

    if ((MARKDOWN_TABLE_ROW_PATTERN.test(trimmed) || MARKDOWN_ALIGNMENT_ROW_PATTERN.test(trimmed)) && !/\\[a-zA-Z]+/.test(trimmed)) {
        return false;
    }

    if (/^<\/?[a-z][^>]*>$/i.test(trimmed)) {
        return false;
    }

    if (/[\p{Script=Han}]/u.test(trimmed)) {
        return false;
    }

    const commandCount = trimmed.match(BARE_LATEX_COMMAND_PATTERN)?.length ?? 0;
    const hasStrongCommand = BARE_LATEX_STRONG_COMMAND_PATTERN.test(trimmed);
    const hasStructuralSignal = BARE_LATEX_STRUCTURAL_PATTERN.test(trimmed);
    const braceCount = trimmed.match(/[{}]/g)?.length ?? 0;
    const naturalWordCount = trimmed.match(/[A-Za-z]{3,}/g)?.length ?? 0;
    const looksLikeSentence = /[.?!]\s+[A-Z]/.test(trimmed);

    if (looksLikeSentence) {
        return false;
    }

    if (hasStrongCommand && (hasStructuralSignal || braceCount >= 2) && naturalWordCount <= commandCount + 3) {
        return true;
    }

    return commandCount >= 2 && hasStructuralSignal && naturalWordCount <= commandCount + 1;
}

function looksLikeBareLatexContinuationLine(line: string): boolean {
    const trimmed = line.trim();

    if (!trimmed) {
        return false;
    }

    if (looksLikeBareLatexMathLine(trimmed)) {
        return true;
    }

    if (/[\p{Script=Han}]/u.test(trimmed)) {
        return false;
    }

    if (/^\(?\d+\)?[.)]?$/.test(trimmed)) {
        return true;
    }

    if (/^[@$]{1,2}$/.test(trimmed)) {
        return false;
    }

    const hasLatexCommands = (trimmed.match(BARE_LATEX_COMMAND_PATTERN)?.length ?? 0) >= 1;
    const hasMathStructure = /[_^{}=<>]/.test(trimmed);
    const startsLikeContinuation = /^[=+\-*/,&|\\]/.test(trimmed);

    return (startsLikeContinuation && (hasLatexCommands || hasMathStructure)) || (hasLatexCommands && hasMathStructure);
}

function protectBareLatexBlocks(markdown: string, fragments: PreservedMarkdownFragment[]): string {
    const lines = markdown.split(/\r?\n/);
    const output: string[] = [];

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];

        if (!looksLikeBareLatexMathLine(line)) {
            output.push(line);
            continue;
        }

        const blockLines = [line];
        let endIndex = index;

        while (endIndex + 1 < lines.length && looksLikeBareLatexContinuationLine(lines[endIndex + 1])) {
            endIndex += 1;
            blockLines.push(lines[endIndex]);
        }

        output.push(createPreservedFragment(blockLines.join("\n"), "math-block", fragments));
        index = endIndex;
    }

    return output.join("\n");
}

function isMarkdownTableStart(currentLine: string, nextLine: string | undefined): boolean {
    if (!nextLine) return false;
    if (!MARKDOWN_TABLE_ROW_PATTERN.test(currentLine)) return false;
    return MARKDOWN_ALIGNMENT_ROW_PATTERN.test(nextLine);
}

function isMarkdownTableRow(line: string): boolean {
    return MARKDOWN_TABLE_ROW_PATTERN.test(line);
}

function protectMarkdownPipeTables(markdown: string, fragments: PreservedMarkdownFragment[]): string {
    const lines = markdown.split(/\r?\n/);
    const output: string[] = [];

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];

        if (isMarkdownTableStart(line, lines[index + 1])) {
            const tableLines = [line, lines[index + 1]];
            index += 2;

            while (index < lines.length && isMarkdownTableRow(lines[index])) {
                tableLines.push(lines[index]);
                index += 1;
            }

            index -= 1;
            output.push(createPreservedFragment(tableLines.join("\n"), "markdown-table", fragments));
            continue;
        }

        output.push(line);
    }

    return output.join("\n");
}

function protectInlineBacktickCode(markdown: string, fragments: PreservedMarkdownFragment[]): string {
    let output = "";

    for (let index = 0; index < markdown.length;) {
        if (markdown[index] !== "`") {
            output += markdown[index];
            index += 1;
            continue;
        }

        let tickCount = 1;
        while (markdown[index + tickCount] === "`") {
            tickCount += 1;
        }

        const delimiter = "`".repeat(tickCount);
        let searchIndex = index + tickCount;
        let closingIndex = -1;

        while (searchIndex < markdown.length) {
            const nextIndex = markdown.indexOf(delimiter, searchIndex);
            if (nextIndex === -1) {
                break;
            }

            const fragment = markdown.slice(index, nextIndex + tickCount);
            if (!fragment.includes("\n")) {
                closingIndex = nextIndex;
                break;
            }

            searchIndex = nextIndex + tickCount;
        }

        if (closingIndex === -1) {
            output += markdown.slice(index, index + tickCount);
            index += tickCount;
            continue;
        }

        const fragment = markdown.slice(index, closingIndex + tickCount);
        output += createPreservedFragment(fragment, "inline-code", fragments);
        index = closingIndex + tickCount;
    }

    return output;
}

function looksLikeInlineMath(content: string): boolean {
    const trimmed = content.trim();

    if (!trimmed || trimmed !== content) {
        return false;
    }

    if (/^\d+(?:[.,]\d+)?$/.test(trimmed)) {
        return false;
    }

    if (/^[A-Za-z]$/.test(trimmed)) {
        return true;
    }

    if (/^\w+$/.test(trimmed) && trimmed.length > 4) {
        return false;
    }

    if (/\s/.test(trimmed) && !/[=<>+\-*/_^\\()[\]{}]/.test(trimmed)) {
        return false;
    }

    return /\\[a-zA-Z]+|[_^{}=<>+\-*/()[\]]|\d[A-Za-z]|[A-Za-z]\d/.test(trimmed);
}

function isEscaped(source: string, index: number): boolean {
    let slashCount = 0;

    for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
        slashCount += 1;
    }

    return slashCount % 2 === 1;
}

function protectInlineDollarMath(markdown: string, fragments: PreservedMarkdownFragment[]): string {
    let output = "";

    for (let index = 0; index < markdown.length;) {
        const current = markdown[index];

        if (current !== "$" || isEscaped(markdown, index) || markdown[index + 1] === "$") {
            output += current;
            index += 1;
            continue;
        }

        let closingIndex = -1;

        for (let cursor = index + 1; cursor < markdown.length; cursor += 1) {
            if (markdown[cursor] === "\n") {
                break;
            }

            if (
                markdown[cursor] === "$" &&
                !isEscaped(markdown, cursor) &&
                markdown[cursor - 1] !== "$" &&
                markdown[cursor + 1] === "$"
            ) {
                closingIndex = cursor;
                break;
            }

            if (
                markdown[cursor] === "$" &&
                !isEscaped(markdown, cursor) &&
                markdown[cursor - 1] !== "$" &&
                markdown[cursor + 1] !== "$"
            ) {
                closingIndex = cursor;
                break;
            }
        }

        if (closingIndex === -1) {
            output += current;
            index += 1;
            continue;
        }

        const content = markdown.slice(index + 1, closingIndex);
        if (!looksLikeInlineMath(content)) {
            output += current;
            index += 1;
            continue;
        }

        const fragment = markdown.slice(index, closingIndex + 1);
        output += createPreservedFragment(fragment, "math-inline", fragments);
        index = closingIndex + 1;
    }

    return output;
}

function protectInlineParenMath(markdown: string, fragments: PreservedMarkdownFragment[]): string {
    return protectWithPattern(markdown, /\\\([\s\S]+?\\\)/g, "math-inline", fragments);
}

function separateAdjacentInlineMathMarkers(markdown: string): string {
    return markdown.replace(
        /(@@DOTI_MATH_INLINE_\d+@@)(?=@@DOTI_MATH_INLINE_\d+@@)/g,
        "$1 "
    );
}

function normalizeAdjacentInlineMathSpacing(markdown: string): string {
    return markdown.replace(/(\$[^$\n]+\$)(?=\$[^$\n]+\$)/g, "$1 ");
}

export function protectMarkdownFragments(markdown: string): {
    text: string;
    fragments: PreservedMarkdownFragment[];
} {
    if (!markdown || !/[`$|\\]|<table/i.test(markdown)) {
        return { text: markdown, fragments: [] };
    }

    const fragments: PreservedMarkdownFragment[] = [];
    const fencedCodeProtected = protectFencedCodeBlocks(markdown, fragments);
    const htmlProtected = protectHtmlTables(fencedCodeProtected, fragments);
    const blockMathProtected = protectBlockMath(htmlProtected, fragments);
    const bareLatexProtected = protectBareLatexBlocks(blockMathProtected, fragments);
    const tableProtected = protectMarkdownPipeTables(bareLatexProtected, fragments);
    const inlineCodeProtected = protectInlineBacktickCode(tableProtected, fragments);
    const inlineParenMathProtected = protectInlineParenMath(inlineCodeProtected, fragments);
    const fullyProtected = protectInlineDollarMath(inlineParenMathProtected, fragments);
    const normalizedProtected = separateAdjacentInlineMathMarkers(fullyProtected);

    return {
        text: normalizedProtected,
        fragments,
    };
}

export function protectMarkdownTables(markdown: string): {
    text: string;
    fragments: PreservedMarkdownFragment[];
} {
    return protectMarkdownFragments(markdown);
}

export function protectLockedGlossaryTerms(
    markdown: string,
    terms: GlossaryTermCandidate[]
): {
    text: string;
    fragments: PreservedMarkdownFragment[];
} {
    if (!markdown || terms.length === 0) {
        return { text: markdown, fragments: [] };
    }

    const normalizedTerms = normalizeGlossaryTerms(terms).filter(shouldLockGlossaryTerm);

    if (normalizedTerms.length === 0) {
        return { text: markdown, fragments: [] };
    }

    const fragments: PreservedMarkdownFragment[] = [];
    const segments = markdown.split(DOTI_MARKER_PATTERN);
    const protectedSegments = segments.map((segment, index) => (
        index % 2 === 1
            ? segment
            : protectGlossaryTermsInPlainSegment(segment, normalizedTerms, fragments)
    ));

    return {
        text: protectedSegments.join(""),
        fragments,
    };
}

export function applySoftGlossaryCorrections(
    markdown: string,
    terms: GlossaryTermCandidate[]
): string {
    if (!markdown || terms.length === 0) {
        return markdown;
    }

    const normalizedTerms = normalizeGlossaryTerms(terms);
    const segments = markdown.split(DOTI_MARKER_PATTERN);
    const correctedSegments = segments.map((segment, index) => {
        if (index % 2 === 1) {
            return segment;
        }

        let next = segment;
        for (const term of normalizedTerms) {
            next = next.replace(buildTermMatchPattern(term.source), term.target);
        }
        return next;
    });

    return correctedSegments.join("");
}

export function restorePreservedMarkdownFragments(
    markdown: string,
    fragments: PreservedMarkdownFragment[]
): string {
    if (fragments.length === 0) {
        return markdown;
    }

    const restored = fragments.reduce((nextRestored, fragment) => {
        const body = fragment.marker.slice(2, -2);
        const tolerantMarkerPattern = new RegExp(
            `(?<![A-Z0-9_])@{0,2}\\s*${escapeRegExp(body)}\\s*@{0,2}(?![A-Z0-9_])`,
            "gi"
        );
        let next = nextRestored.replace(tolerantMarkerPattern, fragment.content);
        next = next.split(fragment.marker).join(fragment.content);
        return next;
    }, markdown);

    return normalizeAdjacentInlineMathSpacing(restored);
}

export class PreservedMarkdownStreamRestorer {
    private readonly holdLength: number;
    private buffer = "";

    constructor(private readonly fragments: PreservedMarkdownFragment[]) {
        this.holdLength = fragments.reduce((max, fragment) => (
            Math.max(max, fragment.marker.length)
        ), 0);
    }

    consume(chunk: string, flush = false): string {
        this.buffer += chunk;
        this.buffer = restorePreservedMarkdownFragments(this.buffer, this.fragments);

        if (flush || this.holdLength === 0) {
            const output = this.buffer;
            this.buffer = "";
            return output;
        }

        if (this.buffer.length <= this.holdLength) {
            return "";
        }

        const emitLength = this.buffer.length - this.holdLength;
        const output = this.buffer.slice(0, emitLength);
        this.buffer = this.buffer.slice(emitLength);
        return output;
    }
}

function closeOpenTableTags(state: {
    table: number;
    tr: number;
    td: number;
    th: number;
}): string {
    return [
        "</th>".repeat(Math.max(0, state.th)),
        "</td>".repeat(Math.max(0, state.td)),
        "</tr>".repeat(Math.max(0, state.tr)),
        "</table>".repeat(Math.max(0, state.table)),
    ].join("");
}

export function repairDanglingHtmlTables(markdown: string): string {
    if (!markdown.includes("<table")) {
        return markdown;
    }

    const lines = markdown.split(/\r?\n/);
    const output: string[] = [];
    const state = { table: 0, tr: 0, td: 0, th: 0 };

    const applyLineTags = (line: string) => {
        TABLE_TAG_PATTERN.lastIndex = 0;
        for (const match of line.matchAll(TABLE_TAG_PATTERN)) {
            const fullTag = match[0].toLowerCase();
            const tagName = match[1].toLowerCase() as keyof typeof state;
            const isClosingTag = fullTag.startsWith("</");
            const delta = isClosingTag ? -1 : 1;
            state[tagName] = Math.max(0, state[tagName] + delta);
        }
        TABLE_TAG_PATTERN.lastIndex = 0;
    };

    for (const line of lines) {
        const trimmed = line.trim();
        const looksLikeBoundary = trimmed === "" || TABLE_BOUNDARY_PATTERN.test(trimmed);
        const containsTableTag = TABLE_TAG_PATTERN.test(line);
        TABLE_TAG_PATTERN.lastIndex = 0;

        if (state.table > 0 && looksLikeBoundary && !containsTableTag) {
            output.push(closeOpenTableTags(state));
            state.table = 0;
            state.tr = 0;
            state.td = 0;
            state.th = 0;
        }

        output.push(line);
        applyLineTags(line);
    }

    if (state.table > 0) {
        output.push(closeOpenTableTags(state));
    }

    return output.join("\n");
}
