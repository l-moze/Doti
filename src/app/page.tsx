'use client';

import { AppErrorBoundary } from '@/components/app-error-boundary';
import { ArxivImportDialog } from '@/components/arxiv-import-dialog';
import { ExportSheet } from '@/components/export-sheet';
import { GlossaryManager } from '@/components/glossary-manager';
import { MarkdownEditor } from '@/components/markdown-editor';
import { ModalShell } from '@/components/modal-shell';
import { ModelSelector } from '@/components/model-selector';
import { PDFViewer } from '@/components/pdf-viewer';
import { ProviderProfileManager } from '@/components/provider-profile-manager';
import { StoragePanel } from '@/components/storage-panel';
import { useDocumentSemanticProjection } from '@/hooks/use-document-semantic-projection';
import { useTranslationStore } from '@/lib/store';
import {
  BookText,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CloudDownload,
  Database,
  FileText,
  Hash,
  Languages,
  Loader2,
  List,
  Maximize2,
  Minimize2,
  Play,
  Printer,
  RefreshCw,
  Upload,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { startTransition, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

interface TocItem {
  level: number;
  text: string;
  semanticId: string;
}

type TranslationControlState = 'unparsed' | 'untranslated' | 'resumable' | 'active' | 'completed';
type TranslationControlMeta = {
  title: string;
  detail?: string;
  tone: 'slate' | 'emerald' | 'amber';
  actionable: boolean;
  disabled: boolean;
  icon: 'loader' | 'refresh' | 'play' | 'check';
  onClick?: () => void;
};

const TARGET_LANG_OPTIONS = [
  'Chinese',
  'Japanese',
  'Korean',
  'French',
  'German',
  'Spanish',
  'Italian',
  'Portuguese',
];

function extractToc(markdown: string): TocItem[] {
  const lines = markdown.split('\n');
  const toc: TocItem[] = [];
  let sectionIndex = -1;

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      sectionIndex += 1;
      toc.push({
        level: match[1].length,
        text: match[2].trim(),
        semanticId: `sec-${sectionIndex}-title-0`,
      });
    }
  }

  return toc;
}

function statusLabel(status: string): string {
  switch (status) {
    case 'idle':
      return '待命';
    case 'uploading':
      return '上传中';
    case 'parsing':
      return '解析中';
    case 'parsed':
      return '已解析';
    case 'translating':
      return '翻译中';
    case 'completed':
      return '已完成';
    case 'error':
      return '异常';
    default:
      return status;
  }
}

