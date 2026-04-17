import Dexie, { type Table } from 'dexie';

export type PersistedTaskStatus = 'idle' | 'uploading' | 'parsing' | 'parsed' | 'translating' | 'completed' | 'error';

export interface DocumentSnapshotRecord {
    fileHash: string;
    fileName: string;
    status: PersistedTaskStatus;
    progress: number;
    updatedAt: number;
    targetLang?: string;
    sourceMarkdown?: string;
    rawSourceMarkdown?: string;
    polishedSourceMarkdown?: string;
    targetMarkdown?: string;
    layoutJsonUrl?: string | null;
    lastOpenedAt?: number;
}

export interface AnnotationAnchorRecord {
    semanticBlockId?: string;
    quote?: {
        exact: string;
        prefix?: string;
        suffix?: string;
    };
    position?: {
        start: number;
        end: number;
    };
}

export interface AnnotationRecord {
    id: string;
    documentId: string;
    fileHash: string;
    targetLang?: string;
    selectedText: string;
    anchor: AnnotationAnchorRecord;
    note: string;
    tags?: string[];
    createdAt: number;
    updatedAt: number;
}

export interface GlossaryRecord {
    id: string;
    source: string;
    target: string;
    category?: string;
    scope: 'built-in' | 'user';
    enabled: boolean;
    updatedAt: number;
}

export type ProviderCapability = 'translate' | 'assist';
export type ProviderProfileType = 'openai-compatible' | 'deeplx';

export interface ProviderProfileRecord {
    id: string;
    name: string;
    providerType: ProviderProfileType;
    baseUrl: string;
    apiKey?: string;
    model: string;
    sourceLang?: string;
    glossaryId?: string;
    capabilities: ProviderCapability[];
    updatedAt: number;
}

export interface SessionRecord {
    id: string;
    fileHash: string;
    fileName: string;
    status: PersistedTaskStatus;
    progress: number;
    targetLang: string;
    providerId: string;
    model: string;
    updatedAt: number;
}

export interface ConversationRecord {
    id: string;
    fileHash: string;
    sessionId?: string;
    targetLang?: string;
    scope: 'selection' | 'document';
    prompt: string;
    selectionText?: string;
    contextLabel?: string;
    contextTab?: 'translation' | 'source';
    contextAnchor?: AnnotationAnchorRecord;
    response: string;
    providerId: string;
    model: string;
    createdAt: number;
}

class PdfTranslatorDB extends Dexie {
    documents!: Table<DocumentSnapshotRecord, string>;
    annotations!: Table<AnnotationRecord, string>;
    glossary!: Table<GlossaryRecord, string>;
    sessions!: Table<SessionRecord, string>;
    conversations!: Table<ConversationRecord, string>;
    providerProfiles!: Table<ProviderProfileRecord, string>;

    constructor() {
        super('doti');

        this.version(1).stores({
            documents: 'fileHash, updatedAt, status, targetLang, lastOpenedAt',
            annotations: 'id, documentId, fileHash, updatedAt, *tags, [fileHash+updatedAt]',
            glossary: 'id, source, target, category, scope, enabled, updatedAt',
            sessions: 'id, fileHash, updatedAt, status, [fileHash+updatedAt]',
        });

        this.version(2).stores({
            documents: 'fileHash, updatedAt, status, targetLang, lastOpenedAt',
            annotations: 'id, documentId, fileHash, updatedAt, *tags, [fileHash+updatedAt]',
            glossary: 'id, source, target, category, scope, enabled, updatedAt',
            sessions: 'id, fileHash, updatedAt, status, [fileHash+updatedAt]',
            conversations: 'id, fileHash, createdAt, scope, [fileHash+createdAt]',
        });

        this.version(3).stores({
            documents: 'fileHash, updatedAt, status, targetLang, lastOpenedAt',
            annotations: 'id, documentId, fileHash, updatedAt, *tags, [fileHash+updatedAt]',
            glossary: 'id, source, target, category, scope, enabled, updatedAt',
            sessions: 'id, fileHash, updatedAt, status, [fileHash+updatedAt]',
            conversations: 'id, fileHash, createdAt, scope, [fileHash+createdAt]',
            providerProfiles: 'id, name, providerType, updatedAt, *capabilities',
        });

        this.version(4).stores({
            documents: 'fileHash, updatedAt, status, targetLang, lastOpenedAt',
            annotations: 'id, documentId, fileHash, updatedAt, *tags, [fileHash+updatedAt]',
            glossary: 'id, source, target, category, scope, enabled, updatedAt',
            sessions: 'id, fileHash, updatedAt, status, [fileHash+updatedAt]',
            conversations: 'id, fileHash, sessionId, createdAt, scope, [fileHash+createdAt], [fileHash+sessionId+createdAt]',
            providerProfiles: 'id, name, providerType, updatedAt, *capabilities',
        });
    }
}

let dbInstance: PdfTranslatorDB | null = null;

function getClientDb(): PdfTranslatorDB | null {
    if (typeof window === 'undefined') return null;
    if (!dbInstance) {
        dbInstance = new PdfTranslatorDB();
    }
    return dbInstance;
}

