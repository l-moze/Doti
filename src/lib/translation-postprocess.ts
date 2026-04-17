const INLINE_SPACE = "[ \\t\\u00A0]+";

function normalizeChineseSpacing(markdown: string): string {
    return markdown
        .replace(new RegExp(`([\\p{Script=Han}])${INLINE_SPACE}([\\p{Script=Han}])`, "gu"), "$1$2")
        .replace(new RegExp(`([\\p{Script=Han}])${INLINE_SPACE}([，。！？；：、）》】〉])`, "gu"), "$1$2")
        .replace(new RegExp(`([（《【〈「『])${INLINE_SPACE}([\\p{Script=Han}])`, "gu"), "$1$2")
        .replace(new RegExp(`([\\p{Script=Han}])${INLINE_SPACE}([（《【〈「『])`, "gu"), "$1$2")
        .replace(new RegExp(`([，。！？；：、）》】〉])${INLINE_SPACE}([\\p{Script=Han}])`, "gu"), "$1$2")
        .replace(new RegExp(`${INLINE_SPACE}([，。！？；：、])`, "gu"), "$1");
}

export function normalizeTranslationTypography(markdown: string, targetLang: string): string {
    const normalizedTargetLang = targetLang.trim().toLowerCase();

    if (normalizedTargetLang === "chinese" || normalizedTargetLang === "zh") {
        return normalizeChineseSpacing(markdown);
    }

    return markdown;
}
