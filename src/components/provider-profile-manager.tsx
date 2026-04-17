'use client';

import { useEffect, useMemo, useState } from 'react';
import { ModalShell } from '@/components/modal-shell';
import {
    deleteProviderProfile,
    listProviderProfiles,
    saveProviderProfile,
    type ProviderCapability,
    type ProviderProfileRecord,
    type ProviderProfileType,
} from '@/lib/db';
import { emitSyncEvent, subscribeSyncEvents } from '@/lib/sync-channel';
import { Loader2, Plus, Save, Trash2 } from 'lucide-react';

interface ProviderProfileManagerProps {
    open: boolean;
    onClose: () => void;
}

const EMPTY_DRAFT = {
    name: '',
    providerType: 'openai-compatible' as ProviderProfileType,
    baseUrl: '',
    apiKey: '',
    model: '',
    sourceLang: '',
    glossaryId: '',
    capabilities: ['translate', 'assist'] as ProviderCapability[],
};

export function ProviderProfileManager({ open, onClose }: ProviderProfileManagerProps) {
    const [profiles, setProfiles] = useState<ProviderProfileRecord[]>([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [testMessage, setTestMessage] = useState<string | null>(null);
    const [draft, setDraft] = useState(EMPTY_DRAFT);

    const capabilityDescription = useMemo(() => {
        return draft.providerType === 'deeplx'
            ? 'DeepLX 只参与翻译链路，不会出现在 AI 对话模型列表。兼容免费 /translate，也兼容官方 /v2/translate。若使用 DeepL 兼容 glossary，请在下方额外填写 glossary ID 与 source_lang。'
            : 'OpenAI-compatible provider 可用于翻译、AI 辅助，或两者同时使用。';
    }, [draft.providerType]);

    const loadProfiles = async () => {
        setLoading(true);
        try {
            const nextProfiles = await listProviderProfiles();
            setProfiles(nextProfiles);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (!open) return;
        void loadProfiles();
    }, [open]);

    useEffect(() => {
        return subscribeSyncEvents((event) => {
            if (event.type === 'storage-updated') {
                void loadProfiles();
            }
        });
    }, []);

    const toggleCapability = (capability: ProviderCapability) => {
        setDraft((current) => {
            const hasCapability = current.capabilities.includes(capability);
            const nextCapabilities = hasCapability
                ? current.capabilities.filter((item) => item !== capability)
                : [...current.capabilities, capability];

            return {
                ...current,
                capabilities: current.providerType === 'deeplx'
                    ? ['translate']
                    : nextCapabilities,
            };
        });
    };

    const resetDraft = () => {
        setDraft(EMPTY_DRAFT);
        setError(null);
        setTestMessage(null);
    };

    const saveDraft = async () => {
        if (!draft.name.trim() || !draft.baseUrl.trim() || !draft.model.trim()) {
            setError('名称、Endpoint 和默认模型不能为空。');
            return;
        }

        if (draft.providerType === 'deeplx' && draft.glossaryId.trim() && !draft.sourceLang.trim()) {
            setError('启用 DeepL glossary 时需要填写 source_lang，例如 EN。');
            return;
        }

        if (draft.providerType !== 'deeplx' && draft.capabilities.length === 0) {
            setError('至少选择一个能力范围。');
            return;
        }

        setSaving(true);
        setError(null);
        setTestMessage(null);

        try {
            await saveProviderProfile({
                id: crypto.randomUUID(),
                name: draft.name.trim(),
                providerType: draft.providerType,
                baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''),
                apiKey: draft.apiKey.trim() || undefined,
                model: draft.model.trim(),
                sourceLang: draft.sourceLang.trim() || undefined,
                glossaryId: draft.glossaryId.trim() || undefined,
                capabilities: draft.providerType === 'deeplx' ? ['translate'] : draft.capabilities,
                updatedAt: Date.now(),
            });
            emitSyncEvent({ type: 'storage-updated' });
            await loadProfiles();
            resetDraft();
        } finally {
            setSaving(false);
        }
    };

    const testDraft = async () => {
        if (!draft.baseUrl.trim()) {
            setError('测试前请先填写 Endpoint。');
            return;
        }

        setTesting(true);
        setError(null);
        setTestMessage(null);

        try {
            const response = await fetch('/api/provider-profiles/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    profile: {
                        providerType: draft.providerType,
                        baseUrl: draft.baseUrl.trim(),
                        apiKey: draft.apiKey.trim() || undefined,
                        model: draft.model.trim() || undefined,
                        sourceLang: draft.sourceLang.trim() || undefined,
                        glossaryId: draft.glossaryId.trim() || undefined,
                    },
                }),
            });

            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || '测试失败');
            }

            setTestMessage(data.preview ? `${data.message} · ${data.preview}` : data.message);
        } catch (testError) {
            setError(testError instanceof Error ? testError.message : '测试失败');
        } finally {
            setTesting(false);
        }
    };

    const removeProfile = async (id: string) => {
        await deleteProviderProfile(id);
        emitSyncEvent({ type: 'storage-updated' });
        await loadProfiles();
    };

    return (
        <ModalShell
            open={open}
            onClose={onClose}
            title="模型配置"
            description="添加 OpenAI-compatible 或 DeepLX 端点，后续可直接在翻译模型 / AI 模型选择器中使用。"
            widthClassName="max-w-5xl"
        >
            <div className="grid gap-6 p-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                <section className="rounded-3xl border border-slate-200 bg-slate-50/70 p-5">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <h3 className="text-base font-semibold text-slate-900">已保存的 Provider</h3>
                            <p className="mt-1 text-sm text-slate-500">这里的配置只保存在本机浏览器中，不会写入服务端环境变量。</p>
                        </div>
                        {loading ? <Loader2 size={16} className="animate-spin text-slate-400" /> : null}
                    </div>

                    <div className="mt-4 space-y-3">
                        {profiles.length > 0 ? profiles.map((profile) => (
                            <article key={profile.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <div className="text-sm font-medium text-slate-900">{profile.name}</div>
                                        <div className="mt-1 break-all text-xs text-slate-500">{profile.baseUrl}</div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => void removeProfile(profile.id)}
                                        className="rounded-full border border-slate-200 p-2 text-slate-500 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                                        aria-label={`Delete ${profile.name}`}
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                                    <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">{profile.providerType}</span>
                                    <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">{profile.model}</span>
                                    {profile.providerType === 'deeplx' && profile.glossaryId ? (
                                        <span className="rounded-full bg-blue-50 px-3 py-1 text-blue-700">
                                            glossary · {profile.sourceLang || 'AUTO'}
                                        </span>
                                    ) : null}
                                    {profile.capabilities.map((capability) => (
                                        <span key={capability} className="rounded-full bg-emerald-50 px-3 py-1 text-emerald-700">
                                            {capability === 'translate' ? '翻译' : 'AI 辅助'}
                                        </span>
                                    ))}
                                </div>
                            </article>
                        )) : (
                            <div className="rounded-2xl border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500">
                                还没有自定义 provider。添加后会自动进入模型选择器。
                            </div>
                        )}
                    </div>
                </section>

                <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex items-center gap-2 text-slate-900">
                        <Plus size={16} />
                        <h3 className="text-base font-semibold">新增 Provider</h3>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-slate-500">{capabilityDescription}</p>

                    <div className="mt-4 space-y-4">
                        <label className="block space-y-2 text-sm">
                            <span className="font-medium text-slate-700">显示名称</span>
                            <input
                                type="text"
                                value={draft.name}
                                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                                placeholder="例如：公司 OpenAI 网关 / 自建 DeepLX"
                                className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400"
                            />
                        </label>

                        <label className="block space-y-2 text-sm">
                            <span className="font-medium text-slate-700">Provider 类型</span>
                            <select
                                value={draft.providerType}
                                onChange={(event) => {
                                    const nextType = event.target.value as ProviderProfileType;
                                    setDraft((current) => ({
                                        ...current,
                                        providerType: nextType,
                                        capabilities: nextType === 'deeplx' ? ['translate'] : current.capabilities,
                                    }));
                                }}
                                className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400"
                            >
                                <option value="openai-compatible">OpenAI-compatible</option>
                                <option value="deeplx">DeepLX</option>
                            </select>
                        </label>

                        <label className="block space-y-2 text-sm">
                            <span className="font-medium text-slate-700">Endpoint</span>
                            <input
                                type="text"
                                value={draft.baseUrl}
                                onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                                placeholder={draft.providerType === 'deeplx' ? 'http://127.0.0.1:1188 或 https://api.deeplx.org/{{apiKey}}/v2/translate' : 'https://your-gateway.example.com/v1'}
                                className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400"
                            />
                            {draft.providerType === 'deeplx' ? (
                                <p className="text-xs leading-5 text-slate-500">
                                    自建 DeepLX 免费接口可填写基础地址，例如 <code>http://127.0.0.1:1188</code>；
                                    若要启用官方兼容 glossary，建议直接填写完整 <code>/v2/translate</code> 地址。
                                    托管网关也可在地址里使用 <code>{'{{apiKey}}'}</code> 占位符。
                                </p>
                            ) : null}
                        </label>

                        <label className="block space-y-2 text-sm">
                            <span className="font-medium text-slate-700">API Key</span>
                            <input
                                type="password"
                                value={draft.apiKey}
                                onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))}
                                placeholder={draft.providerType === 'deeplx' ? '自建实例填 TOKEN；完整 endpoint 已含 key 时可留空' : 'sk-...'}
                                className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400"
                            />
                        </label>

                        {draft.providerType === 'deeplx' ? (
                            <>
                                <label className="block space-y-2 text-sm">
                                    <span className="font-medium text-slate-700">Glossary ID（可选）</span>
                                    <input
                                        type="text"
                                        value={draft.glossaryId}
                                        onChange={(event) => setDraft((current) => ({ ...current, glossaryId: event.target.value }))}
                                        placeholder="DeepL / DeepLX official glossary_id"
                                        className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400"
                                    />
                                </label>

                                <label className="block space-y-2 text-sm">
                                    <span className="font-medium text-slate-700">Source Lang（可选）</span>
                                    <input
                                        type="text"
                                        value={draft.sourceLang}
                                        onChange={(event) => setDraft((current) => ({ ...current, sourceLang: event.target.value.toUpperCase() }))}
                                        placeholder="使用 glossary 时填写，例如 EN"
                                        className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400"
                                    />
                                    <p className="text-xs leading-5 text-slate-500">
                                        DeepL 兼容 glossary 需要显式 source_lang；不使用 glossary 时可留空。
                                    </p>
                                </label>
                            </>
                        ) : null}

                        <label className="block space-y-2 text-sm">
                            <span className="font-medium text-slate-700">默认模型 / 标识</span>
                            <input
                                type="text"
                                value={draft.model}
                                onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}
                                placeholder={draft.providerType === 'deeplx' ? 'deeplx-default' : 'gpt-4o-mini'}
                                className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400"
                            />
                        </label>

                        <div className="space-y-2 text-sm">
                            <div className="font-medium text-slate-700">能力范围</div>
                            <div className="flex flex-wrap gap-2">
                                <button
                                    type="button"
                                    onClick={() => toggleCapability('translate')}
                                    disabled={draft.providerType === 'deeplx'}
                                    className={`rounded-full border px-3 py-1.5 text-xs transition ${draft.capabilities.includes('translate')
                                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                        : 'border-slate-200 text-slate-600 hover:border-slate-300 hover:text-slate-900'
                                        } disabled:cursor-not-allowed disabled:opacity-100`}
                                >
                                    翻译
                                </button>
                                <button
                                    type="button"
                                    onClick={() => toggleCapability('assist')}
                                    disabled={draft.providerType === 'deeplx'}
                                    className={`rounded-full border px-3 py-1.5 text-xs transition ${draft.capabilities.includes('assist')
                                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                        : 'border-slate-200 text-slate-600 hover:border-slate-300 hover:text-slate-900'
                                        } disabled:cursor-not-allowed disabled:opacity-50`}
                                >
                                    AI 辅助
                                </button>
                            </div>
                        </div>

                        {error ? (
                            <p className="rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
                                {error}
                            </p>
                        ) : null}
                        {testMessage ? (
                            <p className="rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                                {testMessage}
                            </p>
                        ) : null}

                        <div className="flex gap-3">
                            <button
                                type="button"
                                onClick={() => void testDraft()}
                                disabled={testing}
                                className="rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-600 transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {testing ? '测试中...' : '测试连接'}
                            </button>
                            <button
                                type="button"
                                onClick={() => void saveDraft()}
                                disabled={saving}
                                className="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl bg-slate-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                                保存配置
                            </button>
                            <button
                                type="button"
                                onClick={resetDraft}
                                className="rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                            >
                                清空
                            </button>
                        </div>
                    </div>
                </section>
            </div>
        </ModalShell>
    );
}
