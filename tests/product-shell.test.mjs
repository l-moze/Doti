import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const pageSource = fs.readFileSync("src/app/page.tsx", "utf-8");
const layoutSource = fs.readFileSync("src/app/layout.tsx", "utf-8");
const editorSource = fs.readFileSync("src/components/markdown-editor.tsx", "utf-8");
const exportSheetSource = fs.readFileSync("src/components/export-sheet.tsx", "utf-8");
const pdfViewerSource = fs.readFileSync("src/components/pdf-viewer.tsx", "utf-8");
const printSource = fs.readFileSync("src/app/print/page.tsx", "utf-8");
const translationStreamSource = fs.readFileSync("src/components/translation-stream.tsx", "utf-8");
const streamingTranslationPaneSource = fs.readFileSync("src/components/streaming-translation-pane.tsx", "utf-8");
const structuredSourceSource = fs.readFileSync("src/components/structured-source-view.tsx", "utf-8");
const markdownViewSource = fs.readFileSync("src/components/markdown-view.tsx", "utf-8");
const modalShellSource = fs.readFileSync("src/components/modal-shell.tsx", "utf-8");
const appErrorBoundarySource = fs.readFileSync("src/components/app-error-boundary.tsx", "utf-8");
const modelSelectorSource = fs.readFileSync("src/components/model-selector.tsx", "utf-8");
const arxivDialogSource = fs.readFileSync("src/components/arxiv-import-dialog.tsx", "utf-8");
const storagePanelSource = fs.readFileSync("src/components/storage-panel.tsx", "utf-8");
const providerProfileSource = fs.readFileSync("src/components/provider-profile-manager.tsx", "utf-8");
const glossarySource = fs.readFileSync("src/components/glossary-manager.tsx", "utf-8");
const storeSource = fs.readFileSync("src/lib/store.ts", "utf-8");
const paperPolishRouteSource = fs.readFileSync("src/app/api/paper-polish/route.ts", "utf-8");
const paperPolishSource = fs.readFileSync("src/lib/paper-polish.ts", "utf-8");
const translateRouteSource = fs.readFileSync("src/app/api/translate/route.ts", "utf-8");

test("home top bar keeps advanced controls out of the default toolbar", () => {
  const headerMatch = pageSource.match(/<header[\s\S]*?<\/header>/);
  assert.ok(headerMatch, "home page should render a header");

  const header = headerMatch[0];
  const moreButtonIndex = header.indexOf('aria-label="更多"');
  assert.ok(moreButtonIndex > 0, "advanced controls should move behind a More menu");

  const defaultToolbar = header.slice(0, moreButtonIndex);
  for (const hiddenLabel of ["模型配置", "存储", "术语", "重置"]) {
    assert.equal(
      defaultToolbar.includes(hiddenLabel),
      false,
      `${hiddenLabel} should be hidden from the default top toolbar`
    );
  }
  assert.equal(defaultToolbar.includes("'在线'"), false, "successful online state should not add noise to the default top toolbar");
  assert.ok(header.includes("离线"), "offline state should still have a clear warning label");
  assert.equal(header.includes("onContextMenu"), false, "primary action should not hide advanced actions behind a right-click menu");

  assert.ok(header.includes("导出当前视图"), "completed-state export should be framed as current-view export");
});

test("app metadata presents Doti as a reading workbench", () => {
  assert.ok(layoutSource.includes('title: "Doti - PDF 翻译阅读工作台"'), "browser title should use the Doti product name and task category");
  assert.ok(layoutSource.includes("导入 PDF 或论文后，可以生成译文、对照阅读、做笔记并导出当前视图"), "metadata description should explain the simple user workflow");

  for (const oldOrTechnicalCopy of ["乖积 PDF", "MinerU", "AI 辅助", "批注"]) {
    assert.equal(layoutSource.includes(oldOrTechnicalCopy), false, `${oldOrTechnicalCopy} should not appear in app metadata`);
  }
});

test("home top bar foregrounds the current document instead of the product shell", () => {
  const headerMatch = pageSource.match(/<header[\s\S]*?<\/header>/);
  assert.ok(headerMatch, "home page should render a header");

  const header = headerMatch[0];
  assert.ok(
    header.includes("<h1 className=\"truncate text-sm font-semibold text-slate-950\">{documentTitle}</h1>"),
    "top bar should promote the current document name into the primary title slot"
  );
  assert.equal(
    header.includes(">Doti</h1>"),
    false,
    "top bar should not make the product name the primary reading title"
  );
});

test("more menu keeps destructive and technical actions behind advanced settings", () => {
  const moreMenuStart = pageSource.indexOf("{moreMenuOpen ? (");
  assert.ok(moreMenuStart > 0, "home page should render a More menu");

  const advancedStart = pageSource.indexOf('aria-label="高级设置"', moreMenuStart);
  assert.ok(advancedStart > moreMenuStart, "More menu should have one advanced settings disclosure");

  const defaultMoreMenu = pageSource.slice(moreMenuStart, advancedStart);
  for (const hiddenLabel of ["重新翻译全部", "重新生成译文", "术语库", "固定译法", "高级模型设置", "自定义翻译服务", "存储管理", "本地数据", "清空当前工作台"]) {
    assert.equal(
      defaultMoreMenu.includes(hiddenLabel),
      false,
      `${hiddenLabel} should stay behind advanced settings instead of appearing in the first-level More menu`
    );
  }

  const advancedMenu = pageSource.slice(advancedStart, pageSource.indexOf("</header>", advancedStart));
  for (const technicalLabel of ["重新翻译全部", "术语库", "高级模型设置", "存储管理"]) {
    assert.equal(advancedMenu.includes(technicalLabel), false, `${technicalLabel} should not be the visible advanced-menu label`);
  }

  for (const advancedLabel of ["重新生成译文", "固定译法", "自定义翻译服务", "本地数据", "清空当前工作台"]) {
    assert.ok(advancedMenu.includes(advancedLabel), `${advancedLabel} should remain available inside advanced settings`);
  }
});

test("regenerate translation confirmation matches the advanced menu language", () => {
  const restartModalStart = pageSource.indexOf("open={showRestartConfirm}");
  assert.ok(restartModalStart > 0, "home page should keep a confirmation modal for regenerating translation");
  const restartModal = pageSource.slice(restartModalStart, pageSource.indexOf("<ArxivImportDialog", restartModalStart));

  assert.ok(restartModal.includes('title="重新生成译文"'), "confirmation title should match the advanced-menu action");
  assert.ok(restartModal.includes("当前语言的译文将被清除，并重新生成"), "confirmation should explain the visible result");
  assert.ok(restartModal.includes("重新生成当前语言译文"), "destructive confirmation button should use the same action language");

  for (const oldCopy of ["重新翻译", "从头重新翻译", "重新翻译当前语言"]) {
    assert.equal(restartModal.includes(oldCopy), false, `${oldCopy} should not appear in the regenerate confirmation`);
  }
});

test("closing the more menu resets advanced settings", () => {
  const moreMenuEffectStart = pageSource.indexOf("if (!moreMenuOpen) return;");
  assert.ok(moreMenuEffectStart > 0, "home page should close the More menu from outside interactions");
  const moreMenuEffectEnd = pageSource.indexOf("}, [moreMenuOpen]);", moreMenuEffectStart);
  assert.ok(moreMenuEffectEnd > moreMenuEffectStart, "More menu close effect should depend on moreMenuOpen");

  const moreMenuEffect = pageSource.slice(moreMenuEffectStart, moreMenuEffectEnd);
  assert.ok(
    moreMenuEffect.includes("setAdvancedMenuOpen(false)"),
    "closing the More menu should collapse advanced settings so the next open starts simple"
  );
});

