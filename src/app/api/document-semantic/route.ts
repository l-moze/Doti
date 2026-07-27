import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { buildRawMediaPrefix } from '@/lib/media-access';
import { buildDocumentSemanticProjection } from '@/lib/document-semantic';
import {
    directoryExists,
    findUploadArtifactPaths,
    readJsonFileIfExists,
    readTextFileIfExists,
    resolveUploadDir,
} from '@/lib/upload-artifacts';

type DocumentSemanticRequest = {
    fileHash?: string;
    sourceMarkdown?: string;
};

const MAX_PROJECTION_CACHE_ENTRIES = 32;

const projectionCache = new Map<string, {
    projection: ReturnType<typeof buildDocumentSemanticProjection>;
    markdownSignature: string | null;
}>();

function pruneProjectionCache(): void {
    while (projectionCache.size > MAX_PROJECTION_CACHE_ENTRIES) {
        const oldestKey = projectionCache.keys().next().value;
        if (oldestKey === undefined) return;
        projectionCache.delete(oldestKey);
    }
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json() as DocumentSemanticRequest;
        const fileHash = body.fileHash?.trim();
        const markdownSignature = body.sourceMarkdown?.trim() || '';
        const uploadDir = fileHash ? resolveUploadDir(fileHash) : null;

        if (!fileHash || !uploadDir || !(await directoryExists(uploadDir))) {
            return NextResponse.json({ error: 'Document not found.' }, { status: 404 });
        }

        const cachedEntry = projectionCache.get(fileHash);
        if (cachedEntry) {
            const isStructuredProjection = cachedEntry.projection.source !== 'markdown';
            if (isStructuredProjection || cachedEntry.markdownSignature === markdownSignature) {
                return NextResponse.json(cachedEntry.projection, {
                    headers: {
                        'Cache-Control': 'no-store',
                    },
                });
            }
        }

        const { contentListRelativePath, layoutJsonRelativePath, markdownRelativePath } =
            await findUploadArtifactPaths(uploadDir);

        const [contentList, layout, markdownFromDisk] = await Promise.all([
            readJsonFileIfExists(contentListRelativePath ? path.join(uploadDir, contentListRelativePath) : null),
            readJsonFileIfExists(layoutJsonRelativePath ? path.join(uploadDir, layoutJsonRelativePath) : null),
            readTextFileIfExists(markdownRelativePath ? path.join(uploadDir, markdownRelativePath) : null),
        ]);
        const markdown = body.sourceMarkdown || markdownFromDisk;

        const projection = buildDocumentSemanticProjection({
            contentList,
            layout,
            markdown,
            assetPathPrefix: buildRawMediaPrefix(fileHash),
        });
        projectionCache.delete(fileHash);
        projectionCache.set(fileHash, {
            projection,
            markdownSignature: projection.source === 'markdown' ? markdown.trim() : null,
        });
        pruneProjectionCache();

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
