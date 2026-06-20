'use client';

import { AppErrorBoundary } from '@/components/app-error-boundary';
import { ArxivImportDialog } from '@/components/arxiv-import-dialog';
import { ExportSheet } from '@/components/export-sheet';
import { GlossaryManager } from '@/components/glossary-manager';
import { MarkdownEditor, type ReaderView } from '@/components/markdown-editor';
import { ModalShell } from '@/components/modal-shell';
import { PDFViewer } from '@/components/pdf-viewer';
import { ProviderProfileManager } from '@/components/provider-profile-manager';
import { StoragePanel } from '@/components/storage-panel';
import { useDocumentSemanticProjection } from '@/hooks/use-document-semantic-projection';
import { useTranslationStore } from '@/lib/store';
import {
  BookText,
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
  MoreHorizontal,
  Play,
  Printer,
  RefreshCw,
  Upload,
  WifiOff,
} from 'lucide-react';
import { startTransition, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { TranslationQualityPreset } from '@/lib/store';

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

const TARGET_LANG_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'Chinese', label: '中文' },
  { value: 'Japanese', label: '日文' },
  { value: 'Korean', label: '韩文' },
  { value: 'French', label: '法文' },
  { value: 'German', label: '德文' },
  { value: 'Spanish', label: '西班牙文' },
  { value: 'Italian', label: '意大利文' },
  { value: 'Portuguese', label: '葡萄牙文' },
];

function getTargetLangLabel(value: string): string {
  return TARGET_LANG_OPTIONS.find((option) => option.value === value)?.label || value;
}

function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

const TRANSLATION_QUALITY_OPTIONS: Array<{
  id: TranslationQualityPreset;
  label: string;
  description: string;
}> = [
  { id: 'fast', label: '快速', description: '更快出稿' },
  { id: 'balanced', label: '平衡', description: '默认推荐' },
  { id: 'quality', label: '高质量', description: '更细致' },
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

function renderProgressiveStatus(itemStatus: string, itemProgress: number) {
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
        {itemStatus === 'parsing' && `正在整理阅读稿 (${Math.round(itemProgress)}%)`}
        {itemStatus === 'parsed' && '阅读稿已准备好，等待翻译'}
        {itemStatus === 'translating' && '翻译任务进行中'}
        {itemStatus === 'completed' && '阅读稿已就绪'}
        {itemStatus === 'error' && '任务异常'}
      </div>
    </div>
  );
}

