// 模块级 LRU 缓存：避免对同一文本重复执行开销较大的数学表达式正规化。
// streaming 阶段文本频繁追加，finalize 后文本稳定，缓存可完全命中。
const _normalizeMathCache = new Map<string, string>();
const _NORMALIZE_MATH_CACHE_MAX = 512;

const DISPLAY_MATH_ENVIRONMENTS = new Set([
    'aligned',
    'align',
    'alignat',
    'array',
    'bmatrix',
    'Bmatrix',
    'cases',
    'cd',
    'eqnarray',
    'equation',
    'gather',
    'matrix',
    'multline',
    'pmatrix',
    'smallmatrix',
    'split',
    'vmatrix',
    'Vmatrix',
]);
const MARKDOWN_ALIGNMENT_ROW_PATTERN = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)\|?\s*$/;
const MARKDOWN_TABLE_ROW_PATTERN = /^\s*\|?(?:[^|\n]+\|){1,}[^|\n]*\|?\s*$/;
const BLOCK_BOUNDARY_PATTERN = /^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+|!\[|<\/?[a-z][^>]*>|@@DOTI_[A-Z_]+_\d+@@)$/i;
const BARE_LATEX_STRONG_COMMAND_PATTERN = /\\(?:frac|dfrac|tfrac|sum|prod|int|iint|iiint|oint|lim|log|ln|exp|max|min|sup|inf|det|operatorname|boldsymbol|mathbf|mathcal|mathbb|mathfrak|mathit|mathrm|left|right|bigl|bigr|Bigl|Bigr|tag|hat|widehat|tilde|widetilde|bar|overline|underline|sqrt|partial|nabla|cdot|times|leq|geq|neq|approx|sim|infty|forall|exists|mid|to|mapsto|rightarrow|leftarrow|iff|implies|alpha|beta|gamma|delta|theta|lambda|mu|pi|phi|psi|omega)\b/;
const BARE_LATEX_COMMAND_PATTERN = /\\[a-zA-Z]+/g;
const BARE_LATEX_STRUCTURAL_PATTERN = /(?:[_^]\s*\{|[_^][A-Za-z0-9\\({[]|\\left\b|\\right\b|\\tag\s*\{|\\mid\b|\\det\b|\\partial\b|\\boldsymbol\b|\\operatorname\b|\\frac\b|[=<>])/;

function normalizeEnvironmentName(environment: string): string {
    return environment.trim().replace(/\*$/, '');
}

function shouldWrapEnvironment(environment: string): boolean {
    return DISPLAY_MATH_ENVIRONMENTS.has(normalizeEnvironmentName(environment));
}

function isAlreadyWrappedBlock(previousLine: string, nextLine: string, blockText: string): boolean {
    return (
        blockText.startsWith('$$') ||
        blockText.startsWith('\\[') ||
        previousLine === '$$' ||
        previousLine === '\\[' ||
        nextLine === '$$' ||
        nextLine === '\\]'
    );
}

function pushWrappedDisplayMathBlock(output: string[], blockText: string, nextLine: string): void {
    if (!blockText) {
        return;
    }

    if (output.length > 0 && output[output.length - 1].trim() !== '') {
        output.push('');
    }

    output.push('$$');
    output.push(blockText);
    output.push('$$');

    if (nextLine !== '') {
        output.push('');
    }
}

function looksLikeBareLatexMathLine(line: string): boolean {
    const trimmed = line.trim();

    if (!trimmed) {
        return false;
    }

    if (BLOCK_BOUNDARY_PATTERN.test(trimmed)) {
        return false;
    }

    if ((MARKDOWN_TABLE_ROW_PATTERN.test(trimmed) || MARKDOWN_ALIGNMENT_ROW_PATTERN.test(trimmed)) && !/\\[a-zA-Z]+/.test(trimmed)) {
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

    if (/[.?!]\s+[A-Z]/.test(trimmed)) {
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

    const hasLatexCommands = (trimmed.match(BARE_LATEX_COMMAND_PATTERN)?.length ?? 0) >= 1;
    const hasMathStructure = /[_^{}=<>]/.test(trimmed);
    const startsLikeContinuation = /^[=+\-*/,&|\\]/.test(trimmed);

    return (startsLikeContinuation && (hasLatexCommands || hasMathStructure)) || (hasLatexCommands && hasMathStructure);
}

function _normalizeMarkdownMathForDisplayCore(markdown: string): string {
    if (!/[\\$]/.test(markdown)) {
        return markdown;
    }

    const lines = markdown.split(/\r?\n/);
    const output: string[] = [];

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const trimmedLine = line.trim();

        if (trimmedLine === '$') {
            const blockLines: string[] = [];
            let endIndex = index + 1;
            let foundClosingFence = false;

            while (endIndex < lines.length) {
                if (lines[endIndex].trim() === '$') {
                    foundClosingFence = true;
                    break;
                }

                blockLines.push(lines[endIndex]);
                endIndex += 1;
            }

            if (foundClosingFence && blockLines.length > 0) {
                const blockText = blockLines.join('\n').trim();
                const nextLine = lines[endIndex + 1]?.trim() ?? '';
                pushWrappedDisplayMathBlock(output, blockText, nextLine);
                index = endIndex;
                continue;
            }
        }

        const startMatch = line.match(/^\s*\\begin\{([^}]+)\}/);

        if (!startMatch || !shouldWrapEnvironment(startMatch[1])) {
            const previousSourceLine = lines[index - 1]?.trim() ?? '';
            const nextSourceLine = lines[index + 1]?.trim() ?? '';
            const alreadyWrappedSource = previousSourceLine === '$$' || previousSourceLine === '\\[' || nextSourceLine === '$$' || nextSourceLine === '\\]';

            if (!alreadyWrappedSource && looksLikeBareLatexMathLine(line)) {
                const blockLines = [line];
                let endIndex = index;

                while (endIndex + 1 < lines.length && looksLikeBareLatexContinuationLine(lines[endIndex + 1])) {
                    endIndex += 1;
                    blockLines.push(lines[endIndex]);
                }

                const blockText = blockLines.join('\n').trim();
                const nextLine = lines[endIndex + 1]?.trim() ?? '';
                pushWrappedDisplayMathBlock(output, blockText, nextLine);
                index = endIndex;
                continue;
            }

            output.push(line);
            continue;
        }

        const environment = startMatch[1];
        const blockLines = [line];
        let endIndex = index;
        let foundEnd = line.includes(`\\end{${environment}}`);

        while (!foundEnd && endIndex + 1 < lines.length) {
            endIndex += 1;
            blockLines.push(lines[endIndex]);
            foundEnd = lines[endIndex].includes(`\\end{${environment}}`);
        }

        if (!foundEnd) {
            output.push(line);
            continue;
        }

        const blockText = blockLines.join('\n').trim();
        const previousLine = output[output.length - 1]?.trim() ?? '';
        const nextLine = lines[endIndex + 1]?.trim() ?? '';

        if (isAlreadyWrappedBlock(previousLine, nextLine, blockText)) {
            output.push(...blockLines);
        } else {
            pushWrappedDisplayMathBlock(output, blockText, nextLine);
        }

        index = endIndex;
    }

    return output.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function normalizeMarkdownMathForDisplay(markdown: string): string {
    // 快速路径：不含 LaTeX 标记，直接返回原字符串（与内部实现保持一致）。
    if (!/[\\$]/.test(markdown)) {
        return markdown;
    }

    const cached = _normalizeMathCache.get(markdown);
    if (cached !== undefined) {
        return cached;
    }

    const result = _normalizeMarkdownMathForDisplayCore(markdown);

    // LRU 淘汰：超出容量时删除最早插入的条目。
    _normalizeMathCache.set(markdown, result);
    if (_normalizeMathCache.size > _NORMALIZE_MATH_CACHE_MAX) {
        const oldestKey = _normalizeMathCache.keys().next().value as string | undefined;
        if (oldestKey !== undefined) {
            _normalizeMathCache.delete(oldestKey);
        }
    }

    return result;
}
