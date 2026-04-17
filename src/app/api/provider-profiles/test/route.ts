import { NextRequest, NextResponse } from "next/server";
import { DeepLXClient } from "@/lib/deeplx-client";
import { createLLMClient, type RuntimeProviderProfile } from "@/lib/llm/client";

export async function POST(request: NextRequest) {
    try {
        const { profile } = await request.json();
        const runtimeProfile = profile as RuntimeProviderProfile | undefined;

        if (!runtimeProfile?.providerType || !runtimeProfile.baseUrl) {
            return NextResponse.json({ error: "Invalid provider profile" }, { status: 400 });
        }

        if (runtimeProfile.providerType === "deeplx") {
            const client = new DeepLXClient(runtimeProfile);
            const translated = await client.translate("Hello world.", "Chinese", {
                sourceLang: runtimeProfile.sourceLang,
                glossaryId: runtimeProfile.glossaryId,
            });
            return NextResponse.json({
                ok: true,
                message: "DeepLX 测试成功",
                preview: translated.slice(0, 120),
            });
        }

        const client = createLLMClient("openai", runtimeProfile.model || "gpt-4o-mini", runtimeProfile);
        let preview = "";
        for await (const chunk of client.generateStream("Reply with exactly: OK")) {
            preview += chunk;
            if (preview.length >= 32) break;
        }

        return NextResponse.json({
            ok: true,
            message: "OpenAI-compatible 测试成功",
            preview: preview.trim() || "OK",
        });
    } catch (error: unknown) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Provider test failed" },
            { status: 500 }
        );
    }
}
