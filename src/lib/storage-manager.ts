export interface StorageEstimateSnapshot {
    quota?: number;
    usage?: number;
    usageRatio?: number;
}

function getBrowserStorage(): StorageManager | null {
    if (typeof navigator === 'undefined' || !('storage' in navigator)) {
        return null;
    }

    return navigator.storage;
}

export async function estimateStorageUsage(): Promise<StorageEstimateSnapshot | null> {
    const storage = getBrowserStorage();
    if (!storage?.estimate) return null;

    const estimate = await storage.estimate();
    const usageRatio = estimate.quota && estimate.usage
        ? estimate.usage / estimate.quota
        : undefined;

    return {
        quota: estimate.quota,
        usage: estimate.usage,
        usageRatio,
    };
}

export async function requestPersistentStorage(): Promise<boolean> {
    const storage = getBrowserStorage();
    if (!storage?.persist) return false;
    return storage.persist();
}

export async function isPersistentStorageGranted(): Promise<boolean> {
    const storage = getBrowserStorage();
    if (!storage?.persisted) return false;
    return storage.persisted();
}
