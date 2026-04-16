import { NextRequest, NextResponse } from "next/server";
import { createLLMClient } from "@/lib/llm/client";
import type { Term } from "@/lib/agent/memory/terminology-store";

type AssistAction =
    | "explain"
    | "summarize"
    | "rewrite"
    | "extract"
    | "qa";

type AssistHistoryTurn = {
    prompt: string;
    response: string;
    selectionText?: string;
    scope?: "selection" | "document";
};

function buildAssistPrompt(input: {
    action: AssistAction;
    selection: string;
    documentText?: string;
    question?: string;
    targetLang?: string;
    extraTerms?: Term[];
    history?: AssistHistoryTurn[];
}): string {
    const glossary = input.extraTerms?.length
        ? `<glossary>
| Source | Target |
|--------|--------|
${input.extraTerms.map((term) => `| ${term.source} | ${term.target} |`).join("\n")}
</glossary>`
        : "";

    const documentContext = input.documentText
        ? `<document_context>
${input.documentText.slice(0, 12000)}
</document_context>`
        : "";

    const conversationHistory = input.history?.length
        ? `<conversation_history>
${input.history.slice(-6).map((turn, index) => `
<turn index="${index + 1}" scope="${turn.scope || 'document'}">
<user_prompt>${turn.prompt}</user_prompt>
${turn.selectionText ? `<selection>${turn.selectionText}</selection>` : ""}
<assistant_response>${turn.response}</assistant_response>
</turn>`).join("\n")}
</conversation_history>`
        : "";

    const actionInstructions: Record<AssistAction, string> = {
        explain: `Explain the selected content in clear ${input.targetLang || "Chinese"} for a technically literate reader.`,
        summarize: `Summarize the selected content in concise ${input.targetLang || "Chinese"} bullet points.`,
        rewrite: `Rewrite the selected content in smoother ${input.targetLang || "Chinese"} while preserving meaning and technical accuracy.`,
        extract: `Extract the key claims, methods, and conclusions from the selected content in ${input.targetLang || "Chinese"}.`,
        qa: `Answer the user's question about the selected or full-document content in ${input.targetLang || "Chinese"}.`,
    };

    const questionBlock = input.question
        ? `<question>${input.question}</question>`
        : "";

    return `
<role>You are an academic reading assistant helping a user understand and work with a translated paper.</role>

<instruction>
${actionInstructions[input.action]}
- Use the glossary when relevant.
- Preserve citations, section names, formulas, and code references when useful.
- If the answer depends on document context, use the provided context.
- Maintain continuity with the conversation history when it is provided.
- Be concise but useful.
</instruction>

${glossary}
${documentContext}
${conversationHistory}
${questionBlock}

<selection>
${input.selection}
</selection>
`;
}

export async function POST(request: NextRequest) {
    try {
        const {
            action,
            selection,
            documentText,
            question,
            history,
            providerId,
            model,
            providerProfile,
            targetLang,
            extraTerms,
        } = await request.json();

        if (!selection && !documentText) {
            return NextResponse.json({ error: "No content provided" }, { status: 400 });
        }

        const client = createLLMClient(
            providerId || "gemini",
            model || "gemini-2.5-flash",
            providerProfile?.providerType ? providerProfile : undefined
        );
        const prompt = buildAssistPrompt({
            action: (action || "qa") as AssistAction,
            selection: selection || documentText || "",
            documentText,
            question,
            targetLang,
            extraTerms: Array.isArray(extraTerms) ? extraTerms : [],
            history: Array.isArray(history) ? history : [],
        });

        let responseText = "";
        for await (const chunk of client.generateStream(prompt)) {
            responseText += chunk;
        }

        return NextResponse.json({ text: responseText.trim() });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