function subscribeOnlineStatus(callback: () => void) {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

function getOnlineSnapshot() {
  return navigator.onLine;
}

function getServerOnlineSnapshot() {
  return true;
}

export default function Home() {
  const {
    file,
    status,
    progress,
    setFile,
    startUpload,
    startTranslation,
    reset,
    sourceMarkdown,
    targetMarkdown,
    setHighlightedBlock,
    history,
    loadFromHistory,
    hydrateStore,
    fileHash,
    resumableTranslation,
    resumeTranslation,
    restartTranslation,
    isZenMode,
    toggleZenMode,
    importFromArxiv,
    activeFileName,
    targetLang,
    setTargetLang,
    translationStatus,
    error,
  } = useTranslationStore();

  const [sidebarTab, setSidebarTab] = useState<'files' | 'outline'>('outline');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showArxivDialog, setShowArxivDialog] = useState(false);
  const [showGlossary, setShowGlossary] = useState(false);
  const [showStorage, setShowStorage] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showProviderProfiles, setShowProviderProfiles] = useState(false);
  const [showRestartConfirm, setShowRestartConfirm] = useState(false);
  const [translationContextMenu, setTranslationContextMenu] = useState<{ x: number; y: number } | null>(null);
  const translationContextMenuRef = useRef<HTMLDivElement | null>(null);
  const didRehydrateStoreRef = useRef(false);
  const isOnline = useSyncExternalStore(
    subscribeOnlineStatus,
    getOnlineSnapshot,
    getServerOnlineSnapshot
  );
  const { projection: sourceProjection } = useDocumentSemanticProjection(fileHash, sourceMarkdown);

  useEffect(() => {
    if (didRehydrateStoreRef.current) return;
    didRehydrateStoreRef.current = true;

    let cancelled = false;

    const bootstrapStore = async () => {
      await useTranslationStore.persist.rehydrate();
      if (cancelled) return;
      await hydrateStore();
    };

    void bootstrapStore();

    return () => {
      cancelled = true;
    };
  }, [hydrateStore]);

  const toc = useMemo(() => {
    if (sourceProjection?.toc.length) {
      return sourceProjection.toc;
    }
    return extractToc(sourceMarkdown);
  }, [sourceMarkdown, sourceProjection]);
  const hasParsedDocument = Boolean(sourceMarkdown.trim());
  const hasFinishedTranslation = Boolean(targetMarkdown.trim());
  const translationControlState = useMemo<TranslationControlState>(() => {
    if (!hasParsedDocument) return 'unparsed';
    if (status === 'translating') return 'active';
    if (hasFinishedTranslation) return 'completed';
    if (resumableTranslation?.canResume) return 'resumable';
    return 'untranslated';
  }, [hasFinishedTranslation, hasParsedDocument, resumableTranslation?.canResume, status]);
  const showRestartControl = (translationControlState === 'resumable' || translationControlState === 'completed') && status !== 'translating';
  const translationControlMeta = useMemo<TranslationControlMeta>(() => {
    if (translationControlState === 'unparsed') {
      if (status === 'uploading' || status === 'parsing') {
        return {
          title: '解析中',
          detail: `${Math.round(progress)}%`,
          tone: 'slate' as const,
          actionable: false,
          disabled: true,
          icon: 'loader' as const,
        };
      }

      return {
        title: status === 'error' ? '重新解析' : '解析',
        detail: file ? undefined : '等待文件',
        tone: 'slate' as const,
        actionable: true,
        disabled: !file || !isOnline,
        icon: status === 'error' ? 'refresh' as const : 'play' as const,
        onClick: () => void startUpload(),
      };
    }

    if (translationControlState === 'resumable') {
      return {
        title: '继续翻译',
        detail: `${resumableTranslation?.percentage ?? 0}%`,
        tone: 'emerald' as const,
        actionable: true,
        disabled: !isOnline,
        icon: 'play' as const,
        onClick: () => void resumeTranslation(),
      };
    }

    if (translationControlState === 'active') {
      return {
        title: '翻译中',
        detail: `${Math.round(progress)}%`,
        tone: 'amber' as const,
        actionable: false,
        disabled: true,
        icon: 'loader' as const,
      };
    }

    if (translationControlState === 'completed') {
      return {
        title: '已完成',
        detail: '100%',
        tone: 'emerald' as const,
        actionable: false,
        disabled: true,
        icon: 'check' as const,
      };
    }

    return {
      title: '翻译',
      detail: targetLang,
      tone: 'emerald' as const,
      actionable: true,
      disabled: !isOnline,
      icon: 'play' as const,
      onClick: () => void startTranslation(),
    };
  }, [
    file,
    isOnline,
    resumeTranslation,
    resumableTranslation?.percentage,
    startTranslation,
    startUpload,
    progress,
    status,
    targetLang,
    translationControlState,
  ]);

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const droppedFile = event.dataTransfer.files[0];
    if (droppedFile?.type === 'application/pdf') {
      setFile(droppedFile);
    }
  }, [setFile]);

  const openTranslationContextMenu = useCallback((event: React.MouseEvent<HTMLElement | HTMLDivElement>) => {
    event.preventDefault();

    const menuWidth = 220;
    const menuHeight = 180;
    const nextX = Math.min(event.clientX, window.innerWidth - menuWidth - 12);
    const nextY = Math.min(event.clientY, window.innerHeight - menuHeight - 12);

    setTranslationContextMenu({
      x: Math.max(12, nextX),
      y: Math.max(12, nextY),
    });
  }, []);

  const handleStartParsing = useCallback(() => {
    setTranslationContextMenu(null);
    void startUpload();
  }, [startUpload]);

  const handleStartFreshTranslation = useCallback(() => {
    setTranslationContextMenu(null);
    void startTranslation();
  }, [startTranslation]);

  const handleResumeExistingTranslation = useCallback(() => {
    setTranslationContextMenu(null);
    void resumeTranslation();
  }, [resumeTranslation]);

  const handleOpenRestartConfirm = useCallback(() => {
    setTranslationContextMenu(null);
    setShowRestartConfirm(true);
  }, []);

  const handleConfirmRestart = useCallback(() => {
    setShowRestartConfirm(false);
    setTranslationContextMenu(null);
    void restartTranslation();
  }, [restartTranslation]);

  const translationContextMenuItems = useMemo(() => {
    if (translationControlState === 'unparsed') {
      return [
        {
          key: 'parse',
          label: status === 'error' ? '重新解析' : '解析',
          disabled: !file || !isOnline || status === 'uploading' || status === 'parsing',
          tone: 'default' as const,
          onSelect: handleStartParsing,
        },
      ];
    }

    if (translationControlState === 'resumable') {
      return [
        {
          key: 'resume',
          label: '继续翻译',
          disabled: !isOnline,
          tone: 'default' as const,
          onSelect: handleResumeExistingTranslation,
        },
        {
          key: 'restart',
          label: '重新翻译全部',
          disabled: !isOnline,
          tone: 'danger' as const,
          onSelect: handleOpenRestartConfirm,
        },
      ];
    }

    if (translationControlState === 'completed') {
      return [
        {
          key: 'restart',
          label: '重新翻译全部',
          disabled: !isOnline,
          tone: 'danger' as const,
          onSelect: handleOpenRestartConfirm,
        },
      ];
    }

    if (translationControlState === 'active') {
      return [
        {
          key: 'active',
          label: '翻译中…',
          disabled: true,
          tone: 'default' as const,
          onSelect: () => undefined,
        },
      ];
    }

    return [
      {
        key: 'translate',
        label: '翻译',
        disabled: !isOnline,
        tone: 'default' as const,
        onSelect: handleStartFreshTranslation,
      },
    ];
  }, [
    file,
    handleOpenRestartConfirm,
    handleResumeExistingTranslation,
    handleStartFreshTranslation,
    handleStartParsing,
    isOnline,
    status,
    translationControlState,
  ]);

  useEffect(() => {
    if (!translationContextMenu) return;

    const closeMenu = () => setTranslationContextMenu(null);
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && translationContextMenuRef.current?.contains(target)) return;
      closeMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu();
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
    };
  }, [translationContextMenu]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setTranslationContextMenu(null);
      setShowRestartConfirm(false);
    }, 0);

    return () => window.clearTimeout(timer);
  }, [fileHash, status, targetLang]);

  const renderProgressiveStatus = (itemStatus: string, itemProgress: number) => {
    const activeIndex =
      itemStatus === 'uploading' ? 0 :
        ['parsing', 'parsed'].includes(itemStatus) ? 1 :
          ['translating', 'completed'].includes(itemStatus) ? 2 :
            -1;

    return (
      <div className="mt-2 space-y-1">
        <div className="flex items-center gap-1 text-[10px]">
          <span className={itemStatus !== 'idle' ? 'text-emerald-600' : 'text-slate-400'}>
            {itemStatus !== 'idle' ? '●' : '○'} 上传
          </span>
          <span className="text-slate-300">/</span>
          <span className={activeIndex >= 1 ? (itemStatus === 'parsing' ? 'text-sky-600' : 'text-emerald-600') : 'text-slate-400'}>
            {itemStatus === 'parsing' ? '◐' : activeIndex >= 1 ? '●' : '○'} 解析
          </span>
          <span className="text-slate-300">/</span>
          <span className={activeIndex >= 2 ? (itemStatus === 'translating' ? 'text-sky-600' : 'text-emerald-600') : 'text-slate-400'}>
            {itemStatus === 'translating' ? '◐' : itemStatus === 'completed' ? '●' : '○'} 翻译
          </span>
        </div>
        <div className="text-[10px] text-slate-500">
          {itemStatus === 'uploading' && '文件进入服务端队列'}
          {itemStatus === 'parsing' && `MinerU 处理中 (${Math.round(itemProgress)}%)`}
          {itemStatus === 'parsed' && '已生成 Markdown，等待翻译'}
          {itemStatus === 'translating' && '翻译任务进行中'}
          {itemStatus === 'completed' && '阅读稿已就绪'}
          {itemStatus === 'error' && '任务异常'}
        </div>
      </div>
    );
  };

  return (
    <>
      <main className="flex h-screen flex-col bg-[radial-gradient(circle_at_top_left,_#dbeafe,_transparent_24%),radial-gradient(circle_at_top_right,_#ffedd5,_transparent_22%),#f8fafc]">
        <header className="shrink-0 border-b border-slate-200/80 bg-white/90 px-3 py-3 backdrop-blur xl:px-4">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white shadow-sm">
                <FileText size={14} />
                PDF 翻译台
              </div>
              <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${isOnline ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                {isOnline ? <Wifi size={12} /> : <WifiOff size={12} />}
                {isOnline ? '在线' : '离线'}
              </span>
              <span className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${status === 'completed' ? 'bg-emerald-100 text-emerald-700' :
                status === 'error' ? 'bg-red-100 text-red-700' :
                  status === 'translating' ? 'bg-amber-100 text-amber-700' :
                    'bg-slate-100 text-slate-600'
                }`}>
                {statusLabel(status)}
              </span>
              <div className="min-w-[220px] flex-1 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-500 shadow-sm">
                <span className="block truncate">{activeFileName || '尚未载入文档'}</span>
              </div>
              {status !== 'idle' && (
                <div className="inline-flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 shadow-sm">
                  <span>{Math.round(progress)}%</span>
                  <div className="h-2 w-24 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-slate-900 transition-all duration-300"
                      style={{ width: `${Math.min(100, Math.max(progress, 0))}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="flex min-w-[240px] max-w-[360px] flex-1 items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
                <span className="shrink-0 text-xs font-medium text-slate-500">翻译模型</span>
                <ModelSelector className="min-w-0 flex-1" />
              </div>
              <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
                <Languages size={15} className="text-slate-400" />
                <input
                  list="target-language-options"
                  value={targetLang}
                  onChange={(event) => setTargetLang(event.target.value)}
                  className="w-28 bg-transparent text-sm outline-none"
                  placeholder="Chinese"
                />
                <datalist id="target-language-options">
                  {TARGET_LANG_OPTIONS.map((lang) => (
                    <option key={lang} value={lang} />
                  ))}
                </datalist>
              </div>

              <div
                onDragOver={(event) => event.preventDefault()}
                onDrop={handleDrop}
                className={`flex min-w-[220px] flex-1 items-center gap-2 rounded-2xl border border-dashed px-3 py-2 text-sm shadow-sm transition ${file ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-500 hover:border-slate-400 hover:text-slate-700'}`}
              >
                <input
                  type="file"
                  accept=".pdf"
                  className="hidden"
                  id="file-upload"
                  onChange={(event) => event.target.files?.[0] && setFile(event.target.files[0])}
                />
                <Upload size={15} />
                <label htmlFor="file-upload" className="cursor-pointer truncate">
                  {file ? file.name : '拖拽或选择 PDF'}
                </label>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={translationControlMeta.onClick}
                  onContextMenu={openTranslationContextMenu}
                  disabled={translationControlMeta.actionable ? translationControlMeta.disabled : false}
                  aria-disabled={!translationControlMeta.actionable || translationControlMeta.disabled}
                  className={`inline-flex h-10 items-center gap-2 rounded-2xl border px-3 text-sm font-medium shadow-sm transition ${translationControlMeta.actionable
                    ? 'disabled:cursor-not-allowed disabled:opacity-50'
                    : 'cursor-default'
                    } ${translationControlMeta.tone === 'emerald'
                      ? `border-emerald-200 bg-emerald-50 text-emerald-700 ${translationControlMeta.actionable ? 'hover:border-emerald-300 hover:bg-emerald-100' : ''}`
                      : translationControlMeta.tone === 'amber'
                        ? 'border-amber-200 bg-amber-50 text-amber-700'
                        : `border-slate-200 bg-white text-slate-700 ${translationControlMeta.actionable ? 'hover:border-slate-300 hover:bg-slate-50' : ''}`
                      }`}
                >
                  <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center ${translationControlMeta.tone === 'emerald'
                    ? 'text-emerald-600'
                    : translationControlMeta.tone === 'amber'
                      ? 'text-amber-600'
                      : 'text-slate-600'
                    }`}>
                    {translationControlMeta.icon === 'loader' ? (
                      <Loader2 size={15} className="animate-spin" />
                    ) : translationControlMeta.icon === 'check' ? (
                      <CheckCircle2 size={15} />
                    ) : translationControlMeta.icon === 'refresh' ? (
                      <RefreshCw size={15} />
                    ) : (
                      <Play size={15} />
                    )}
                  </span>
                  <span className="whitespace-nowrap">{translationControlMeta.title}</span>
                  {translationControlMeta.detail ? (
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${translationControlMeta.tone === 'emerald'
                      ? 'bg-emerald-100 text-emerald-700'
                      : translationControlMeta.tone === 'amber'
                        ? 'bg-amber-100 text-amber-700'
                        : 'bg-slate-100 text-slate-600'
                      }`}>
                      {translationControlMeta.detail}
                    </span>
                  ) : null}
                </button>

                {showRestartControl ? (
                  <button
                    type="button"
                    onClick={handleOpenRestartConfirm}
                    disabled={!isOnline}
                    title="重新翻译全部内容"
                    className="inline-flex h-10 items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RefreshCw size={15} />
                    重翻
                  </button>
                ) : null}
              </div>

              <button
                type="button"
                onClick={() => setShowArxivDialog(true)}
                disabled={!isOnline}
                className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CloudDownload size={15} />
                arXiv
              </button>
              <button
                type="button"
                onClick={() => setShowGlossary(true)}
                className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 transition hover:border-slate-300 hover:text-slate-900"
              >
                <BookText size={15} />
                术语
              </button>
              <button
                type="button"
                onClick={() => setShowExport(true)}
                disabled={!fileHash}
                className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Printer size={15} />
                导出
              </button>
              <button
                type="button"
                onClick={() => setShowProviderProfiles(true)}
                className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 transition hover:border-slate-300 hover:text-slate-900"
              >
                <Database size={15} />
                模型配置
              </button>
              <button
                type="button"
                onClick={() => setShowStorage(true)}
                className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 transition hover:border-slate-300 hover:text-slate-900"
              >
                <Database size={15} />
                存储
              </button>
              <button
                type="button"
                onClick={toggleZenMode}
                className={`rounded-2xl border px-3 py-2 text-sm transition ${isZenMode ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:text-slate-900'}`}
                title={isZenMode ? '退出专注模式' : '进入专注模式'}
              >
                <span className="inline-flex items-center gap-2">
                  {isZenMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                  {isZenMode ? '退出专注' : '专注模式'}
                </span>
              </button>
              <button
                type="button"
                onClick={reset}
                className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 transition hover:border-slate-300 hover:text-slate-900"
              >
                <RefreshCw size={15} />
                重置
              </button>
            </div>

            {(translationStatus && status === 'translating') || error ? (
              <div className="flex flex-wrap items-center gap-2">
                {translationStatus && status === 'translating' && (
                  <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-700">
                    {translationStatus}
                  </span>
                )}
                {error && (
                  <span className="rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs text-red-700">
                    {error}
                  </span>
                )}
              </div>
            ) : null}
          </div>
        </header>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <aside className={`flex min-h-0 shrink-0 flex-col border-r border-slate-200 bg-white/80 backdrop-blur transition-all duration-300 ${sidebarCollapsed ? 'w-12' : 'w-64 xl:w-72'}`}>
            <button
              type="button"
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
              className="flex w-full items-center justify-center border-b border-slate-200 py-3 text-slate-500 transition hover:bg-slate-50 hover:text-slate-900"
              title={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
            >
              {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
            </button>

            {!sidebarCollapsed ? (
              <>
                <div className="flex border-b border-slate-200">
                  <button
                    type="button"
                    onClick={() => startTransition(() => setSidebarTab('files'))}
                    className={`flex-1 px-4 py-3 text-sm font-medium transition ${sidebarTab === 'files' ? 'bg-slate-900 text-white' : 'bg-white text-slate-500 hover:text-slate-900'}`}
                  >
                    <span className="inline-flex items-center gap-2">
                      <FileText size={14} />
                      文件
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => startTransition(() => setSidebarTab('outline'))}
                    className={`flex-1 px-4 py-3 text-sm font-medium transition ${sidebarTab === 'outline' ? 'bg-slate-900 text-white' : 'bg-white text-slate-500 hover:text-slate-900'}`}
                  >
                    <span className="inline-flex items-center gap-2">
                      <List size={14} />
                      大纲
                    </span>
                  </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                  {sidebarTab === 'files' ? (
                    <div className="space-y-3">
                      {status === 'idle' && file && !history.some((item) => item.fileName === file.name) && (
                        <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
                          <div className="flex items-center gap-2">
                            <FileText size={14} className="text-slate-700" />
                            <span className="truncate text-sm font-medium text-slate-900">{file.name}</span>
                          </div>
                          {renderProgressiveStatus('uploading', 0)}
                        </div>
                      )}

                      {history.length > 0 ? history.map((item) => (
                        <button
                          type="button"
                          key={item.fileHash}
                          onClick={() => void loadFromHistory(item.fileHash)}
                          className={`w-full rounded-3xl border p-4 text-left shadow-sm transition ${item.fileHash === fileHash ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:shadow-md'}`}
                        >
                          <div className="flex items-center gap-2">
                            <FileText size={14} className={item.fileHash === fileHash ? 'text-white' : 'text-slate-500'} />
                            <span className="truncate text-sm font-medium">{item.fileName}</span>
                          </div>
                          {renderProgressiveStatus(item.status, item.progress)}
                        </button>
                      )) : (
                        <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
                          暂无历史任务
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {toc.length > 0 ? toc.map((item, index) => (
                        <button
                          type="button"
                          key={`${item.text}-${index}`}
                          className="flex w-full items-start gap-2 rounded-2xl px-2 py-2 text-left text-xs transition hover:bg-slate-50"
                          style={{ paddingLeft: `${(item.level - 1) * 14 + 8}px` }}
                          title={item.text}
                          onClick={() => setHighlightedBlock(item.semanticId)}
                        >
                          <Hash size={11} className="mt-0.5 shrink-0 text-slate-400" />
                          <span className={item.level === 1 ? 'font-semibold text-slate-900' : 'text-slate-500'}>
                            {item.text}
                          </span>
                        </button>
                      )) : (
                        <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
                          {sourceMarkdown ? '当前内容没有识别到 Markdown 标题' : '处理 PDF 后会在这里生成大纲'}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center gap-2 py-3">
                <button
                  type="button"
                  onClick={() => {
                    setSidebarCollapsed(false);
                    startTransition(() => setSidebarTab('files'));
                  }}
                  className={`rounded-2xl p-2 transition ${sidebarTab === 'files' ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'}`}
                  title="文件"
                >
                  <FileText size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSidebarCollapsed(false);
                    startTransition(() => setSidebarTab('outline'));
                  }}
                  className={`rounded-2xl p-2 transition ${sidebarTab === 'outline' ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'}`}
                  title="大纲"
                >
                  <List size={16} />
                </button>
              </div>
            )}
          </aside>

          <div className="min-h-0 flex-1 overflow-hidden p-3 xl:p-4">
            <div className={`grid h-full min-h-0 gap-3 ${isZenMode ? 'grid-cols-1' : 'grid-cols-1 2xl:grid-cols-2'}`}>
              {!isZenMode && (
                <AppErrorBoundary title="PDF 预览面板异常">
                  <div className="h-full min-h-0">
                    <PDFViewer projection={sourceProjection} />
                  </div>
                </AppErrorBoundary>
              )}

              <AppErrorBoundary title="Markdown 工作区异常">
                <div className="h-full min-h-0">
                  <MarkdownEditor
                    onTranslationWorkspaceContextMenu={openTranslationContextMenu}
                    sourceProjection={sourceProjection}
                  />
                </div>
              </AppErrorBoundary>
            </div>
          </div>
        </div>
      </main>

      {translationContextMenu ? (
        <div
          ref={translationContextMenuRef}
          className="fixed z-50 min-w-[200px] overflow-hidden rounded-2xl border border-slate-200 bg-white p-1.5 shadow-2xl"
          style={{ left: translationContextMenu.x, top: translationContextMenu.y }}
        >
          {translationContextMenuItems.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                if (item.disabled) return;
                item.onSelect();
              }}
              disabled={item.disabled}
              className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm transition ${item.disabled
                ? 'cursor-not-allowed text-slate-300'
                : item.tone === 'danger'
                  ? 'text-red-600 hover:bg-red-50'
                  : 'text-slate-700 hover:bg-slate-50 hover:text-slate-900'
                }`}
            >
              <span>{item.label}</span>
              {item.key === 'restart' ? <RefreshCw size={14} /> : null}
            </button>
          ))}
        </div>
      ) : null}

      <ModalShell
        open={showRestartConfirm}
        onClose={() => setShowRestartConfirm(false)}
        title="重新翻译"
        description="当前目标语言的译文缓存将被清除，并从头重新翻译。"
        widthClassName="max-w-md"
      >
        <div className="space-y-4 px-6 py-6">
          <div className="rounded-2xl border border-red-100 bg-red-50/70 px-4 py-4 text-sm leading-6 text-red-700">
            当前目标语言的译文会被清空，并立即从头重新翻译。原始 PDF、解析结果、批注、AI 对话不受影响。
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <button
              type="button"
              onClick={handleConfirmRestart}
              className="inline-flex items-center justify-center gap-2 rounded-2xl bg-red-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-red-700"
            >
              <RefreshCw size={15} />
              重新翻译当前语言
            </button>
            <button
              type="button"
              onClick={() => setShowRestartConfirm(false)}
              className="rounded-2xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-900"
            >
              取消
            </button>
          </div>
        </div>
      </ModalShell>

      <ArxivImportDialog
        open={showArxivDialog}
        status={status}
        onClose={() => setShowArxivDialog(false)}
        onImport={importFromArxiv}
      />
      <GlossaryManager open={showGlossary} onClose={() => setShowGlossary(false)} />
      <ProviderProfileManager open={showProviderProfiles} onClose={() => setShowProviderProfiles(false)} />
      <StoragePanel open={showStorage} onClose={() => setShowStorage(false)} />
      <ExportSheet
        open={showExport}
        onClose={() => setShowExport(false)}
        fileHash={fileHash}
        fileName={activeFileName}
        targetLang={targetLang}
      />
    </>
  );
}
