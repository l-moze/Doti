import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

export async function GET() {
    try {
        const apiKey = process.env.GOOGLE_API_KEY;
        if (!apiKey) {
            return NextResponse.json({ error: "No API Key found" }, { status: 500 });
        }
        const genAI = new GoogleGenerativeAI(apiKey);
        genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); // Dummy init to get client

        // There isn't a direct "listModels" on the instance in some SDK versions, but let's try access the model manager if available
        // Actually, checking documentation, the SDK has `getGenerativeModel` but listing might be different.
        // Wait, version 0.24.1 might not have a helper for listing models? 
        // Failing that, we can just try to fetch the list via REST if the SDK doesn't expose it easily.

        // Correct way in recent SDK:
        // import { GoogleGenerativeAI } from "@google/generative-ai";
        // const genAI = new GoogleGenerativeAI(API_KEY);
        // But listing models is often a separate API call not always wrapped? 

        // Let's try to just hit the REST API directly to list models to be sure.
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        const data = await response.json();

        return NextResponse.json(data);
    } catch (error: unknown) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 }
        );
    }
}
