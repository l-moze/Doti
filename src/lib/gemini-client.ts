import { GoogleGenAI } from "@google/genai";

function getErrorStatus(error: unknown): number | undefined {
    if (typeof error === "object" && error !== null && "status" in error) {
        const status = (error as { status?: unknown }).status;
        return typeof status === "number" ? status : undefined;
    }
    return undefined;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "";
}

export class GeminiClient {
    private ai: GoogleGenAI;
    private modelName: string;

    constructor(apiKey: string, modelName: string = "gemini-2.5-flash") {
        this.ai = new GoogleGenAI({ apiKey });
        this.modelName = modelName;
    }

    /**
     * Generates content using a raw prompt string, returning a stream.
     * This is the low-level method used by other modules.
     */
    async generateContentStream(prompt: string) {
        let retries = 0;
        const maxRetries = 5; // Increased retries for stability

        while (true) {
            try {
                const response = await this.ai.models.generateContentStream({
                    model: this.modelName,
                    contents: prompt,
                });
                return response;
            } catch (error: unknown) {
                const status = getErrorStatus(error);
                const message = getErrorMessage(error);
                const isRateLimit = status === 429 || message.includes('429') || message.includes("Quota exceeded");
                const isOverloaded = status === 503 || message.includes('503') || message.includes('overloaded');
                const isNetworkError = message.includes('fetch failed') || message.includes('network');

                if (isRateLimit) {
                    console.error("Rate limit exceeded. Not retrying.");
                    throw new Error("API 配额已用完。请稍后再试，或检查您的 Google AI 配额设置。");
                }

                if ((isNetworkError || isOverloaded) && retries < maxRetries) {
                    retries++;
                    const delaySeconds = Math.min(2 * Math.pow(2, retries), 15); // Cap at 15s
                    const errorType = isOverloaded ? "Model Overloaded (503)" : "Network Error";
                    console.log(`${errorType}. Retrying in ${delaySeconds}s... (Attempt ${retries}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
                    continue;
                }

                console.error("Gemini API Error:", error);
                throw error;
            }
        }
    }

    async translateStream(text: string, targetLang: string = "Chinese") {
        const prompt = `
**Character Setting:**
You are a professional academic translation expert proficient in both English and ${targetLang}, specializing in the precise translation and formatting of research papers, technical reports, and academic documents. You are familiar with Markdown standards and HTML anchor compatibility, ensuring that **hyperlink anchors in the final output are clickable and functional**.

**Task Objective:**
Translate the provided Markdown content into a **high-quality ${targetLang} Markdown document**, **including both the main text and appendices**, and ensure that all references (such as figures, tables, formulas, appendices, footnotes, etc.) can be properly navigated.

### Translation and Formatting Requirements

#### 1. Structure Preservation
- Use Markdown headings (\`#\`, \`##\`, \`###\`) to precisely correspond to the original document's section structure.
- Maintain the original layout of paragraphs, lists, and subheadings.
- Preserve the logical hierarchy and numbering of the original text.

#### 2. Formulas and Symbols
- Keep all formulas in their original LaTeX format:
  - Inline formulas use \`$...\$\`.
  - Standalone formulas use \`$$...$$\`.
- Do not translate or modify variable names, function names, or formula structures.

#### 3. No Translation / Keep Original
- **References / Bibliography**: Do NOT translate the reference list.
- **Code Blocks**: Do NOT translate content inside \`\`\`...\`\`\`.
- **Figures and Tables Content**: Do NOT translate the content text inside figures and tables.
- **Proper Nouns**: Model names, algorithm names, code, and instructions should remain in their original English form.

#### 4. Main Text Translation Style
- Translations should be **professional, accurate, and natural-sounding**, adhering to academic conventions.
- All technical terms must use established translations in ${targetLang}.

#### 5. Figures, Tables, Footnotes, and Hyperlinks
- **Retain all reference relationships.**
- For references to figures, tables, and sections, use a **dual-anchor format** compatible with Markdown:
  Example:
  As shown in [Figure 1](#fig1), we illustrate the reasoning path.
  **<a id="fig1">Figure 1</a>: Diagram of the method's reasoning.**

Source Markdown:
${text}
`;

        // Reuse the core streaming logic
        return this.generateContentStream(prompt);
    }
}