test("empty import state has one dominant import entry", () => {
  const headerMatch = pageSource.match(/<header[\s\S]*?<\/header>/);
  assert.ok(headerMatch, "home page should render a header");

  const header = headerMatch[0];
  assert.ok(header.includes("!showImportLanding"), "header primary action should be hidden on the empty import landing");
  assert.ok(header.includes("!showImportLanding &&"), "header More menu should be hidden on the empty import landing");

  const importLandingMatch = pageSource.match(/\{showImportLanding \? \([\s\S]*?\)\s*:\s*\(/);
  assert.ok(importLandingMatch, "home page should render an import landing branch");
  assert.ok(importLandingMatch[0].includes("拖入 PDF，开始翻译阅读"), "import landing should provide the dominant empty-state import CTA");
  assert.ok(importLandingMatch[0].includes("'导入 PDF'"), "import landing primary button should use a direct import action");
  assert.ok(pageSource.includes("拖入 PDF 或点击导入"), "import landing hint should frame file picking as import");
  assert.ok(importLandingMatch[0].includes("导入论文"), "import landing should offer arXiv papers as direct paper import");
  assert.ok(importLandingMatch[0].includes("overflow-x-hidden"), "import landing shell should hide accidental horizontal overflow");
  assert.ok(importLandingMatch[0].includes("overflow-y-auto"), "import landing shell should scroll instead of clipping long recent-document lists");
  assert.ok(importLandingMatch[0].includes("items-start justify-center"), "import landing should keep the import card reachable when content is taller than the viewport");
  assert.ok(importLandingMatch[0].includes("max-w-[calc(100vw-2rem)]"), "import landing grid should stay inside narrow mobile viewports");
  assert.ok(importLandingMatch[0].includes("w-full max-w-full min-w-0 rounded-lg"), "import landing panels should be restrained and shrink on mobile");
  assert.ok(importLandingMatch[0].includes("p-5 sm:p-8"), "import landing should reduce panel padding on narrow screens");
  assert.ok(importLandingMatch[0].includes("break-words text-sm"), "import landing explanatory copy should wrap instead of forcing horizontal scroll");
  assert.equal(importLandingMatch[0].includes("'选择 PDF'"), false, "import landing should not weaken the primary action as file picking");
  assert.equal(pageSource.includes("arXiv 导入"), false, "paper import entry should not use source-first technical wording");
});

test("dragging a PDF onto the import landing works without MIME guesses", () => {
  assert.ok(pageSource.includes("function isPdfFile"), "home page should centralize PDF file detection");
  assert.ok(pageSource.includes("file.type === 'application/pdf'"), "PDF detection should accept browser MIME information");
  assert.ok(pageSource.includes("file.name.toLowerCase().endsWith('.pdf')"), "PDF detection should accept dragged files with an empty MIME type");
  assert.ok(pageSource.includes("const importPdfFile = useCallback"), "PDF import should be handled as one direct user action");
  assert.ok(pageSource.includes("dragFeedback"), "import landing should provide drag feedback");
  assert.ok(pageSource.includes("setDragFeedback('松开即可导入 PDF')"), "valid dragged PDFs should show a clear drop hint");
  assert.ok(pageSource.includes("setDragFeedback('请拖入 PDF 文件')"), "non-PDF drops should explain what to do");
  assert.ok(pageSource.includes("setDragFeedback(`正在导入 ${nextFile.name}`)"), "successful PDF picks should immediately enter the import flow");
  assert.ok(pageSource.includes("void retryParsing();"), "successful PDF picks should start preparing the reading draft without a second confirmation click");
  assert.equal(pageSource.includes("setDragFeedback(`已选择 ${droppedFile.name}`)"), false, "dropping a PDF should not stop at a selected-file confirmation");
  assert.equal(pageSource.includes("拖入 PDF 或点击选择"), false, "import hint should not use passive file-selection wording");
  assert.equal(pageSource.includes("文件已选择，下一步整理阅读稿"), false, "workflow hint should not describe a stale selected-file holding state");
  assert.ok(pageSource.includes("PDF 已准备好，联网后继续整理阅读稿"), "offline import hint should explain how the direct import flow resumes");
});

test("arXiv import reads like a direct paper import flow", () => {
  assert.equal(arxivDialogSource.includes("论文入口"), false, "arXiv dialog should not use a generic portal label");
  assert.equal(arxivDialogSource.includes("预览元数据"), false, "arXiv dialog should not lead with metadata preview");
  assert.equal(arxivDialogSource.includes("打开 PDF"), false, "arXiv dialog should not expose PDF as the primary action label");
  assert.ok(arxivDialogSource.includes("导入论文"), "arXiv dialog should use a direct import label");
  assert.ok(arxivDialogSource.includes("把 arXiv 论文直接导入到阅读工作台"), "arXiv dialog should explain the direct reading outcome");
  assert.ok(arxivDialogSource.includes("arXiv ID、论文链接都可以"), "arXiv dialog should tell users simple accepted inputs");
  assert.ok(arxivDialogSource.includes("立即导入"), "arXiv dialog should keep one clear primary action");
  assert.ok(arxivDialogSource.includes("查看论文信息"), "arXiv dialog should keep preview as a secondary action");
  assert.ok(arxivDialogSource.indexOf("立即导入") < arxivDialogSource.indexOf("查看论文信息"), "primary paper import action should appear before the secondary preview action");
  assert.ok(arxivDialogSource.includes("setError('请输入 arXiv ID 或链接')"), "arXiv dialog should reject empty input with direct guidance");
  assert.ok(arxivDialogSource.includes("没有找到论文信息，请检查 ID 或链接"), "preview failure should give a clear recovery step");
  assert.ok(arxivDialogSource.includes("没有导入成功，请检查 ID 或链接后再试"), "import failure should avoid source-first technical wording");
  assert.equal(arxivDialogSource.includes("预览 arXiv 信息失败"), false, "paper preview errors should not expose internal preview wording");
  assert.equal(arxivDialogSource.includes("导入 arXiv 失败"), false, "paper import errors should not expose source-first failure wording");
});

test("primary workbench surfaces avoid decorative card styling", () => {
  const primarySurfaceSource = [pageSource, editorSource, exportSheetSource, arxivDialogSource].join("\n");

  for (const decorativeClass of [
    "rounded-[28px]",
    "bg-[linear-gradient",
    "shadow-2xl",
  ]) {
    assert.equal(primarySurfaceSource.includes(decorativeClass), false, `${decorativeClass} should not appear in the primary workbench surfaces`);
  }

  assert.ok(pageSource.includes("rounded-lg border border-dashed border-slate-300 bg-white p-5 sm:p-8"), "empty import panel should read like a quiet work surface");
  assert.ok(editorSource.includes("relative flex h-full flex-col overflow-hidden rounded-lg border border-slate-200 bg-white"), "reader workspace should use a restrained document frame");
  assert.ok(exportSheetSource.includes("rounded-lg bg-slate-900"), "current-view export action should be direct without card-like decoration");
  assert.ok(arxivDialogSource.includes("rounded-lg border border-slate-200 bg-slate-50 p-5"), "paper import dialog should use a plain form panel");
});

test("reader messages and document blocks avoid oversized bubble styling", () => {
  assert.equal(editorSource.includes("rounded-[24px]"), false, "question history should not look like oversized chat bubbles");
  assert.equal(editorSource.includes('<span className="truncate">{conversation.prompt}</span>'), false, "saved questions should not be truncated in the reading panel");
  assert.ok(editorSource.includes('<div className="mt-1 whitespace-pre-wrap text-sm leading-6">{conversation.prompt}</div>'), "saved questions should remain fully readable");
  assert.equal(translationStreamSource.includes("rounded-3xl"), false, "translation blocks should use restrained workbench radii");
  assert.equal(translationStreamSource.includes("shadow-sm duration"), false, "streaming placeholders should avoid card shadows");
  assert.equal(structuredSourceSource.includes("rounded-3xl"), false, "structured source blocks should use restrained workbench radii");
});

test("unrecoverable parse failure asks for a fresh import", () => {
  assert.ok(pageSource.includes("canRecoverParsing"), "home page should distinguish recoverable parse failures");
  assert.ok(pageSource.includes("'重新导入 PDF'"), "unrecoverable parse failures should offer a fresh import");
  assert.ok(pageSource.includes("openFilePicker();"), "fresh import recovery should open the PDF picker");
  assert.equal(pageSource.includes("file ? undefined : '等待文件'"), false, "failure recovery should not leave the primary action as a disabled waiting state");
  assert.equal(pageSource.includes("'重新选择文件'"), false, "fresh-import recovery should use import language instead of file-selection wording");
});

test("top primary action uses one user task per workspace state", () => {
  const primaryLabelMatch = pageSource.match(/const primaryActionLabel = useMemo\(\(\) => \{[\s\S]*?\}, \[[^\]]+\]\);/);
  assert.ok(primaryLabelMatch, "home page should derive the top primary action in one place");
  const controlMetaMatch = pageSource.match(/const translationControlMeta = useMemo<TranslationControlMeta>\(\(\) => \{[\s\S]*?\n\s*\}, \[/);
  assert.ok(controlMetaMatch, "home page should derive status-specific primary action labels in one place");

  const primaryLabelSource = primaryLabelMatch[0];
  for (const expectedLabel of ["'导入 PDF'", "'导出当前视图'", "`翻译成 ${targetLangLabel}`", "'整理阅读稿'"]) {
    assert.ok(primaryLabelSource.includes(expectedLabel), `${expectedLabel} should be a direct top-level task`);
  }

  const controlMetaSource = controlMetaMatch[0];
  for (const expectedLabel of ["title: '整理阅读稿'", "title: '生成译文'", "title: '导出当前视图'"]) {
    assert.ok(controlMetaSource.includes(expectedLabel), `${expectedLabel} should be used for in-progress or completed primary action states`);
  }

  for (const internalLabel of ["'开始解析'", "'解析'", "'准备解析'", "'已解析'", "title: '整理中'", "title: '翻译中'", "title: '已完成'"]) {
    assert.equal(`${primaryLabelSource}\n${controlMetaSource}`.includes(internalLabel), false, `${internalLabel} should not be used as a primary action label`);
  }

  assert.ok(primaryLabelSource.includes("return translationControlMeta.title"), "in-progress and recovery states should use the status-specific control title");
});

test("top status labels describe the user-facing workflow stage", () => {
  const statusLabelMatch = pageSource.match(/function statusLabel\(status: string\): string \{[\s\S]*?\n\}/);
  assert.ok(statusLabelMatch, "home page should map runtime status to visible labels");

  const statusLabelSource = statusLabelMatch[0];
  for (const expectedLabel of ["'待导入'", "'准备文件'", "'整理阅读稿'", "'待翻译'", "'生成译文'", "'可阅读'", "'需处理'"]) {
    assert.ok(statusLabelSource.includes(expectedLabel), `${expectedLabel} should be used as a readable top status label`);
  }

  for (const machineLabel of ["'待命'", "'已整理'", "'异常'"]) {
    assert.equal(statusLabelSource.includes(machineLabel), false, `${machineLabel} should not be used as the top status label`);
  }
});

test("top progress appears only while work is actively running", () => {
  assert.ok(
    pageSource.includes("const showTopProgress = status === 'uploading' || status === 'parsing' || status === 'translating'"),
    "top progress should be limited to active import, reading-draft, and translation work"
  );

  const headerMatch = pageSource.match(/<header[\s\S]*?<\/header>/);
  assert.ok(headerMatch, "home page should render a header");
  const header = headerMatch[0];
  assert.ok(header.includes("{showTopProgress ? ("), "top progress indicator should be gated by the active-work flag");
  assert.equal(header.includes("{status !== 'idle' ? ("), false, "completed, failed, and waiting states should not keep a progress block in the top bar");
});

test("recent document progress uses workflow language instead of pipeline labels", () => {
  const historyProgressMatch = pageSource.match(/function renderProgressiveStatus\(itemStatus: string, itemProgress: number\) \{[\s\S]*?\n\}/);
  assert.ok(historyProgressMatch, "home page should render a compact recent-document progress status");

  const historyProgressSource = historyProgressMatch[0];
  for (const expectedCopy of ["导入", "整理", "翻译", "需要处理"]) {
    assert.ok(historyProgressSource.includes(expectedCopy), `${expectedCopy} should appear in recent-document progress copy`);
  }

  for (const pipelineCopy of [" 上传", " 解析", "处理异常"]) {
    assert.equal(historyProgressSource.includes(pipelineCopy), false, `${pipelineCopy} should not appear in recent-document progress copy`);
  }
});

test("selection popover exposes no more than three primary actions", () => {
  const selectionBlockMatch = editorSource.match(/\{selection && \([\s\S]*?\n\s*\)\}/);
  assert.ok(selectionBlockMatch, "editor should render a selection popover block");

  const selectionBlock = selectionBlockMatch[0];
  const buttonCount = (selectionBlock.match(/<button/g) || []).length;

  assert.equal(buttonCount, 3);
  assert.ok(selectionBlock.includes("解释"));
  assert.ok(selectionBlock.includes("改写"));
  assert.ok(selectionBlock.includes("记笔记"));
  assert.ok(
    selectionBlock.indexOf("解释") < selectionBlock.indexOf("改写") &&
    selectionBlock.indexOf("改写") < selectionBlock.indexOf("记笔记"),
    "selection popover should order actions as explain, rewrite, then note"
  );
  assert.equal(selectionBlock.includes("总结"), false);
  assert.equal(selectionBlock.includes("提取"), false);
});

test("reader workspace exposes translation compare and source views", () => {
  assert.ok(editorSource.includes("译文"), "reader should expose a translated reading view");
  assert.ok(editorSource.includes("对照"), "reader should expose a side-by-side compare view");
  assert.ok(editorSource.includes("原文"), "reader should expose a source reading view");
  assert.ok(editorSource.includes("comparePaneRef"), "reader should render a dedicated compare pane");
});

test("completed workspace keeps PDF preview available without splitting the default reading area", () => {
  const workspaceStart = pageSource.indexOf('className="min-h-0 flex-1 overflow-hidden p-3 xl:p-4"');
  assert.ok(workspaceStart > 0, "non-empty workspace should render a main content area");

  const workspaceArea = pageSource.slice(workspaceStart, pageSource.indexOf("</div>\r\n          </div>", workspaceStart));
  const readerIndex = workspaceArea.indexOf("<MarkdownEditor");
  const pdfIndex = workspaceArea.indexOf("<PDFViewer");

  assert.ok(readerIndex > 0, "workspace should render the reading editor");
  assert.ok(pdfIndex > 0, "workspace should keep the PDF preview available");
  assert.ok(readerIndex < pdfIndex, "reader should appear before the PDF preview in single-column layouts");
  assert.ok(pageSource.includes("const [pdfPreviewOpen, setPdfPreviewOpen] = useState(false)"), "PDF preview should start closed so reading keeps the default focus");
  assert.ok(workspaceArea.includes("pdfPreviewOpen ? 'grid-cols-1 2xl:grid-cols-2' : 'grid-cols-1'"), "workspace should split only after PDF preview is opened");
  assert.ok(workspaceArea.includes("{pdfPreviewOpen &&"), "PDF preview should be rendered on demand");
  assert.ok(pageSource.includes("显示 PDF 原文"), "More menu should expose a plain PDF preview entry");
  assert.ok(pageSource.includes("隐藏 PDF 原文"), "More menu should let users return to reading-only layout");
});

test("workspace navigation starts compact so reading keeps the default focus", () => {
  assert.ok(pageSource.includes("const [sidebarCollapsed, setSidebarCollapsed] = useState(true)"), "workspace sidebar should start collapsed");
  assert.ok(pageSource.includes("setSidebarCollapsed(false)"), "compact sidebar should keep an explicit expand path");
  assert.ok(pageSource.includes("sidebarCollapsed ? 'w-12' : 'w-64 xl:w-72'"), "collapsed sidebar should use a narrow icon rail");
});

test("reader view returns to the document default when switching documents or languages", () => {
  assert.ok(editorSource.includes("const [manualView, setManualView] = useState<ReaderView | null>(null)"), "reader should track manual view selection");

  const manualViewResetEffect = editorSource.match(/useEffect\(\(\) => \{\s*setManualView\(null\);\s*\}, \[fileHash, targetLang\]\);/);
  assert.ok(manualViewResetEffect, "manual reader view should reset when the document or target language changes");

  const transientResetStart = editorSource.indexOf("setSelection(null);");
  const transientResetEnd = editorSource.indexOf("}, [fileHash, activeDocumentTab]);", transientResetStart);
  assert.ok(transientResetStart > 0 && transientResetEnd > transientResetStart, "reader should still reset transient panel state when the active tab changes");
  const transientResetEffect = editorSource.slice(transientResetStart, transientResetEnd);
  assert.equal(
    transientResetEffect.includes("setManualView(null)"),
    false,
    "tab cleanup should not immediately undo a deliberate reader view switch"
  );
});

test("reader toolbar keeps cleanup tools behind one simple menu", () => {
  assert.ok(editorSource.includes("formatMenuOpen"), "reader should collapse document cleanup controls behind a menu");
  assert.ok(editorSource.includes('aria-label="整理阅读稿"'), "cleanup menu should have one clear default entry point");

  const headerStart = editorSource.indexOf('<div className="flex flex-wrap items-center justify-end gap-2 text-xs text-slate-500">');
  assert.ok(headerStart > 0, "reader header controls should be present");
  const menuStart = editorSource.indexOf("{formatMenuOpen ? (", headerStart);
  assert.ok(menuStart > headerStart, "cleanup menu content should be gated behind formatMenuOpen");

  const defaultHeaderControls = editorSource.slice(headerStart, menuStart);
  assert.ok(defaultHeaderControls.includes('aria-label="整理阅读稿"'), "cleanup tool should remain accessible from the reader toolbar");
  assert.ok(defaultHeaderControls.includes("className=\"sr-only\""), "cleanup label should be hidden visually so reading controls stay quiet");
  assert.equal(defaultHeaderControls.includes("paperPolishProcessing ? `整理中"), false, "cleanup progress should not make the default toolbar read like a maintenance console");
  assert.equal(defaultHeaderControls.includes(": '整理'"), false, "cleanup tool should not occupy the default toolbar as a text button");

  for (const hiddenCopy of ["自动整理", "清理格式", "AI 深修", "PaperPolish"]) {
    assert.equal(
      defaultHeaderControls.includes(hiddenCopy),
      false,
      `${hiddenCopy} should not be visible in the default reader toolbar`
    );
  }
});

test("reader side panel opens on demand instead of occupying the default reading area", () => {
  assert.ok(editorSource.includes("sidePanelOpen"), "reader should track whether the side panel is open");
  assert.equal(
    editorSource.includes('className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_360px]"'),
    false,
    "reader should not reserve side-panel width with a static layout class"
  );
  assert.ok(
    editorSource.includes("sidePanelOpen ? 'lg:grid-cols-[minmax(0,1fr)_360px]' : 'lg:grid-cols-1'"),
    "reader layout should switch to a side-panel column only when the panel is open"
  );
  assert.ok(editorSource.includes('aria-label="打开笔记和提问面板"'), "reader should expose one simple side-panel entry point");
  const launcherMatch = editorSource.match(/<div className="pointer-events-none absolute right-4 top-20 z-20 flex[\s\S]*?\n\s*<\/div>\n\s*\)\}/);
  assert.ok(launcherMatch, "reader should render one closed-state side-panel launcher");
  assert.equal((launcherMatch[0].match(/<button/g) || []).length, 1, "closed reader should not stack multiple floating side-panel buttons");
  assert.ok(launcherMatch[0].includes("笔记和提问"), "single side-panel launcher should name both available tools");
  assert.equal(launcherMatch[0].includes('aria-label="打开提问面板"'), false, "question entry should live inside the opened side panel, not as a second floating button");
  assert.ok(editorSource.includes("setSidePanelOpen(true)"), "selection and toolbar actions should be able to open the side panel");
  assert.ok(editorSource.includes("setSidePanelOpen(false)"), "side panel should provide a close action");

  const documentResetEffectMatch = editorSource.match(/useEffect\(\(\) => \{[\s\S]*?setExpandedConversationIds\(\{\}\);[\s\S]*?\}, \[fileHash, activeDocumentTab\]\);/);
  assert.ok(documentResetEffectMatch, "reader should reset transient panel state when the document changes");
  assert.ok(
    documentResetEffectMatch[0].includes("setSidePanelOpen(false)"),
    "switching documents should close the notes/question panel so the next document starts in reading mode"
  );
});

test("question panel names the active context explicitly", () => {
  assert.ok(editorSource.includes("当前上下文"), "question panel should label the context source explicitly");
  assert.ok(editorSource.includes("来自"), "question panel should say where the context comes from");
  assert.ok(editorSource.includes("第 ${sectionNumber} 节，第 ${itemNumber} 段"), "question context should describe paragraph location in reader language");
  assert.ok(editorSource.includes("activeAssistContextSourceLabel"), "question panel should derive one readable context source label");
  assert.ok(editorSource.includes("activeAssistContextLabel ? `来自 ${activeAssistContextLabel}` : '来自全文'"), "selected context should read as coming from a concrete reader location");
  assert.ok(editorSource.includes("buildContextLabelFromParts"), "context labels should be built from reader view and paragraph reference");
  assert.ok(editorSource.includes("buildConversationContextLabel"), "saved conversations should normalize older context labels");
  assert.ok(editorSource.includes("return tab ? `${getEditorTabLabel(tab)} · ${trimmed}` : trimmed"), "legacy saved context labels should gain their source or translation view");
  assert.ok(editorSource.includes("来自 {contextLabel}"), "saved questions should keep their source location visible");
  assert.ok(editorSource.includes("来自 {pendingAssistExchange.contextLabel}"), "pending questions should show the same context source while the answer is generating");
  assert.ok(editorSource.includes("所选片段"), "unresolved context should fall back to plain user-facing copy");
  assert.equal(editorSource.includes("return referenceLabel ? `来自${tabLabel}"), false, "context labels should not produce repeated source wording such as '来自 来自译文'");
  assert.equal(editorSource.includes("return semanticBlockId"), false, "question context should not leak raw semantic ids");
  assert.equal(editorSource.includes("return `@${blockLabel}`"), false, "question context should not use technical @-style anchors");
});

test("question panel keeps secondary assist actions behind suggestions", () => {
  assert.ok(editorSource.includes("assistSuggestionsOpen"), "question panel should track whether suggestions are expanded");
  assert.ok(editorSource.includes("建议"), "question panel should expose one simple suggestions entry point");

  const contextBarStart = editorSource.indexOf("当前上下文");
  assert.ok(contextBarStart > 0, "question panel context controls should be present");
  const suggestionsGateStart = editorSource.indexOf("{assistSuggestionsOpen ? (", contextBarStart);
  assert.ok(suggestionsGateStart > contextBarStart, "secondary assist actions should be gated behind suggestions");

  const defaultContextControls = editorSource.slice(contextBarStart, suggestionsGateStart);
  for (const hiddenAction of ["总结", "提取"]) {
    assert.equal(
      defaultContextControls.includes(hiddenAction),
      false,
      `${hiddenAction} should not appear as an always-visible question panel control`
    );
  }

  const suggestionsBlock = editorSource.slice(suggestionsGateStart, editorSource.indexOf("</div>", suggestionsGateStart));
  for (const retainedAction of ["总结", "提取"]) {
    assert.ok(suggestionsBlock.includes(retainedAction), `${retainedAction} should remain available inside suggestions`);
  }
});

test("question panel keeps context controls simple", () => {
  const contextBarStart = editorSource.indexOf("当前上下文");
  assert.ok(contextBarStart > 0, "question panel context controls should be present");
  const questionInputStart = editorSource.indexOf("<textarea", contextBarStart);
  assert.ok(questionInputStart > contextBarStart, "question panel should render the question input after context controls");

  const contextControls = editorSource.slice(contextBarStart, questionInputStart);
  assert.ok(contextControls.includes("activeAssistContextSourceLabel"), "context bar should render the readable context source label");
  assert.ok(editorSource.includes("'来自全文'"), "context source label should explain the default full-document context");
  assert.ok(contextControls.includes("全文"), "context bar should keep a plain way back to the full document");
  for (const hiddenControl of ["锁定", "更新", "解锁", "跟随"]) {
    assert.equal(
      contextControls.includes(hiddenControl),
      false,
      `${hiddenControl} should not appear as a default context-state control`
    );
  }
});

test("question request uses the same context priority shown in the panel", () => {
  assert.ok(
    editorSource.includes("const activeAssistContext = currentAssistSelection || assistTarget"),
    "question panel should show the current selection before falling back to older context"
  );
  assert.ok(
    editorSource.includes("const contextTarget = targetOverride || currentAssistSelection || assistTarget"),
    "question requests should use the same current-selection-first context priority as the visible panel"
  );
});

test("question panel full-document action really clears selection context", () => {
  const contextBarStart = editorSource.indexOf("当前上下文");
  assert.ok(contextBarStart > 0, "question panel context controls should be present");
  const questionInputStart = editorSource.indexOf("<textarea", contextBarStart);
  assert.ok(questionInputStart > contextBarStart, "question panel should render the question input after context controls");

  const contextControls = editorSource.slice(contextBarStart, questionInputStart);
  const fullActionStart = contextControls.indexOf("setAssistTarget(null)");
  assert.ok(fullActionStart > 0, "full-document action should clear the pinned assist target");
  const fullAction = contextControls.slice(fullActionStart, contextControls.indexOf("全文", fullActionStart));
  assert.ok(fullAction.includes("setSelectionMemory(null)"), "full-document action should clear remembered selection context");
  assert.ok(fullAction.includes("clearEditorSelection()"), "full-document action should clear the live text selection context");
});

test("export sheet defaults to the current reader view", () => {
  assert.ok(exportSheetSource.includes("currentView"), "export sheet should receive the active reader view");
  assert.ok(exportSheetSource.includes("currentMode"), "export sheet should map reader view to a print mode");
  assert.ok(printSource.includes("mode === 'source'"), "print page should support exporting the source view");
  assert.ok(exportSheetSource.includes("modeIncludesTranslation"), "export sheet should know which modes actually need translated content");
  assert.ok(exportSheetSource.includes("showMoreFormats"), "alternate export formats should be behind a disclosure");
  assert.ok(exportSheetSource.includes("更多导出方式"), "export sheet should use one simple label for alternate formats");
  assert.ok(exportSheetSource.includes("useEffect"), "export sheet should reset disclosure state between modal openings");
  assert.ok(exportSheetSource.includes("if (!open) setShowMoreFormats(false)"), "alternate formats should collapse when the export sheet closes");
  assert.equal(exportSheetSource.includes("打印预览"), false, "default export action should not expose the print-preview implementation");
  assert.ok(exportSheetSource.includes("导出预览"), "default export action should describe the visible export result");
  assert.ok(printSource.includes("正在准备导出预览"), "print page loading state should use export-preview language");
  assert.equal(printSource.includes("正在加载打印预览"), false, "print page loading state should not expose print-preview implementation wording");
  assert.ok(printSource.includes("保存为 PDF"), "print page primary action should describe the export result");
  assert.equal(printSource.includes("打印或保存 PDF"), false, "print page should not make the export flow sound like a print workflow");

  const primaryStart = exportSheetSource.indexOf("导出当前视图");
  assert.ok(primaryStart > 0, "export sheet should have a primary current-view action");
  const disclosureStart = exportSheetSource.indexOf("更多导出方式", primaryStart);
  assert.ok(disclosureStart > primaryStart, "alternate formats should appear after the current-view action");

  const primaryExportArea = exportSheetSource.slice(primaryStart, disclosureStart);
  for (const alternateLabel of ["仅导出译文", "原文 + 译文对照", "仅导出阅读笔记", "译文 + 批注工作稿"]) {
    assert.equal(
      primaryExportArea.includes(alternateLabel),
      false,
      `${alternateLabel} should not compete with the default current-view export action`
    );
  }

  const openPreviewMatch = exportSheetSource.match(/const openPrintPreview = async \(mode: ExportMode\) => \{[\s\S]*?const params = new URLSearchParams/);
  assert.ok(openPreviewMatch, "export sheet should build print preview params in one place");
  const artifactResolutionPath = openPreviewMatch[0];
  assert.ok(
    artifactResolutionPath.includes("if (modeIncludesTranslation(mode))"),
    "source-only and notes-only exports should not resolve translation cache artifacts"
  );
});

test("bilingual print preview preserves the side-by-side reader view", () => {
  assert.ok(printSource.includes("bilingualGridClassName"), "print preview should define a dedicated bilingual layout");
  assert.ok(printSource.includes("(mode === 'bilingual' || mode === 'bilingual-notes')"), "bilingual exports should render through their own compare branch");
  assert.ok(printSource.includes("grid gap-6 lg:grid-cols-2"), "bilingual preview should use a two-column layout on wide screens");
  assert.ok(printSource.includes("@media print"), "print stylesheet should control export rendering");
  assert.ok(printSource.includes(".print-bilingual"), "print stylesheet should include the bilingual layout class");

  assert.equal(
    printSource.includes("(mode === 'translation' || mode === 'bilingual')"),
    false,
    "bilingual mode should not be folded into the single-column translation section"
  );
  assert.equal(
    printSource.includes("(mode === 'source' || mode === 'bilingual')"),
    false,
    "bilingual mode should not be folded into the single-column source section"
  );
});

test("translation plus notes export reads like a visible reading draft", () => {
  assert.equal(exportSheetSource.includes("仅导出批注"), false, "notes-only export should not use annotation-management copy");
  assert.ok(exportSheetSource.includes("仅导出阅读笔记"), "notes-only export should use reader-facing wording");
  assert.equal(exportSheetSource.includes("译文 + 批注工作稿"), false, "notes export should not use tool-like draft wording");
  assert.ok(exportSheetSource.includes("译文 + 阅读笔记"), "notes export should use reader-facing wording");
  assert.ok(exportSheetSource.includes("原文 + 阅读笔记"), "current-view export should be able to name source plus notes");
  assert.ok(exportSheetSource.includes("对照 + 阅读笔记"), "current-view export should be able to name compare plus notes");
  assert.ok(exportSheetSource.includes("和你的阅读笔记一起导出"), "notes export description should explain the visible result");

  const notesModeStart = printSource.indexOf("mode === 'translation-notes'");
  assert.ok(notesModeStart > 0, "print preview should handle translation plus notes mode");
  const notesModeArea = printSource.slice(notesModeStart, printSource.indexOf("</div>\r\n        </main>", notesModeStart));
  const translationIndex = notesModeArea.indexOf("译文");
  const notesIndex = notesModeArea.indexOf("阅读笔记");

  assert.ok(translationIndex > 0, "translation plus notes export should include the translation");
  assert.ok(notesIndex > 0, "translation plus notes export should include reading notes");
  assert.ok(translationIndex < notesIndex, "translation should appear before notes in the exported reading draft");
  assert.equal(notesModeArea.includes("批注"), false, "translation plus notes export should avoid annotation-management copy");
  assert.ok(printSource.includes("mode === 'source-notes'"), "print preview should handle source plus notes mode");
  assert.ok(printSource.includes("mode === 'bilingual-notes'"), "print preview should handle compare plus notes mode");
});

test("notes panel exports through the current-view export flow", () => {
  assert.ok(pageSource.includes("preferredExportMode"), "home page should track a one-shot export mode from reader panels");
  assert.ok(pageSource.includes("openExportSheet('notes')"), "notes panel should open the export sheet in reading-notes mode");
  assert.ok(editorSource.includes("onExportNotes: () => void"), "reader should require a notes export callback instead of owning export internals");
  assert.ok(editorSource.includes("onClick={onExportNotes}"), "notes export action should go straight through the unified export callback");
  assert.ok(editorSource.includes("导出笔记"), "notes panel export action should name the visible reading notes");
  assert.equal(editorSource.includes("-annotations.md"), false, "notes panel should not expose annotation-file naming");
  assert.equal(editorSource.includes("reading-notes.md"), false, "notes panel should not expose a raw markdown note file");
  assert.equal(editorSource.includes("downloadTextFile"), false, "reader should not keep a second local-download export path");
  assert.equal(editorSource.includes("annotationListToMarkdown"), false, "reader should leave note export formatting to the export flow");
  assert.ok(exportSheetSource.includes("preferredMode ?? currentViewMode"), "export sheet should let reader panels choose the current export view");
  assert.ok(exportSheetSource.includes("currentMode === 'notes'"), "export sheet should describe notes as a first-class current view");
});

test("notes panel only shows the note composer after text is selected", () => {
  const noteComposerStart = editorSource.indexOf("新建笔记");
  assert.ok(noteComposerStart > 0, "notes panel should keep a note composer for selected text");
  const composerGateStart = editorSource.lastIndexOf("{activeNoteTarget ? (", noteComposerStart);
  assert.ok(composerGateStart > 0, "note composer should be gated behind an active text selection");

  const composerBlock = editorSource.slice(composerGateStart, editorSource.indexOf("{sortedAnnotations.length > 0", composerGateStart));
  assert.ok(composerBlock.includes("保存笔记"), "selected-text composer should still save notes");
  assert.ok(composerBlock.includes("已捕获选区"), "selected-text composer should confirm the captured selection");
  assert.ok(editorSource.includes("在正文中选中内容后，可以直接保存阅读笔记。"), "notes empty state should explain the selection-first workflow");
  assert.equal(composerBlock.includes("在正文中选中内容后"), false, "composer should not show a placeholder selection block once it is open");
});

test("top export follows visible reading notes panel", () => {
  assert.ok(pageSource.includes("readerPanelExportMode"), "home page should track export mode implied by the visible reader panel");
  assert.ok(pageSource.includes("mode ?? readerPanelExportMode"), "top export should use the visible reader panel when no explicit export mode is requested");
  assert.ok(editorSource.includes("onVisibleExportModeChange"), "reader should report visible panel export semantics to the shell");
  assert.ok(editorSource.includes("sidePanelOpen && sidePanelTab === 'notes'"), "notes side panel should be the condition that changes current-view export");
  assert.ok(editorSource.includes("activeView === 'compare'"), "notes export should preserve the current compare reader view");
  assert.ok(editorSource.includes("? 'bilingual-notes'"), "compare notes should export as compare plus notes");
  assert.ok(editorSource.includes("activeView === 'source'"), "notes export should preserve the current source reader view");
  assert.ok(editorSource.includes("? 'source-notes'"), "source notes should export as source plus notes");
  assert.ok(editorSource.includes("? 'translation-notes'"), "translation notes should export as translation plus notes");
  assert.ok(pageSource.includes("onVisibleExportModeChange={handleVisibleExportModeChange}"), "home page should subscribe to visible reader export mode changes");
});

test("question panel keeps model selection behind advanced controls", () => {
  const aiPanelHeaderMatch = editorSource.match(/<div className="shrink-0 border-b border-slate-200 bg-white px-3 py-2">[\s\S]*?<div ref=\{conversationListRef\}/);
  assert.ok(aiPanelHeaderMatch, "question panel header should be present");

  const aiPanelHeader = aiPanelHeaderMatch[0];
  const defaultHeader = aiPanelHeader.slice(0, aiPanelHeader.indexOf("{assistAdvancedOpen ?"));
  assert.equal(defaultHeader.includes("<ModelSelector"), false, "question panel should not expose raw model selection by default");
  assert.ok(defaultHeader.includes('aria-label="回答设置"'), "question model controls should be discoverable as a quiet settings action");
  assert.ok(defaultHeader.includes('title="回答设置"'), "quiet question settings action should still be named for hover users");
  assert.ok(defaultHeader.includes('aria-label="新建对话"'), "new conversation should remain available without adding a text button");
  assert.equal(defaultHeader.includes(">高级<"), false, "question panel header should not expose an advanced text button by default");
  assert.equal(defaultHeader.includes(">新建<"), false, "question panel header should not add a second text command beside the session picker");
  assert.ok(editorSource.includes("回答服务"), "advanced answer-service copy should use task language");
  assert.equal(editorSource.includes("回答模型"), false, "advanced answer-service copy should avoid model-first wording");
  assert.ok(modelSelectorSource.includes("正在加载可用服务"), "advanced selector loading state should use service language");
  assert.ok(modelSelectorSource.includes("可用服务加载失败"), "advanced selector failure state should use service language");
  assert.equal(modelSelectorSource.includes("正在加载模型"), false, "advanced selector should not expose model-first loading copy");
  assert.equal(modelSelectorSource.includes("模型列表加载失败"), false, "advanced selector should not expose model-first failure copy");
});

test("translation quality presets are simple and functional", () => {
  const qualityStart = pageSource.indexOf("翻译质量");
  assert.ok(qualityStart > 0, "More menu should render a translation quality section");

  const qualitySection = pageSource.slice(qualityStart, pageSource.indexOf("导出当前视图", qualityStart));
  for (const preset of ["快速", "平衡", "高质量"]) {
    assert.ok(pageSource.includes(`label: '${preset}'`), `${preset} preset should be configured as visible copy`);
  }

  assert.ok(qualitySection.includes("TRANSLATION_QUALITY_OPTIONS.map"), "quality section should render the simple presets");
  assert.ok(qualitySection.includes("onClick={() => setTranslationQualityPreset"), "quality presets should be clickable");
  assert.ok(qualitySection.includes("disabled={translationQualityPreset === preset.id || status === 'translating'}"), "quality controls should avoid accidental resets and mid-translation changes");
  assert.ok(qualitySection.includes("aria-pressed={translationQualityPreset === preset.id}"), "selected preset should be expressed as button state");
  assert.equal(qualitySection.includes("<ModelSelector"), false, "raw model selector should stay out of the default quality section");
  assert.ok(storeSource.includes("translationQualityPreset"), "selected quality preset should live in the store");
  assert.ok(storeSource.includes("setTranslationQualityPreset"), "store should expose a quality preset action");
  assert.ok(storeSource.includes("TRANSLATION_QUALITY_PRESETS"), "store should map presets to real translation model settings");
  assert.ok(storeSource.includes("if (current.translationQualityPreset === preset) return"), "reselecting the current quality preset should not clear the visible translation");
  assert.ok(storeSource.includes("if (previous.providerId === providerId && previous.model === model) return"), "reselecting the same service and model should be a no-op");
  assert.ok(storeSource.includes("get().setProvider(nextPreset.providerId, nextPreset.model)"), "preset selection should update the actual translation provider and model");
});

test("target language is shown as simple localized labels in the main flow", () => {
  assert.ok(pageSource.includes("TARGET_LANG_OPTIONS: Array<{ value: string; label: string }>"), "target language options should separate internal values from visible labels");
  assert.ok(pageSource.includes("getTargetLangLabel"), "home page should render a friendly target-language label");
  assert.ok(pageSource.includes("targetLangLabel"), "home page should derive the active target-language label once");
  assert.ok(pageSource.includes("翻译成 ${targetLangLabel}"), "primary action should use the visible language label");
  assert.equal(pageSource.includes("翻译成 ${targetLang}"), false, "primary action should not expose internal target-language values");
  assert.equal(pageSource.includes('placeholder="Chinese"'), false, "language picker should not show raw English enum copy as placeholder");
  assert.ok(pageSource.includes("{lang.label}"), "language picker options should show localized labels");
  const languageStart = pageSource.indexOf("目标语言");
  const languageSection = pageSource.slice(languageStart, pageSource.indexOf("翻译质量", languageStart));
  assert.ok(languageSection.includes("<select"), "target language control should be a bounded choice with visible labels");
  assert.equal(languageSection.includes("<input"), false, "target language control should not expose raw internal values through a text input");
  assert.ok(languageSection.includes("value={lang.value}"), "target language options should keep stable internal values");
  assert.ok(languageSection.includes("{lang.label}"), "target language options should render localized labels");

  assert.ok(exportSheetSource.includes("targetLangLabel"), "export sheet should receive a visible language label");
  assert.ok(exportSheetSource.includes("currentViewMeta"), "export sheet should derive the current-view export description");
  assert.ok(exportSheetSource.includes("translationLabel"), "export sheet should only mention target language when the export includes translated text");
  assert.equal(exportSheetSource.includes("导出语言：{targetLang}"), false, "export sheet should not expose raw target language values");

  assert.ok(printSource.includes("getTargetLangLabel"), "print preview should map target language to user-facing copy");
  assert.ok(printSource.includes("modeIncludesTranslation"), "print preview should know whether the selected export includes translated text");
  assert.ok(printSource.includes("printSubtitle"), "print preview should derive the subtitle from the export mode");
  assert.equal(printSource.includes("{modeLabel} · {targetLang}"), false, "print preview should not expose raw target language values");
  assert.equal(printSource.includes("{modeLabel} · {targetLangLabel}"), false, "source and notes exports should not always display a target language");
});

test("reader paragraphs can drive linked highlighting", () => {
  assert.ok(editorSource.includes("handleSemanticBlockClick"), "reader should have a semantic block click handler");
  assert.ok(editorSource.includes("closest<HTMLElement>('[data-semantic-block-id]'"), "click handler should target semantic blocks");
  assert.ok(editorSource.includes("setHighlightedBlock(semanticId)"), "clicking a semantic block should update the shared highlight");
  assert.ok(streamingTranslationPaneSource.includes("highlightedBlockId"), "translation pane should read the shared highlighted paragraph");
  assert.ok(translationStreamSource.includes("highlightedBlockId"), "translation stream should receive the active reader paragraph");
  assert.ok(translationStreamSource.includes("block.id === highlightedBlockId"), "translation blocks should highlight when they match the active semantic paragraph");
  assert.ok(translationStreamSource.includes("data-semantic-block-id={block.id}"), "clicking a translation block should update the same semantic highlight state");
  assert.ok(translationStreamSource.includes("data-semantic-active"), "translation highlights should expose the same active semantic marker as source blocks");
  assert.ok(editorSource.includes("const roots = [container, ...getMarkdownBodies(container)]"), "linked highlight lookup should include translation block wrappers outside markdown bodies");
  assert.ok(editorSource.includes("activeView === 'compare'"), "linked highlight lookup should respect the side-by-side reader view");
  assert.ok(editorSource.includes("compareTranslationPaneRef.current"), "compare translation pane should participate in linked highlight lookup");
  assert.ok(editorSource.includes("compareSourcePaneRef.current"), "compare source pane should participate in linked highlight lookup");
});

test("pdf preview visibly follows the active semantic paragraph", () => {
  assert.ok(pdfViewerSource.includes("semanticToPage"), "PDF viewer should resolve highlighted semantic blocks to pages");
  assert.ok(pdfViewerSource.includes("highlightedAnchorRef"), "PDF viewer should keep a ref to the active PDF anchor");
  assert.ok(pdfViewerSource.includes("scrollIntoView"), "PDF viewer should scroll the active PDF anchor into view");
  assert.ok(pdfViewerSource.includes("visibleAnchors"), "PDF viewer should render the active anchor even when layout overlays are hidden");
  assert.ok(pdfViewerSource.includes("sr-only"), "layout overlay toggle should remain accessible without adding visible noise");
  assert.ok(pdfViewerSource.includes("显示段落定位"), "PDF location toggle should use reader-facing positioning copy");
  assert.ok(pdfViewerSource.includes("PDF 预览暂时无法显示"), "PDF preview error should describe the user-visible result");
  assert.equal(pdfViewerSource.includes("显示结构定位层"), false, "PDF preview should not expose structural layer jargon");
  assert.equal(pdfViewerSource.includes("PDF 加载失败"), false, "PDF preview error should avoid raw loading-failure copy");
});

test("shared modal close action is localized", () => {
  assert.ok(modalShellSource.includes('aria-label="关闭"'), "shared modal close button should be understandable to Chinese readers");
  assert.equal(modalShellSource.includes('aria-label="Close"'), false, "shared modal close button should not expose English UI copy");
});

test("reader-facing copy avoids implementation jargon", () => {
  const productFacingSource = [
    pageSource,
    layoutSource,
    editorSource,
    exportSheetSource,
    pdfViewerSource,
    printSource,
    translationStreamSource,
    streamingTranslationPaneSource,
    structuredSourceSource,
    markdownViewSource,
    modalShellSource,
    appErrorBoundarySource,
  ].join("\n");
  const forbiddenVisibleCopy = [
    "MinerU 处理中",
    "MinerU 正在解析 PDF",
    "已生成 Markdown",
    "Markdown 工作区",
    "Markdown 标题",
    "Markdown 渲染模块热更新失败",
    "富文本渲染",
    "阅读工作区异常",
    "PDF 预览面板异常",
    "面板发生错误",
    "显示结构定位层",
    "PDF 加载失败",
    "当前目标语言的译文缓存",
    "Markdown 草稿",
    "原始翻译缓存",
    "_No source content available_",
    "_No translation available_",
    "_No annotations_",
    "_Empty note_",
    "_暂无批注_",
    "Missing `fileHash`",
    "PaperPolish 已就绪",
    "AI 深修中",
    "AI 深修",
    "AI 辅助",
    "AI 助手",
    "AI 模型",
    "打开 AI 辅助面板",
    "'Translation'",
    "'Source'",
    "Assistant 正在回复",
    ">Assistant<",
    "aria-label=\"Delete annotation\"",
    "aria-label=\"Delete conversation\"",
    "如 proof, todo",
    "服务端队列",
    "拆分队列",
    "等待模型返回",
    "正在并发生成译文",
    "并发翻译中",
    "Unknown error",
    "暂无历史任务",
    "翻译任务进行中",
    "任务异常",
    "任务遇到问题",
    "解析异常",
    "翻译异常",
    "翻译失败",
    "翻译中断",
    "当前文档整理中断",
    "恢复当前解析任务",
    "当前解析任务中断",
    "上方会话下拉框",
    "点击顶部",
    "系统会边生成",
    "正在整理 PDF 内容",
    "正在解析 PDF",
    "解析中",
    "开始解析",
    "解析文档",
    "准备解析",
    "下一步开始解析",
    "处理 PDF 后会在这里生成大纲",
    "当前文档解析中断",
    "继续解析",
    "重新解析",
    "原始 PDF、解析结果",
    "上传或导入 PDF 后",
    "可以阅读、批注或导出当前视图",
    "原始 PDF、解析结果、批注、提问记录不受影响",
    "在左侧正文中",
    "先在左侧选中",
    "回到原文",
    "请求已经发出",
    "文件已选择",
    "重新选择文件",
  ];

  for (const copy of forbiddenVisibleCopy) {
    assert.equal(productFacingSource.includes(copy), false, `${copy} should not appear in reader-facing copy`);
  }

  assert.ok(productFacingSource.includes("正在整理阅读稿"), "parse progress should describe a user-facing reading draft");
  assert.ok(productFacingSource.includes("阅读稿已准备好"), "parsed state should avoid exposing internal document formats");
  assert.ok(productFacingSource.includes("正在准备文件"), "upload progress should avoid exposing backend queue concepts");
  assert.ok(productFacingSource.includes("暂无历史文档"), "empty history should speak in document language");
  assert.ok(productFacingSource.includes("正在生成译文"), "translation progress should speak in reading-result language");
  assert.ok(productFacingSource.includes("处理遇到问题"), "recoverable failures should use product-flow language");
  assert.ok(productFacingSource.includes("整理遇到问题"), "reader parse failures should use task-language recovery copy");
  assert.ok(productFacingSource.includes("生成译文遇到问题"), "reader translation failures should use task-language recovery copy");
  assert.ok(productFacingSource.includes("继续生成译文"), "resumable translation should keep the generate-translation task language");
  assert.ok(productFacingSource.includes("译文会逐段出现在这里"), "parsed translation pane should describe the visible result instead of giving toolbar instructions");
  assert.ok(productFacingSource.includes("导入 PDF 后，这里会显示阅读内容和笔记"), "empty reader workspace should describe the visible workspace outcome");
  assert.ok(productFacingSource.includes("在正文中选中内容后"), "notes panel should not assume a fixed left-side layout");
  assert.ok(productFacingSource.includes("先在正文中选中一段文字"), "question empty state should not assume a fixed left-side layout");
  assert.ok(productFacingSource.includes("回到位置"), "note navigation should work for both source and translation notes");
  assert.ok(productFacingSource.includes("正在准备这一段译文"), "translation stream placeholders should use reader-facing progress copy");
  assert.ok(productFacingSource.includes("阅读内容暂时使用简化显示"), "fallback rendering should explain the visible reading result");
  assert.ok(productFacingSource.includes("阅读工作区暂时不可用"), "error boundary should name the user-facing workspace in recoverable language");
  assert.ok(productFacingSource.includes("这里暂时无法显示，请刷新页面后重试"), "error boundary fallback should explain the visible result and recovery step");
});

test("runtime progress copy avoids implementation jargon", () => {
  const runtimeUserCopy = [storeSource, paperPolishRouteSource, paperPolishSource, translateRouteSource].join("\n");

  for (const forbiddenCopy of [
    "AI 深修",
    "等待模型返回",
    "并发翻译",
    "并发批次",
    "翻译任务",
    "翻译流",
    "同配置",
    "PaperPolish 执行失败",
    "翻译已中断",
    "解析批次",
    "重新上传 PDF",
    "模型配置",
    "局部窗口",
    "兜底",
  ]) {
    assert.equal(runtimeUserCopy.includes(forbiddenCopy), false, `${forbiddenCopy} should not be shown by runtime progress copy`);
  }

  for (const expectedCopy of [
    "正在整理阅读稿格式",
    "正在修复难处理的段落",
    "正在准备译文",
    "正在生成译文",
    "生成译文没有完成",
    "这个文档正在生成译文",
    "这个文档正在其他窗口生成译文",
    "阅读稿整理失败",
  ]) {
    assert.ok(runtimeUserCopy.includes(expectedCopy), `${expectedCopy} should appear in runtime progress copy`);
  }
});

test("workflow error copy is normalized before reaching the reader UI", () => {
  assert.ok(storeSource.includes("function getUserFacingErrorMessage"), "store should keep a small user-facing error normalizer");
  assert.ok(editorSource.includes("getUserFacingErrorMessage(message)"), "question panel errors should use the shared workflow error normalizer");
  assert.ok(providerProfileSource.includes("getServiceTestErrorMessage"), "custom service tests should collapse backend errors into setup guidance");
  assert.equal(storeSource.includes("error: data.error || 'Parsing failed'"), false, "parse errors should not be assigned directly from backend responses");
  assert.equal(storeSource.includes("error: rawMessage,"), false, "translation stream errors should not expose raw backend messages");
  assert.equal(editorSource.includes("setAssistError(assistRequestError instanceof Error ? assistRequestError.message"), false, "question panel should not show raw request errors");

  for (const expectedCopy of [
    "阅读稿整理失败，请稍后重试或重新导入 PDF。",
    "PDF 没有导入成功，请稍后重试。",
    "没有找到论文信息，请检查 ID 或链接。",
    "这个文档正在其他窗口生成译文，请等待完成后再试。",
    "之前的生成进度不可继续，请重新生成译文。",
    "生成暂时受限，稍后可以继续生成。",
    "网络连接不稳定，请稍后重试。",
  ]) {
    assert.ok(storeSource.includes(expectedCopy), `${expectedCopy} should be available for workflow error recovery`);
  }
});

test("storage management panel uses maintenance language instead of browser internals", () => {
  const forbiddenStorageCopy = [
    "浏览器存储配额",
    "离线缓存层",
    "持久化状态",
    "请求持久化",
    "Service Worker",
    "Cache Storage",
    "缓存容器",
    "派生缓存",
    "工作镜像",
    "知识层",
    "provider 配置",
    "删除本机批注",
  ];

  for (const copy of forbiddenStorageCopy) {
    assert.equal(storagePanelSource.includes(copy), false, `${copy} should not be visible storage-panel copy`);
  }

  for (const expectedCopy of [
    'title="本地数据"',
    "管理临时文件、阅读记录和个人设置",
    "已占用空间",
    "重要数据保护",
    "离线文件",
    "清理临时文件",
    "清理阅读记录",
    "清理个人设置",
    "离线文件包 {index + 1}",
  ]) {
    assert.ok(storagePanelSource.includes(expectedCopy), `${expectedCopy} should appear in storage maintenance copy`);
  }

  assert.equal(storagePanelSource.includes("title={cacheName}"), false, "offline file labels should not expose raw cache names on hover");
});

test("custom model panel presents services instead of provider-console wording", () => {
  const forbiddenProviderCopy = [
    "已保存的 Provider",
    "新增 Provider",
    "Provider 类型",
    "还没有自定义 provider",
    "Endpoint 和默认模型不能为空",
    "名称、服务地址和默认模型不能为空",
    "测试前请先填写 Endpoint",
    "OpenAI-compatible provider 可用于",
    "OpenAI-compatible 或 DeepLX 端点",
    "source_lang",
    "术语表",
    "glossary ID",
    "<option value=\"openai-compatible\">OpenAI-compatible</option>",
    "{profile.providerType}",
    "glossary ·",
    "AUTO",
    "使用 glossary 时填写",
    "问答模型列表",
    "可选模型",
    "默认模型 / 标识",
    "AI 辅助",
    "能力范围",
  ];

  for (const copy of forbiddenProviderCopy) {
    assert.equal(providerProfileSource.includes(copy), false, `${copy} should not be visible custom-model copy`);
  }

  for (const expectedCopy of [
    'title="自定义翻译服务"',
    "添加自建或第三方翻译服务",
    "已保存的服务",
    "新增服务",
    "服务类型",
    "OpenAI 兼容服务",
    "服务地址",
    "访问密钥",
    "服务标识",
    "固定译法 ID（可选）",
    "原文语言（可选）",
    "还没有自定义服务",
    "可用服务",
    "问答",
    "使用场景",
    "固定译法 ·",
    "自动识别原文语言",
  ]) {
    assert.ok(providerProfileSource.includes(expectedCopy), `${expectedCopy} should appear in custom service copy`);
  }
});

test("glossary panel is framed as fixed translation preferences", () => {
  const forbiddenGlossaryCopy = [
    'title="用户术语库"',
    "用户术语会覆盖内置词库",
    "模型提示",
    "原术语",
    "目标术语",
    "分类，如 vision / math",
    "新增术语默认启用",
    "搜索术语、翻译或分类",
    "导入 CSV",
    "导出 CSV",
    "导出 JSON",
    ">Source<",
    ">Target<",
    ">Category<",
    ">Status<",
    ">Action<",
    "正在读取术语库",
    "还没有用户术语，可以先手动添加或导入 CSV。",
    "aria-label={`Delete ${record.source}`}",
  ];

  for (const copy of forbiddenGlossaryCopy) {
    assert.equal(glossarySource.includes(copy), false, `${copy} should not be visible fixed-translation copy`);
  }

  for (const expectedCopy of [
    'title="固定译法"',
    "把论文里的固定写法翻译成你习惯的说法",
    "原文写法",
    "固定译法",
    "使用场景",
    "新增后立即用于翻译",
    "搜索原文、译法或场景",
    "导入词表",
    "导出词表",
    "备份数据",
    "原文",
    "译法",
    "场景",
    "使用中",
    "暂停中",
    "删除固定译法",
    "还没有固定译法",
  ]) {
    assert.ok(glossarySource.includes(expectedCopy), `${expectedCopy} should appear in fixed-translation copy`);
  }

  assert.ok(glossarySource.includes("onClick={exportJson}"), "glossary data backup should keep the existing JSON export path available");
  assert.ok(glossarySource.includes("'原文写法,固定译法,使用场景,是否使用'"), "exported term sheet should use user-facing column names");
  assert.ok(glossarySource.includes("parts[0]?.includes('原文写法')"), "import should recognize the user-facing term sheet header");
});

test("translation workspace exposes a clear edit entry point", () => {
  assert.ok(editorSource.includes("translationEditMode"), "translation workspace should track edit mode");
  assert.ok(editorSource.includes("编辑译文"), "translation workspace should expose an edit translation action");
  assert.ok(editorSource.includes("编辑当前译文"), "translation edit mode should read like editing the visible translation");
  assert.ok(editorSource.includes("导出当前视图会使用这版译文"), "edit mode should connect saves to the WYSIWYG export result");
  assert.ok(editorSource.includes("保存编辑"), "translation editing should have a save action");
  assert.equal(editorSource.includes("下载副本"), false, "translation editing should not add a second export path");
  assert.equal(editorSource.includes("-edited.md"), false, "translation editing should not expose an internal draft file");
  const editModeStart = editorSource.indexOf("translationEditMode ? (");
  assert.ok(editModeStart > 0, "translation edit mode should render an inline editor");
  const editModeEnd = editorSource.indexOf("<StreamingTranslationPane", editModeStart);
  assert.ok(editModeEnd > editModeStart, "translation edit block should appear before the normal translation pane");
  const editModeBlock = editorSource.slice(editModeStart, editModeEnd);
  assert.equal(editModeBlock.includes("font-mono"), false, "translation editing should not look like a code editor");
  assert.equal(editModeBlock.includes("spellCheck={false}"), false, "translation editing should keep normal writing assistance available");
  assert.ok(editModeBlock.includes('aria-label="编辑当前译文"'), "translation editing surface should have a clear accessible name");
});

test("translation edits save back into the current workspace", () => {
  assert.ok(storeSource.includes("saveEditedTranslation"), "store should expose a first-class edited translation save action");
  assert.ok(storeSource.includes("targetMarkdown: editedMarkdown"), "edited translation should update the current target markdown");
  assert.ok(storeSource.includes("translationBlocks: []"), "manual edits should become the canonical rendered target");
  assert.ok(storeSource.includes("persistActiveDocumentSnapshot"), "manual edits should be persisted with the active document snapshot");
  assert.ok(editorSource.includes("saveEditedTranslation(translationEditDraft)"), "editor save should write back to the current workspace");
  assert.equal(editorSource.includes("当前保存会下载本地编辑稿"), false, "primary save should not be framed as download-only");
});

test("print preview prefers the current workspace draft over cached artifacts", () => {
  assert.ok(printSource.includes("useTranslationStore.persist.rehydrate()"), "print preview should hydrate the persisted workspace state");
  assert.ok(printSource.includes("workspaceFileHash === fileHash"), "print preview should only reuse workspace content for the same document");
  assert.ok(printSource.includes("workspaceTargetLang === targetLang"), "edited translations should only override matching export languages");
  assert.ok(printSource.includes("workspaceTargetMarkdown.trim()"), "print preview should detect an edited current translation");
  assert.ok(printSource.includes("setSourceMarkdown(workspaceSourceMarkdown)"), "source exports should also reflect the current workspace source");

  const targetPreferenceMatch = printSource.match(
    /if \([\s\S]*workspaceTargetMarkdown\.trim\(\)[\s\S]*\) \{[\s\S]*setTargetMarkdown\(workspaceTargetMarkdown\);[\s\S]*return;[\s\S]*\}[\s\S]*const translationCandidates/
  );
  assert.ok(targetPreferenceMatch, "edited workspace translation should be applied before falling back to cached translation files");
});
