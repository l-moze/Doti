'use client';

import { listProviderProfiles, type ProviderProfileRecord } from '@/lib/db';
import { useTranslationStore } from '@/lib/store';
import { useEffect, useState } from 'react';
import { subscribeSyncEvents } from '@/lib/sync-channel';
import { ChevronDown, Loader2, XCircle } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

interface ProviderDef {
    id: string;
    name: string;
    baseUrl: string;
    envKey: string;
    isOpenAICompat: boolean;
}

interface ModelsResponse {
    providers: Record<string, ProviderDef>;
    models: Record<string, string[]>;
    defaults: Record<string, string>;
    errors?: Record<string, string>;
}

const optionCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

interface ModelSelectorProps {
    mode?: 'translation' | 'assist';
    className?: string;
    compact?: boolean;
}

export function ModelSelector({ mode = 'translation', className, compact = false }: ModelSelectorProps) {
    const {
        providerId,
        model,
        assistProviderId,
        assistModel,
        setProvider,
        setAssistProvider,
    } = useTranslationStore(useShallow((state) => ({
        providerId: state.providerId,
        model: state.model,
        assistProviderId: state.assistProviderId,
        assistModel: state.assistModel,
        setProvider: state.setProvider,
        setAssistProvider: state.setAssistProvider,
    })));
    const [data, setData] = useState<ModelsResponse | null>(null);
    const [customProfiles, setCustomProfiles] = useState<ProviderProfileRecord[]>([]);
    const [loading, setLoading] = useState(true);

    // Fetch available services on mount.
    useEffect(() => {
        const load = async () => {
            try {
                const [response, nextProfiles] = await Promise.all([
                    fetch('/api/models').then((res) => {
                        if (!res.ok) {
                            throw new Error(`/api/models responded with ${res.status}`);
                        }
                        return res.json();
                    }),
                    listProviderProfiles(),
                ]);
                setData(response);
                setCustomProfiles(nextProfiles);
            } catch (loadError) {
                console.error('[ModelSelector] Failed to load available services:', loadError);
                setData(null);
            } finally {
                setLoading(false);
            }
        };

        void load();

        return subscribeSyncEvents((event) => {
            if (event.type === 'storage-updated') {
                void listProviderProfiles()
                    .then(setCustomProfiles)
                    .catch((profileError: unknown) => {
                        console.error('[ModelSelector] Failed to refresh provider profiles:', profileError);
                    });
            }
        });
    }, []);

    if (loading) {
        return (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 size={12} className="animate-spin" />
                <span>正在加载可用服务...</span>
            </div>
        );
    }

    if (!data) {
        return <div className="text-xs text-red-500">可用服务加载失败</div>;
    }

    const activeProviderId = mode === 'assist' ? assistProviderId : providerId;
    const activeModel = mode === 'assist' ? assistModel : model;
    const updateProvider = mode === 'assist' ? setAssistProvider : setProvider;

    const providers = Object.values(data.providers)
        .sort((a, b) => optionCollator.compare(a.name, b.name));

    // Build combined service options.
    const allOptions: Array<{ value: string; label: string; providerId: string; model: string }> = [];

    providers.forEach(provider => {
        const models = [...(data.models[provider.id] || [])]
            .sort((a, b) => optionCollator.compare(a, b));
        models.forEach(m => {
            allOptions.push({
                value: `${provider.id}::${m}`,
                label: `${provider.name} - ${m}`,
                providerId: provider.id,
                model: m
            });
        });
    });

    customProfiles
        .filter((profile) => {
            if (mode === 'assist') {
                return profile.capabilities.includes('assist') && profile.providerType !== 'deeplx';
            }
            return profile.capabilities.includes('translate');
        })
        .sort((a, b) => optionCollator.compare(a.name, b.name))
        .forEach((profile) => {
            allOptions.push({
                value: `custom:${profile.id}::${profile.model}`,
                label: `${profile.name} - ${profile.model}`,
                providerId: `custom:${profile.id}`,
                model: profile.model,
            });
        });

    allOptions.sort((a, b) => optionCollator.compare(a.label, b.label));

    const currentValue = `${activeProviderId}::${activeModel}`;
    const hasError = data.errors?.[activeProviderId];

    return (
        <div className={`relative inline-flex items-center ${className || ''}`}>
            <select
                value={currentValue}
                onChange={(e) => {
                    const selected = allOptions.find(opt => opt.value === e.target.value);
                    if (selected) {
                        updateProvider(selected.providerId, selected.model);
                    }
                }}
                className={`
                    text-xs border rounded appearance-none bg-white cursor-pointer 
                    hover:border-primary/50 transition-colors
                    ${compact ? 'min-w-[110px] max-w-[148px] px-2 py-1 pr-5' : 'min-w-[200px] px-2 py-1.5 pr-6'}
                    ${hasError ? 'border-amber-300' : 'border-muted'}
                `}
            >
                {allOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>
                        {opt.label}
                    </option>
                ))}
            </select>
            <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            {hasError && (
                <span
                    className="absolute -right-6 top-1/2 -translate-y-1/2 text-amber-500 cursor-help"
                    title={data.errors?.[activeProviderId]}
                >
                    <XCircle size={14} />
                </span>
            )}
        </div>
    );
}