export default function Home() {
  const {
    file,
    status,
    progress,
    sourceMarkdown,
    history,
    fileHash,
    batchId,
    resumableTranslation,
    isZenMode,
    activeFileName,
    targetLang,
    translationQualityPreset,
    translationStatus,
    error,
  } = useTranslationStore(useShallow((state) => ({
    file: state.file,
    status: state.status,
    progress: state.progress,
    sourceMarkdown: state.sourceMarkdown,
    history: state.history,
    fileHash: state.fileHash,
    batchId: state.batchId,
    resumableTranslation: state.resumableTranslation,
    isZenMode: state.isZenMode,
    activeFileName: state.activeFileName,
    targetLang: state.targetLang,
    translationQualityPreset: state.translationQualityPreset,
    translationStatus: state.translationStatus,
    error: state.error,
  })));
  const {
    setFile,
    retryParsing,
    startTranslation,
    reset,
    setHighlightedBlock,
    loadFromHistory,
    hydrateStore,
    resumeTranslation,
    restartTranslation,
    toggleZenMode,
    importFromArxiv,
    setTargetLang,
    setTranslationQualityPreset,
  } = useTranslationStore(useShallow((state) => ({
    setFile: state.setFile,
    retryParsing: state.retryParsing,
    startTranslation: state.startTranslation,
    reset: state.reset,
    setHighlightedBlock: state.setHighlightedBlock,
    loadFromHistory: state.loadFromHistory,
    hydrateStore: state.hydrateStore,
    resumeTranslation: state.resumeTranslation,
    restartTranslation: state.restartTranslation,
    toggleZenMode: state.toggleZenMode,
    importFromArxiv: state.importFromArxiv,
    setTargetLang: state.setTargetLang,
    setTranslationQualityPreset: state.setTranslationQualityPreset,
  })));

  const [sidebarTab, setSidebarTab] = useState<'files' | 'outline'>('outline');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [showArxivDialog, setShowArxivDialog] = useState(false);
  const [showGlossary, setShowGlossary] = useState(false);
  const [showStorage, setShowStorage] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showProviderProfiles, setShowProviderProfiles] = useState(false);
  const [showRestartConfirm, setShowRestartConfirm] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [advancedMenuOpen, setAdvancedMenuOpen] = useState(false);
  const [readerView, setReaderView] = useState<ReaderView>('translation');
  const [dragFeedback, setDragFeedback] = useState('拖入 PDF 或点击选择');
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const didRehydrateStoreRef = useRef(false);
  const isOnline = useSyncExternalStore(
    subscribeOnlineStatus,
    getOnlineSnapshot,
    getServerOnlineSnapshot
  );
  const hasSourceSnapshot = Boolean(sourceMarkdown.trim());
  const activeQualityOption = TRANSLATION_QUALITY_OPTIONS.find((option) => option.id === translationQualityPreset) || TRANSLATION_QUALITY_OPTIONS[1];
  const isRecoverableParseTask = Boolean(
    batchId &&
    fileHash &&
    (status === 'parsing' || (status === 'error' && !hasSourceSnapshot))
  );
  const effectiveSourceMarkdown = isRecoverableParseTask ? '' : sourceMarkdown;
  const { projection: sourceProjection } = useDocumentSemanticProjection(fileHash, effectiveSourceMarkdown);
  const hasCurrentFileInHistory = useMemo(
    () => (file ? history.some((item) => item.fileName === file.name) : false),
    [file, history]
  );

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
    return extractToc(effectiveSourceMarkdown);
  }, [effectiveSourceMarkdown, sourceProjection]);
  const hasParsedDocument = Boolean(effectiveSourceMarkdown.trim());
  const canRecoverParsing = Boolean(batchId && fileHash);
  const needsFreshImportAfterError = status === 'error' && !hasParsedDocument && !canRecoverParsing;
  const openFilePicker = useCallback(() => {
    setMoreMenuOpen(false);
    fileInputRef.current?.click();
  }, []);
  const translationControlState = useMemo<TranslationControlState>(() => {
    if (!hasParsedDocument) return 'unparsed';
    if (status === 'translating') return 'active';
    if (resumableTranslation?.canResume) return 'resumable';
    if (status === 'completed') return 'completed';
    return 'untranslated';
  }, [hasParsedDocument, resumableTranslation?.canResume, status]);

  const displayedProgress = useMemo(() => {
    if (status === 'error') {
      return Math.min(Math.max(progress, 0), 99);
    }
    return Math.min(Math.max(progress, 0), 100);
  }, [progress, status]);
  const showRestartControl = (translationControlState === 'resumable' || translationControlState === 'completed') && status !== 'translating';
  const showImportLanding = status === 'idle' && !hasParsedDocument && !fileHash;
  const documentTitle = activeFileName || file?.name || '准备导入 PDF';
  const targetLangLabel = getTargetLangLabel(targetLang);
  const workflowHint = useMemo(() => {
    if (status === 'uploading') return '正在上传文件，稍后进入解析。';
    if (status === 'parsing') return `正在解析 PDF，${Math.round(displayedProgress)}%。`;
    if (status === 'parsed') return `原文已就绪，可以翻译成 ${targetLangLabel}。`;
    if (status === 'translating') return translationStatus || `正在生成 ${targetLangLabel} 译文。`;
    if (status === 'completed') return '译文已就绪，可以阅读、批注或导出当前视图。';
    if (status === 'error') return error || '任务遇到问题，可以用主动作继续。';
    if (file) return '文件已选择，下一步开始解析。';
    return '拖入 PDF 或从 arXiv 导入，开始翻译阅读。';
  }, [displayedProgress, error, file, status, targetLangLabel, translationStatus]);
  const translationControlMeta = useMemo<TranslationControlMeta>(() => {
    if (translationControlState === 'unparsed') {
      if (status === 'uploading' || status === 'parsing') {
        return {
          title: '解析中',
          detail: `${Math.round(displayedProgress)}%`,
          tone: 'slate' as const,
          actionable: false,
          disabled: true,
          icon: 'loader' as const,
        };
      }

      return {
        title: status === 'error' ? (canRecoverParsing ? '继续解析' : '重新导入 PDF') : '解析',
        detail: status === 'error'
          ? (canRecoverParsing ? '恢复当前解析任务' : '重新选择文件')
          : (file ? '准备解析' : '等待文件'),
        tone: 'slate' as const,
        actionable: true,
        disabled: (!file && !canRecoverParsing && !needsFreshImportAfterError) || !isOnline,
        icon: status === 'error' ? 'refresh' as const : 'play' as const,
        onClick: () => {
          if (needsFreshImportAfterError) {
            openFilePicker();
            return;
          }
          void retryParsing();
        },
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
        detail: `${Math.round(displayedProgress)}%`,
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
      detail: status === 'error' ? '可重试' : targetLangLabel,
      tone: 'emerald' as const,
      actionable: true,
      disabled: !isOnline,
      icon: status === 'error' ? 'refresh' as const : 'play' as const,
      onClick: () => void startTranslation(),
    };
  }, [
    file,
    canRecoverParsing,
    displayedProgress,
    isOnline,
    needsFreshImportAfterError,
    openFilePicker,
    resumeTranslation,
    resumableTranslation?.percentage,
    startTranslation,
    retryParsing,
    status,
    targetLangLabel,
    translationControlState,
  ]);

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const droppedFile = event.dataTransfer.files[0];
    if (!droppedFile) {
      setDragFeedback('请拖入 PDF 文件');
      return;
    }
    if (isPdfFile(droppedFile)) {
      setFile(droppedFile);
      setDragFeedback(`已选择 ${droppedFile.name}`);
    } else {
      setDragFeedback('请拖入 PDF 文件');
    }
  }, [setFile]);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const draggedFile = event.dataTransfer.items?.[0];
    if (!draggedFile || draggedFile.kind !== 'file') {
      setDragFeedback('请拖入 PDF 文件');
      return;
    }
    if (draggedFile.type && draggedFile.type !== 'application/pdf') {
      setDragFeedback('请拖入 PDF 文件');
      return;
    }
    setDragFeedback('松开即可导入 PDF');
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragFeedback(file ? `已选择 ${file.name}` : '拖入 PDF 或点击选择');
  }, [file]);

  const handleFileInputChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (selectedFile && isPdfFile(selectedFile)) {
      setFile(selectedFile);
      setDragFeedback(`已选择 ${selectedFile.name}`);
    } else if (selectedFile) {
      setDragFeedback('请拖入 PDF 文件');
    }
    event.target.value = '';
  }, [setFile]);

  const handlePrimaryAction = useCallback(() => {
    if (!file && !hasParsedDocument && status === 'idle') {
      openFilePicker();
      return;
    }

    if (translationControlState === 'completed') {
      setShowExport(true);
      return;
    }

    translationControlMeta.onClick?.();
  }, [file, hasParsedDocument, openFilePicker, status, translationControlMeta, translationControlState]);

  const primaryActionLabel = useMemo(() => {
    if (!file && !hasParsedDocument && status === 'idle') return '导入 PDF';
    if (translationControlState === 'completed') return '导出当前视图';
    if (translationControlState === 'untranslated') return `翻译成 ${targetLangLabel}`;
    if (translationControlState === 'unparsed' && file && status === 'idle') return '开始解析';
    return translationControlMeta.title;
  }, [file, hasParsedDocument, status, targetLangLabel, translationControlMeta.title, translationControlState]);

  const primaryActionDisabled = useMemo(() => {
    if (!file && !hasParsedDocument && status === 'idle') return false;
    if (translationControlState === 'completed') return !fileHash;
    if (!translationControlMeta.actionable) return true;
    return translationControlMeta.disabled;
  }, [file, fileHash, hasParsedDocument, status, translationControlMeta.actionable, translationControlMeta.disabled, translationControlState]);

  const handleTocItemClick = useCallback((semanticId: string) => {
    if (useTranslationStore.getState().highlightedBlockId === semanticId) {
      return;
    }

    setHighlightedBlock(semanticId);
  }, [setHighlightedBlock]);

  const handleOpenRestartConfirm = useCallback(() => {
    setMoreMenuOpen(false);
    setAdvancedMenuOpen(false);
    setShowRestartConfirm(true);
  }, []);

  const toggleMoreMenu = useCallback(() => {
    setMoreMenuOpen((open) => !open);
    setAdvancedMenuOpen(false);
  }, []);

  const closeMoreMenu = useCallback(() => {
    setMoreMenuOpen(false);
    setAdvancedMenuOpen(false);
  }, []);

  const handleConfirmRestart = useCallback(() => {
    setShowRestartConfirm(false);
    void restartTranslation();
  }, [restartTranslation]);

  useEffect(() => {
    if (!moreMenuOpen) return;

    const closeMenu = () => {
      setMoreMenuOpen(false);
      setAdvancedMenuOpen(false);
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && moreMenuRef.current?.contains(target)) return;
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
  }, [moreMenuOpen]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setShowRestartConfirm(false);
    }, 0);

    return () => window.clearTimeout(timer);
  }, [fileHash, status, targetLang]);

  return (
    <>
      <main className="flex h-screen flex-col bg-slate-50">
        <header className="shrink-0 border-b border-slate-200 bg-white px-4 py-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf"
            className="hidden"
            onChange={handleFileInputChange}
          />
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-slate-900 text-white shadow-sm">
              <FileText size={17} />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="truncate text-sm font-semibold text-slate-950">Doti</h1>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${status === 'completed' ? 'bg-emerald-100 text-emerald-700' :
                  status === 'error' ? 'bg-red-100 text-red-700' :
                    status === 'translating' ? 'bg-amber-100 text-amber-700' :
                      'bg-slate-100 text-slate-600'
                  }`}>
                  {statusLabel(status)}
                </span>
                {!isOnline ? (
                  <span className="hidden shrink-0 items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700 sm:inline-flex">
                    <WifiOff size={11} />
                    离线
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-slate-500">
                <span className="truncate font-medium text-slate-700">{documentTitle}</span>
                <span className="hidden truncate md:inline">{workflowHint}</span>
              </div>
            </div>

            {status !== 'idle' ? (
              <div className="hidden items-center gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 shadow-sm md:inline-flex">
                <span>{Math.round(displayedProgress)}%</span>
                <div className="h-2 w-24 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-slate-900 transition-all duration-300"
                    style={{ width: `${displayedProgress}%` }}
                  />
                </div>
              </div>
            ) : null}

            {!showImportLanding ? (
              <button
                type="button"
                onClick={handlePrimaryAction}
                disabled={primaryActionDisabled}
                className={`inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-2xl px-4 text-sm font-semibold shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50 ${translationControlMeta.tone === 'amber'
                  ? 'border border-amber-200 bg-amber-50 text-amber-700'
                  : 'bg-slate-900 text-white hover:bg-slate-800'
                  }`}
              >
                {translationControlMeta.icon === 'loader' ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : translationControlState === 'completed' ? (
                  <Printer size={15} />
                ) : translationControlMeta.icon === 'refresh' ? (
                  <RefreshCw size={15} />
                ) : !file && !hasParsedDocument && status === 'idle' ? (
                  <Upload size={15} />
                ) : (
                  <Play size={15} />
                )}
                <span className="whitespace-nowrap">{primaryActionLabel}</span>
              </button>
            ) : null}

            {!showImportLanding && (
            <div className="relative" ref={moreMenuRef}>
              <button
                type="button"
                onClick={toggleMoreMenu}
                className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-600 transition hover:border-slate-300 hover:text-slate-950"
                aria-expanded={moreMenuOpen}
                aria-label="更多"
              >
                <MoreHorizontal size={18} />
              </button>

              {moreMenuOpen ? (
                <div className="absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-2xl border border-slate-200 bg-white p-2 shadow-2xl">
                  <div className="px-2 pb-2 pt-1 text-xs font-medium text-slate-400">更多</div>
                  <button
                    type="button"
                    onClick={() => {
                      closeMoreMenu();
                      openFilePicker();
                    }}
                    className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50 hover:text-slate-950"
                  >
                    <Upload size={15} />
                    导入 PDF
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      closeMoreMenu();
                      setShowArxivDialog(true);
                    }}
                    disabled={!isOnline}
                    className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <CloudDownload size={15} />
                    arXiv 导入
                  </button>

                  <div className="my-2 border-t border-slate-100" />
                  <label className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-slate-700">
                    <Languages size={15} className="text-slate-400" />
                    <span className="shrink-0">目标语言</span>
                    <select
                      value={targetLang}
                      onChange={(event) => setTargetLang(event.target.value)}
                      className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm outline-none focus:border-slate-400"
                    >
                      {TARGET_LANG_OPTIONS.map((lang) => (
                        <option key={lang.value} value={lang.value}>
                          {lang.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="rounded-xl px-3 py-2 text-sm text-slate-700">
                    <div className="mb-2 flex items-center justify-between">
                      <span>翻译质量</span>
                      <span className="text-xs text-slate-400">{activeQualityOption.description}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1 text-xs">
                      {TRANSLATION_QUALITY_OPTIONS.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => setTranslationQualityPreset(preset.id)}
                          aria-pressed={translationQualityPreset === preset.id}
                          className={`rounded-lg px-2 py-1 text-center transition ${translationQualityPreset === preset.id ? 'bg-white font-medium text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-900'}`}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="my-2 border-t border-slate-100" />
                  <button
                    type="button"
                    onClick={() => {
                      closeMoreMenu();
                      setShowExport(true);
                    }}
                    disabled={!fileHash}
                    className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Printer size={15} />
                    导出当前视图
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      closeMoreMenu();
                      toggleZenMode();
                    }}
                    className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50 hover:text-slate-950"
                  >
                    {isZenMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                    {isZenMode ? '退出专注阅读' : '专注阅读'}
                  </button>

                  <div className="my-2 border-t border-slate-100" />
                  <button
                    type="button"
                    onClick={() => setAdvancedMenuOpen((open) => !open)}
                    aria-label="高级设置"
                    aria-expanded={advancedMenuOpen}
                    className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm text-slate-500 transition hover:bg-slate-50 hover:text-slate-900"
                  >
                    <span className="inline-flex items-center gap-2">
                      <Database size={15} />
                      高级设置
                    </span>
                    <ChevronRight size={15} className={`transition ${advancedMenuOpen ? 'rotate-90' : ''}`} />
                  </button>
                  {advancedMenuOpen ? (
                    <div className="space-y-1 border-t border-slate-100 pt-2">
                      {showRestartControl ? (
                        <button
                          type="button"
                          onClick={handleOpenRestartConfirm}
                          disabled={!isOnline}
                          className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <RefreshCw size={15} />
                          重新翻译全部
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => {
                          closeMoreMenu();
                          setShowGlossary(true);
                        }}
                        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-500 transition hover:bg-slate-50 hover:text-slate-900"
                      >
                        <BookText size={15} />
                        术语库
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          closeMoreMenu();
                          setShowProviderProfiles(true);
                        }}
                        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-500 transition hover:bg-slate-50 hover:text-slate-900"
                      >
                        <Database size={15} />
                        高级模型设置
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          closeMoreMenu();
                          setShowStorage(true);
                        }}
                        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-500 transition hover:bg-slate-50 hover:text-slate-900"
                      >
                        <Database size={15} />
                        存储管理
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          closeMoreMenu();
                          reset();
                        }}
                        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-500 transition hover:bg-slate-50 hover:text-slate-900"
                      >
                        <RefreshCw size={15} />
                        清空当前工作台
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            )}
          </div>
        </header>

        {showImportLanding ? (
          <div
            className="flex min-h-0 flex-1 items-center justify-center p-4"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div className="grid w-full max-w-5xl gap-6 lg:grid-cols-[1.25fr_0.75fr]">
              <section className="rounded-[28px] border border-dashed border-slate-300 bg-white p-8 shadow-sm">
                <div className="flex min-h-[360px] flex-col items-center justify-center text-center">
                  <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-3xl bg-slate-900 text-white shadow-sm">
                    <Upload size={26} />
                  </div>
                  <h2 className="text-2xl font-semibold text-slate-950">拖入 PDF，开始翻译阅读</h2>
                  <p className="mt-3 max-w-xl text-sm leading-6 text-slate-500">
                    Doti 会先解析文档，再生成译文。完成后你可以直接阅读、选中文字提问、做笔记，并导出当前看到的视图。
                  </p>
                  <div className="mt-5 rounded-full bg-slate-100 px-4 py-2 text-sm font-medium text-slate-600">
                    {dragFeedback}
                  </div>
                  {file ? (
                    <div className="mt-6 flex max-w-full items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                      <FileText size={16} className="shrink-0" />
                      <span className="truncate">{file.name}</span>
                    </div>
                  ) : null}
                  <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
                    <button
                      type="button"
                      onClick={file ? handlePrimaryAction : openFilePicker}
                      disabled={primaryActionDisabled}
                      className="inline-flex h-11 items-center justify-center gap-2 rounded-2xl bg-slate-900 px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {file ? <Play size={16} /> : <Upload size={16} />}
                      {file ? '开始解析' : '选择 PDF'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowArxivDialog(true)}
                      disabled={!isOnline}
                      className="inline-flex h-11 items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-5 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <CloudDownload size={16} />
                      arXiv 导入
                    </button>
                  </div>
                </div>
              </section>

              <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-950">最近文档</h2>
                  <span className="text-xs text-slate-400">{history.length} 个</span>
                </div>
                <div className="mt-4 space-y-2">
                  {history.length > 0 ? history.slice(0, 5).map((item) => (
                    <button
                      type="button"
                      key={item.fileHash}
                      onClick={() => void loadFromHistory(item.fileHash)}
                      className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-left transition hover:border-slate-300 hover:bg-slate-50"
                    >
                      <div className="flex items-center gap-2 text-sm font-medium text-slate-800">
                        <FileText size={15} className="shrink-0 text-slate-400" />
                        <span className="truncate">{item.fileName}</span>
                      </div>
                      {renderProgressiveStatus(item.status, item.progress)}
                    </button>
                  )) : (
                    <div className="rounded-2xl border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500">
                      还没有历史文档
                    </div>
                  )}
                </div>
              </section>
            </div>
          </div>
        ) : (
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
                      {status === 'idle' && file && !hasCurrentFileInHistory && (
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
                          onClick={() => handleTocItemClick(item.semanticId)}
                        >
                          <Hash size={11} className="mt-0.5 shrink-0 text-slate-400" />
                          <span className={item.level === 1 ? 'font-semibold text-slate-900' : 'text-slate-500'}>
                            {item.text}
                          </span>
                        </button>
                      )) : (
                        <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
                          {sourceMarkdown ? '当前内容没有识别到章节标题' : '处理 PDF 后会在这里生成大纲'}
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
              <AppErrorBoundary title="阅读工作区异常">
                <div className="h-full min-h-0">
                  <MarkdownEditor
                    onReaderViewChange={setReaderView}
                    sourceProjection={sourceProjection}
                  />
                </div>
              </AppErrorBoundary>

              {!isZenMode && (
                <AppErrorBoundary title="PDF 预览面板异常">
                  <div className="h-full min-h-0">
                    <PDFViewer projection={sourceProjection} />
                  </div>
                </AppErrorBoundary>
              )}
            </div>
          </div>
          </div>
        )}
      </main>

      <ModalShell
        open={showRestartConfirm}
        onClose={() => setShowRestartConfirm(false)}
        title="重新翻译"
        description="当前目标语言的译文将被清除，并从头重新翻译。"
        widthClassName="max-w-md"
      >
        <div className="space-y-4 px-6 py-6">
          <div className="rounded-2xl border border-red-100 bg-red-50/70 px-4 py-4 text-sm leading-6 text-red-700">
            当前目标语言的译文会被清空，并立即从头重新翻译。原始 PDF、解析结果、批注、提问记录不受影响。
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
        currentView={readerView}
        targetLang={targetLang}
        targetLangLabel={targetLangLabel}
      />
    </>
  );
}
