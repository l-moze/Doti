export type SyncEvent =
    | { type: 'annotation-updated'; fileHash?: string; at: number }
    | { type: 'conversation-updated'; fileHash?: string; at: number }
    | { type: 'glossary-updated'; at: number }
    | { type: 'storage-updated'; at: number };

export type SyncEventInput =
    | { type: 'annotation-updated'; fileHash?: string }
    | { type: 'conversation-updated'; fileHash?: string }
    | { type: 'glossary-updated' }
    | { type: 'storage-updated' };

const CHANNEL_NAME = 'doti-sync';

let sharedChannel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
    if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
        return null;
    }

    if (!sharedChannel) {
        sharedChannel = new BroadcastChannel(CHANNEL_NAME);
    }

    return sharedChannel;
}

export function emitSyncEvent(event: SyncEventInput): void {
    const channel = getChannel();
    if (!channel) return;
    channel.postMessage({ ...event, at: Date.now() });
}

export function subscribeSyncEvents(handler: (event: SyncEvent) => void): () => void {
    const channel = getChannel();
    if (!channel) return () => undefined;

    const listener = (message: MessageEvent<SyncEvent>) => {
        if (message.data) {
            handler(message.data);
        }
    };

    channel.addEventListener('message', listener);

    return () => {
        channel.removeEventListener('message', listener);
    };
}