export async function saveDocumentSnapshot(
    input: DocumentSnapshotRecord
): Promise<void> {
    const db = getClientDb();
    if (!db) return;

    const existing = await db.documents.get(input.fileHash);
    const nextRecord: DocumentSnapshotRecord = existing
        ? { ...existing, ...input }
        : { ...input };

    if (input.sourceMarkdown !== undefined) nextRecord.sourceMarkdown = input.sourceMarkdown;
    if (input.rawSourceMarkdown !== undefined) nextRecord.rawSourceMarkdown = input.rawSourceMarkdown;
    if (input.polishedSourceMarkdown !== undefined) nextRecord.polishedSourceMarkdown = input.polishedSourceMarkdown;
    if (input.targetMarkdown !== undefined) nextRecord.targetMarkdown = input.targetMarkdown;
    if (input.layoutJsonUrl !== undefined) nextRecord.layoutJsonUrl = input.layoutJsonUrl;
    if (input.lastOpenedAt !== undefined) nextRecord.lastOpenedAt = input.lastOpenedAt;

    await db.documents.put(nextRecord);
}

export async function getDocumentSnapshot(fileHash: string): Promise<DocumentSnapshotRecord | undefined> {
    const db = getClientDb();
    if (!db) return undefined;
    return db.documents.get(fileHash);
}

export async function listDocumentHistorySnapshots(limit = 20): Promise<DocumentSnapshotRecord[]> {
    const db = getClientDb();
    if (!db) return [];

    return db.documents
        .orderBy('updatedAt')
        .reverse()
        .limit(limit)
        .toArray();
}

export async function markDocumentOpened(fileHash: string): Promise<void> {
    const db = getClientDb();
    if (!db) return;

    const existing = await db.documents.get(fileHash);
    if (!existing) return;

    await db.documents.put({
        ...existing,
        lastOpenedAt: Date.now(),
    });
}

export async function saveSessionSnapshot(input: SessionRecord): Promise<void> {
    const db = getClientDb();
    if (!db) return;
    await db.sessions.put(input);
}

export async function getLatestSession(fileHash: string): Promise<SessionRecord | undefined> {
    const db = getClientDb();
    if (!db) return undefined;

    const sessions = await db.sessions
        .where('fileHash')
        .equals(fileHash)
        .sortBy('updatedAt');

    return sessions.at(-1);
}

export async function saveAnnotation(record: AnnotationRecord): Promise<void> {
    const db = getClientDb();
    if (!db) return;
    await db.annotations.put(record);
}

export async function listAnnotationsForDocument(fileHash: string): Promise<AnnotationRecord[]> {
    const db = getClientDb();
    if (!db) return [];

    return db.annotations
        .where('fileHash')
        .equals(fileHash)
        .reverse()
        .sortBy('updatedAt');
}

export async function saveGlossaryRecord(record: GlossaryRecord): Promise<void> {
    const db = getClientDb();
    if (!db) return;
    await db.glossary.put(record);
}

export async function listUserGlossaryRecords(): Promise<GlossaryRecord[]> {
    const db = getClientDb();
    if (!db) return [];

    return db.glossary
        .where('scope')
        .equals('user')
        .toArray();
}

export async function deleteGlossaryRecord(id: string): Promise<void> {
    const db = getClientDb();
    if (!db) return;
    await db.glossary.delete(id);
}

export async function deleteAnnotationRecord(id: string): Promise<void> {
    const db = getClientDb();
    if (!db) return;
    await db.annotations.delete(id);
}

export async function saveConversation(record: ConversationRecord): Promise<void> {
    const db = getClientDb();
    if (!db) return;
    await db.conversations.put(record);
}

export async function listConversationsForDocument(fileHash: string): Promise<ConversationRecord[]> {
    const db = getClientDb();
    if (!db) return [];

    const results = await db.conversations
        .where('fileHash')
        .equals(fileHash)
        .sortBy('createdAt');

    return results.reverse();
}

export async function deleteConversationRecord(id: string): Promise<void> {
    const db = getClientDb();
    if (!db) return;
    await db.conversations.delete(id);
}

export async function clearDocumentSnapshots(): Promise<void> {
    const db = getClientDb();
    if (!db) return;
    await db.documents.clear();
}

export async function clearSessionSnapshots(): Promise<void> {
    const db = getClientDb();
    if (!db) return;
    await db.sessions.clear();
}

export async function clearAnnotationRecords(): Promise<void> {
    const db = getClientDb();
    if (!db) return;
    await db.annotations.clear();
}

export async function clearGlossaryRecords(): Promise<void> {
    const db = getClientDb();
    if (!db) return;
    await db.glossary.clear();
}

export async function clearConversationRecords(): Promise<void> {
    const db = getClientDb();
    if (!db) return;
    await db.conversations.clear();
}

export async function saveProviderProfile(record: ProviderProfileRecord): Promise<void> {
    const db = getClientDb();
    if (!db) return;
    await db.providerProfiles.put(record);
}

export async function listProviderProfiles(): Promise<ProviderProfileRecord[]> {
    const db = getClientDb();
    if (!db) return [];
    return db.providerProfiles.orderBy('updatedAt').reverse().toArray();
}

export async function getProviderProfile(id: string): Promise<ProviderProfileRecord | undefined> {
    const db = getClientDb();
    if (!db) return undefined;
    return db.providerProfiles.get(id);
}

export async function deleteProviderProfile(id: string): Promise<void> {
    const db = getClientDb();
    if (!db) return;
    await db.providerProfiles.delete(id);
}

export async function clearProviderProfiles(): Promise<void> {
    const db = getClientDb();
    if (!db) return;
    await db.providerProfiles.clear();
}
