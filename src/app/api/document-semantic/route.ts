import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { buildDocumentSemanticProjection } from '@/lib/document-semantic';
import { findPreferredRelativeFilePath } from '@/lib/upload-artifacts';

type DocumentSemanticRequest = {
    fileHash?: string;
    sourceMarkdown?: string;
};

function readJsonFile(filePath: string | null): unknown {
    if (!filePath || !fs.existsSync(filePath)) return null;

    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (error) {
        console.warn('[document-semantic] Failed to parse JSON:', filePath, error);
        return null;
    }
}

function readTextFile(filePath: string | null): string {
    if (!filePath || !fs.existsSync(filePath)) return '';

    try {
        return fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
        console.warn('[document-semantic] Failed to read text:', filePath, error);
        return '';
    }
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json() as DocumentSemanticRequest;
        const fileHash = body.fileHash?.trim();
        const uploadsRoot = path.join(process.cwd(), 'uploads');
        const uploadDir = fileHash ? path.join(uploadsRoot, fileHash) : null;

        if (!fileHash || !uploadDir || !fs.existsSync(uploadDir)) {
            return NextResponse.json({ error: 'Document not found.' }, { status: 404 });
        }

        const contentListRelativePath = findPreferredRelativeFilePath(
            uploadDir,
            (relativePath, fileName) => fileName === 'content_list_v2.json' || relativePath.endsWith('/content_list_v2.json')
        );
        const layoutRelativePath = findPreferredRelativeFilePath(
            uploadDir,
            (relativePath, fileName) => fileName === 'layout.json' || relativePath.endsWith('/layout.json')
        );
        const markdownRelativePath = findPreferredRelativeFilePath(
            uploadDir,
            (relativePath, fileName) => fileName === 'full.md' || relativePath.endsWith('/full.md')
        );

        const contentList = readJsonFile(contentListRelativePath ? path.join(uploadDir, contentListRelativePath) : null);
        const layout = readJsonFile(layoutRelativePath ? path.join(uploadDir, layoutRelativePath) : null);
        const markdown = body.sourceMarkdown || readTextFile(markdownRelativePath ? path.join(uploadDir, markdownRelativePath) : null);

        const projection = buildDocumentSemanticProjection({
            contentList,
            layout,
            markdown,
            assetPathPrefix: `/api/media/${fileHash}`,
        });

        return NextResponse.json(projection, {
            headers: {
                'Cache-Control': 'no-store',
            },
        });
    } catch (error) {
        console.error('[document-semantic] Request failed:', error);
        return NextResponse.json({ error: 'Failed to build document semantic projection.' }, { status: 500 });
    }
}
