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

function normalizeEnvironmentName(environment: string): string {
    return environment.trim().replace(/\*$/, '');
}

function shouldWrapEnvironment(environment: string): boolean {
    return DISPLAY_MATH_ENVIRONMENTS.has(normalizeEnvironmentName(environment));
}

export function normalizeMarkdownMathForDisplay(markdown: string): string {
    if (!markdown.includes('\\begin{')) {
        return markdown;
    }

    const lines = markdown.split(/\r?\n/);
    const output: string[] = [];

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const startMatch = line.match(/^\s*\\begin\{([^}]+)\}/);

        if (!startMatch || !shouldWrapEnvironment(startMatch[1])) {
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
        const alreadyWrapped =
            blockText.startsWith('$$') ||
            blockText.startsWith('\\[') ||
            previousLine === '$$' ||
            previousLine === '\\[' ||
            nextLine === '$$' ||
            nextLine === '\\]';

        if (!alreadyWrapped) {
            if (output.length > 0 && output[output.length - 1].trim() !== '') {
                output.push('');
            }

            output.push('$$');
            output.push(blockText);
            output.push('$$');

            if (nextLine !== '') {
                output.push('');
            }
        } else {
            output.push(...blockLines);
        }

        index = endIndex;
    }

    return output.join('\n').replace(/\n{3,}/g, '\n\n');
}
