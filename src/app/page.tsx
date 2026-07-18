'use client';

import { AppErrorBoundary } from '@/components/app-error-boundary';
import { ArxivImportDialog } from '@/components/arxiv-import-dialog';
import { ExportSheet, type ExportMode } from '@/components/export-sheet';
import { GlossaryManager } from '@/components/glossary-manager';
import { MarkdownEditor, type ReaderView } from '@/components/markdown-editor';
import { ModalShell } from '@/components/modal-shell';
import { ModelSelector } from '@/components/model-selector';
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
type TranslationQualityOptionId = Exclude<TranslationQualityPreset, 'custom'>;
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
  id: TranslationQualityOptionId;
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
      return '待导入';
    case 'uploading':
      return '准备文件';
    case 'parsing':
      return '整理阅读稿';
    case 'parsed':
      return '待翻译';
    case 'translating':
      return '生成译文';
    case 'completed':
      return '可阅读';
    case 'error':
      return '需处理';
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
          {itemStatus !== 'idle' ? '●' : '○'} 导入
        </span>
        <span className="text-slate-300">/</span>
        <span className={activeIndex >= 1 ? (itemStatus === 'parsing' ? 'text-sky-600' : 'text-emerald-600') : 'text-slate-400'}>
          {itemStatus === 'parsing' ? '◐' : activeIndex >= 1 ? '●' : '○'} 整理
        </span>
        <span className="text-slate-300">/</span>
        <span className={activeIndex >= 2 ? (itemStatus === 'translating' ? 'text-sky-600' : 'text-emerald-600') : 'text-slate-400'}>
          {itemStatus === 'translating' ? '◐' : itemStatus === 'completed' ? '●' : '○'} 翻译
        </span>
      </div>
      <div className="text-[10px] text-slate-500">
        {itemStatus === 'uploading' && '正在准备文件'}
        {itemStatus === 'parsing' && `正在整理阅读稿 (${Math.round(itemProgress)}%)`}
        {itemStatus === 'parsed' && '阅读稿已准备好，等待翻译'}
        {itemStatus === 'translating' && '正在生成译文'}
        {itemStatus === 'completed' && '阅读稿已就绪'}
        {itemStatus === 'error' && '需要处理'}
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
  const [preferredExportMode, setPreferredExportMode] = useState<ExportMode | null>(null);
  const [readerPanelExportMode, setReaderPanelExportMode] = useState<ExportMode | null>(null);
  const [showProviderProfiles, setShowProviderProfiles] = useState(false);
  const [showRestartConfirm, setShowRestartConfirm] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [advancedMenuOpen, setAdvancedMenuOpen] = useState(false);
  const [readerView, setReaderView] = useState<ReaderView>('translation');
  const [pdfPreviewOpen, setPdfPreviewOpen] = useState(false);
  const [dragFeedback, setDragFeedback] = useState('拖入 PDF 或点击导入');
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const didRehydrateStoreRef = useRef(false);
  const isOnline = useSyncExternalStore(
    subscribeOnlineStatus,
    getOnlineSnapshot,
    getServerOnlineSnapshot
  );
  const hasSourceSnapshot = Boolean(sourceMarkdown.trim());
  const activeQualityOption = TRANSLATION_QUALITY_OPTIONS.find((option) => option.id === translationQualityPreset);
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
  const showTopProgress = status === 'uploading' || status === 'parsing' || status === 'translating';
  const documentTitle = activeFileName || file?.name || '准备导入 PDF';
  const targetLangLabel = getTargetLangLabel(targetLang);
  const workflowHint = useMemo(() => {
    if (status === 'uploading') return '正在准备文件，稍后整理阅读稿。';
    if (status === 'parsing') return `正在整理阅读稿，${Math.round(displayedProgress)}%。`;
    if (status === 'parsed') return `原文已就绪，可以翻译成 ${targetLangLabel}。`;
    if (status === 'translating') return translationStatus || `正在生成 ${targetLangLabel} 译文。`;
    if (status === 'completed') return '译文已就绪，可以阅读、做笔记或导出当前视图。';
    if (status === 'error') return error || '处理遇到问题，可以用主动作继续。';
    if (file) return isOnline ? 'PDF 已准备好，正在进入阅读稿整理。' : 'PDF 已准备好，联网后继续整理阅读稿。';
    return '拖入 PDF 或导入论文，开始翻译阅读。';
  }, [displayedProgress, error, file, isOnline, status, targetLangLabel, translationStatus]);
  const translationControlMeta = useMemo<TranslationControlMeta>(() => {
    if (translationControlState === 'unparsed') {
      if (status === 'uploading' || status === 'parsing') {
        return {
          title: '整理阅读稿',
          detail: `${Math.round(displayedProgress)}%`,
          tone: 'slate' as const,
          actionable: false,
          disabled: true,
          icon: 'loader' as const,
        };
      }

      return {
        title: status === 'error' ? (canRecoverParsing ? '继续整理' : '重新导入 PDF') : '整理阅读稿',
        detail: status === 'error'
          ? (canRecoverParsing ? '继续整理阅读稿' : '重新导入 PDF')
          : (file ? 'PDF 已准备好' : '等待导入'),
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
        title: '继续生成译文',
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
        title: '生成译文',
        detail: `${Math.round(displayedProgress)}%`,
        tone: 'amber' as const,
        actionable: false,
        disabled: true,
        icon: 'loader' as const,
      };
    }

    if (translationControlState === 'completed') {
      return {
        title: '导出当前视图',
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

  const importPdfFile = useCallback((nextFile: File) => {
    setFile(nextFile);
    if (!isOnline) {
      setDragFeedback(`${nextFile.name} 已准备好，联网后继续`);
      return;
    }

    setDragFeedback(`正在导入 ${nextFile.name}`);
    void retryParsing();
  }, [isOnline, retryParsing, setFile]);

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const droppedFile = event.dataTransfer.files[0];
    if (!droppedFile) {
      setDragFeedback('请拖入 PDF 文件');
      return;
    }
    if (isPdfFile(droppedFile)) {
      importPdfFile(droppedFile);
    } else {
      setDragFeedback('请拖入 PDF 文件');
    }
  }, [importPdfFile]);

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
    setDragFeedback(file ? `${file.name} 已准备好` : '拖入 PDF 或点击导入');
  }, [file]);

  const handleFileInputChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (selectedFile && isPdfFile(selectedFile)) {
      importPdfFile(selectedFile);
    } else if (selectedFile) {
      setDragFeedback('请拖入 PDF 文件');
    }
    event.target.value = '';
  }, [importPdfFile]);

  const openExportSheet = useCallback((mode: ExportMode | null = null) => {
    setPreferredExportMode(mode ?? readerPanelExportMode);
    setShowExport(true);
  }, [readerPanelExportMode]);

  const handleVisibleExportModeChange = useCallback((mode: ExportMode | null) => {
    setReaderPanelExportMode(mode);
  }, []);

  const handlePrimaryAction = useCallback(() => {
    if (!file && !hasParsedDocument && status === 'idle') {
      openFilePicker();
      return;
    }

    if (translationControlState === 'completed') {
      openExportSheet();
      return;
    }

    translationControlMeta.onClick?.();
  }, [file, hasParsedDocument, openExportSheet, openFilePicker, status, translationControlMeta, translationControlState]);

  const primaryActionLabel = useMemo(() => {
    if (!file && !hasParsedDocument && status === 'idle') return '导入 PDF';
    if (translationControlState === 'completed') return '导出当前视图';
    if (translationControlState === 'untranslated') return `翻译成 ${targetLangLabel}`;
    if (translationControlState === 'unparsed' && file && status === 'idle') return '整理阅读稿';
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

  useEffect(() => {
    setPdfPreviewOpen(false);
  }, [fileHash]);

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
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white">
              <FileText size={17} />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="truncate text-sm font-semibold text-slate-950">{documentTitle}</h1>
                <span className="hidden shrink-0 text-xs font-medium text-slate-400 sm:inline">Doti</span>
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
                <span className="hidden truncate md:inline">{workflowHint}</span>
              </div>
            </div>

            {showTopProgress ? (
              <div className="hidden items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 md:inline-flex">
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
                className={`inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${translationControlMeta.tone === 'amber'
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
                className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:border-slate-300 hover:text-slate-950"
                aria-expanded={moreMenuOpen}
                aria-label="更多"
              >
                <MoreHorizontal size={18} />
              </button>

              {moreMenuOpen ? (
                <div className="absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
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
                    导入论文
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
                  <label className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-slate-700">
                    <Database size={15} className="text-slate-400" />
                    <span className="shrink-0">翻译服务</span>
                    <ModelSelector mode="translation" compact className="min-w-0 flex-1 justify-end" />
                  </label>
                  <div className="rounded-xl px-3 py-2 text-sm text-slate-700">
                    <div className="mb-2 flex items-center justify-between">
                      <span>翻译质量</span>
                      <span className="text-xs text-slate-400">{activeQualityOption?.description || '自定义服务'}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1 text-xs">
                      {TRANSLATION_QUALITY_OPTIONS.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => setTranslationQualityPreset(preset.id)}
                          disabled={translationQualityPreset === preset.id || status === 'translating'}
                          aria-pressed={translationQualityPreset === preset.id}
                          className={`rounded-lg px-2 py-1 text-center transition disabled:cursor-not-allowed disabled:opacity-70 ${translationQualityPreset === preset.id ? 'bg-white font-medium text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-900'}`}
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
                      openExportSheet();
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
                      setPdfPreviewOpen((open) => !open);
                    }}
                    className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50 hover:text-slate-950"
                  >
                    <FileText size={15} />
                    {pdfPreviewOpen ? '隐藏 PDF 原文' : '显示 PDF 原文'}
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
                          重新生成译文
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
                        固定译法
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
                        自定义翻译服务
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
                        本地数据
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
            className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto overflow-x-hidden p-4 py-6 sm:py-8"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div className="grid w-full max-w-[calc(100vw-2rem)] min-w-0 gap-4 sm:max-w-5xl lg:grid-cols-[1.25fr_0.75fr]">
              <section className="w-full max-w-full min-w-0 rounded-lg border border-dashed border-slate-300 bg-white p-5 sm:p-8">
                <div className="flex min-h-[360px] w-full min-w-0 flex-col items-center justify-center text-center">
                  <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-lg bg-slate-900 text-white">
                    <Upload size={24} />
                  </div>
                  <h2 className="text-2xl font-semibold text-slate-950">拖入 PDF，开始翻译阅读</h2>
                  <p className="mt-3 max-w-full break-words text-sm leading-6 text-slate-500 sm:max-w-xl">
                    Doti 会先整理阅读稿，再生成译文。完成后你可以直接阅读、选中文字提问、做笔记，并导出当前看到的视图。
                  </p>
                  <div className="mt-5 max-w-full rounded-full bg-slate-100 px-4 py-2 text-sm font-medium text-slate-600">
                    {dragFeedback}
                  </div>
                  {file ? (
                    <div className="mt-6 flex max-w-full items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                      <FileText size={16} className="shrink-0" />
                      <span className="truncate">{file.name}</span>
                    </div>
                  ) : null}
                  <div className="mt-7 flex w-full flex-wrap items-center justify-center gap-3">
                    <button
                      type="button"
                      onClick={file ? handlePrimaryAction : openFilePicker}
                      disabled={primaryActionDisabled}
                      className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-slate-900 px-5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {file ? <Play size={16} /> : <Upload size={16} />}
                      {file ? '整理阅读稿' : '导入 PDF'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowArxivDialog(true)}
                      disabled={!isOnline}
                      className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-5 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <CloudDownload size={16} />
                      导入论文
                    </button>
                  </div>
                </div>
              </section>

              <section className="w-full max-w-full min-w-0 rounded-lg border border-slate-200 bg-white p-5">
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
                      className="w-full rounded-lg border border-slate-200 px-4 py-3 text-left transition hover:border-slate-300 hover:bg-slate-50"
                    >
                      <div className="flex items-center gap-2 text-sm font-medium text-slate-800">
                        <FileText size={15} className="shrink-0 text-slate-400" />
                        <span className="truncate">{item.fileName}</span>
                      </div>
                      {renderProgressiveStatus(item.status, item.progress)}
                    </button>
                  )) : (
                    <div className="rounded-lg border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500">
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
                        <div className="rounded-lg border border-slate-200 bg-white p-4">
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
                          className={`w-full rounded-lg border p-4 text-left transition ${item.fileHash === fileHash ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50'}`}
                        >
                          <div className="flex items-center gap-2">
                            <FileText size={14} className={item.fileHash === fileHash ? 'text-white' : 'text-slate-500'} />
                            <span className="truncate text-sm font-medium">{item.fileName}</span>
                          </div>
                          {renderProgressiveStatus(item.status, item.progress)}
                        </button>
                      )) : (
                        <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
                          暂无历史文档
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
                        <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
                          {sourceMarkdown ? '当前内容没有识别到章节标题' : '整理阅读稿后会在这里生成大纲'}
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
                  className={`rounded-lg p-2 transition ${sidebarTab === 'files' ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'}`}
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
                  className={`rounded-lg p-2 transition ${sidebarTab === 'outline' ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'}`}
                  title="大纲"
                >
                  <List size={16} />
                </button>
              </div>
            )}
          </aside>

          <div className="min-h-0 flex-1 overflow-hidden p-3 xl:p-4">
            <div className={`grid h-full min-h-0 gap-3 ${pdfPreviewOpen ? 'grid-cols-1 2xl:grid-cols-2' : 'grid-cols-1'}`}>
              <AppErrorBoundary title="阅读工作区暂时不可用">
                <div className="h-full min-h-0">
                  <MarkdownEditor
                    onReaderViewChange={setReaderView}
                    onExportNotes={() => openExportSheet('notes')}
                    onVisibleExportModeChange={handleVisibleExportModeChange}
                    sourceProjection={sourceProjection}
                  />
                </div>
              </AppErrorBoundary>

              {pdfPreviewOpen && (
                <AppErrorBoundary title="PDF 预览暂时不可用">
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
        title="重新生成译文"
        description="当前语言的译文将被清除，并重新生成。"
        widthClassName="max-w-md"
      >
        <div className="space-y-4 px-6 py-6">
          <div className="rounded-2xl border border-red-100 bg-red-50/70 px-4 py-4 text-sm leading-6 text-red-700">
            当前语言的译文会被清空，并重新生成。原始 PDF、阅读稿、阅读笔记、提问记录不受影响。
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <button
              type="button"
              onClick={handleConfirmRestart}
              className="inline-flex items-center justify-center gap-2 rounded-2xl bg-red-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-red-700"
            >
              <RefreshCw size={15} />
              重新生成当前语言译文
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
        onClose={() => {
          setShowExport(false);
          setPreferredExportMode(null);
        }}
        fileHash={fileHash}
        fileName={activeFileName}
        currentView={readerView}
        preferredMode={preferredExportMode}
        targetLang={targetLang}
        targetLangLabel={targetLangLabel}
      />
    </>
  );
}
