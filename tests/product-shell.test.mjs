import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const pageSource = fs.readFileSync("src/app/page.tsx", "utf-8");
const editorSource = fs.readFileSync("src/components/markdown-editor.tsx", "utf-8");
const exportSheetSource = fs.readFileSync("src/components/export-sheet.tsx", "utf-8");
const pdfViewerSource = fs.readFileSync("src/components/pdf-viewer.tsx", "utf-8");
const printSource = fs.readFileSync("src/app/print/page.tsx", "utf-8");
const storagePanelSource = fs.readFileSync("src/components/storage-panel.tsx", "utf-8");
const providerProfileSource = fs.readFileSync("src/components/provider-profile-manager.tsx", "utf-8");
const glossarySource = fs.readFileSync("src/components/glossary-manager.tsx", "utf-8");
const storeSource = fs.readFileSync("src/lib/store.ts", "utf-8");

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

test("more menu keeps destructive and technical actions behind advanced settings", () => {
  const moreMenuStart = pageSource.indexOf("{moreMenuOpen ? (");
  assert.ok(moreMenuStart > 0, "home page should render a More menu");

  const advancedStart = pageSource.indexOf('aria-label="高级设置"', moreMenuStart);
  assert.ok(advancedStart > moreMenuStart, "More menu should have one advanced settings disclosure");

  const defaultMoreMenu = pageSource.slice(moreMenuStart, advancedStart);
  for (const hiddenLabel of ["重新翻译全部", "术语库", "高级模型设置", "存储管理", "清空当前工作台"]) {
    assert.equal(
      defaultMoreMenu.includes(hiddenLabel),
      false,
      `${hiddenLabel} should stay behind advanced settings instead of appearing in the first-level More menu`
    );
  }

  const advancedMenu = pageSource.slice(advancedStart, pageSource.indexOf("</header>", advancedStart));
  for (const advancedLabel of ["重新翻译全部", "术语库", "高级模型设置", "存储管理", "清空当前工作台"]) {
    assert.ok(advancedMenu.includes(advancedLabel), `${advancedLabel} should remain available inside advanced settings`);
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
});

test("dragging a PDF onto the import landing works without MIME guesses", () => {
  assert.ok(pageSource.includes("function isPdfFile"), "home page should centralize PDF file detection");
  assert.ok(pageSource.includes("file.type === 'application/pdf'"), "PDF detection should accept browser MIME information");
  assert.ok(pageSource.includes("file.name.toLowerCase().endsWith('.pdf')"), "PDF detection should accept dragged files with an empty MIME type");
  assert.ok(pageSource.includes("dragFeedback"), "import landing should provide drag feedback");
  assert.ok(pageSource.includes("setDragFeedback('松开即可导入 PDF')"), "valid dragged PDFs should show a clear drop hint");
  assert.ok(pageSource.includes("setDragFeedback('请拖入 PDF 文件')"), "non-PDF drops should explain what to do");
  assert.ok(pageSource.includes("setDragFeedback(`已选择 ${droppedFile.name}`)"), "successful drops should confirm the selected file");
});

test("unrecoverable parse failure asks for a fresh import", () => {
  assert.ok(pageSource.includes("canRecoverParsing"), "home page should distinguish recoverable parse failures");
  assert.ok(pageSource.includes("'重新导入 PDF'"), "unrecoverable parse failures should offer a fresh import");
  assert.ok(pageSource.includes("openFilePicker();"), "fresh import recovery should open the PDF picker");
  assert.equal(pageSource.includes("file ? undefined : '等待文件'"), false, "failure recovery should not leave the primary action as a disabled waiting state");
});

test("selection popover exposes no more than three primary actions", () => {
  const selectionBlockMatch = editorSource.match(/\{selection && \([\s\S]*?\n\s*\)\}/);
  assert.ok(selectionBlockMatch, "editor should render a selection popover block");

  const selectionBlock = selectionBlockMatch[0];
  const buttonCount = (selectionBlock.match(/<button/g) || []).length;

  assert.equal(buttonCount, 3);
  assert.ok(selectionBlock.includes("记笔记"));
  assert.ok(selectionBlock.includes("解释"));
  assert.ok(selectionBlock.includes("改写"));
  assert.equal(selectionBlock.includes("总结"), false);
  assert.equal(selectionBlock.includes("提取"), false);
});

test("reader workspace exposes translation compare and source views", () => {
  assert.ok(editorSource.includes("译文"), "reader should expose a translated reading view");
  assert.ok(editorSource.includes("对照"), "reader should expose a side-by-side compare view");
  assert.ok(editorSource.includes("原文"), "reader should expose a source reading view");
  assert.ok(editorSource.includes("comparePaneRef"), "reader should render a dedicated compare pane");
});

test("completed workspace prioritizes the reader before the PDF preview", () => {
  const workspaceStart = pageSource.indexOf('className="min-h-0 flex-1 overflow-hidden p-3 xl:p-4"');
  assert.ok(workspaceStart > 0, "non-empty workspace should render a main content area");

  const workspaceArea = pageSource.slice(workspaceStart, pageSource.indexOf("</div>\r\n          </div>", workspaceStart));
  const readerIndex = workspaceArea.indexOf("<MarkdownEditor");
  const pdfIndex = workspaceArea.indexOf("<PDFViewer");

  assert.ok(readerIndex > 0, "workspace should render the reading editor");
  assert.ok(pdfIndex > 0, "workspace should keep the PDF preview available");
  assert.ok(readerIndex < pdfIndex, "reader should appear before the PDF preview in single-column layouts");
  assert.ok(workspaceArea.includes("2xl:grid-cols-2"), "wide screens should still support side-by-side reading and PDF preview");
});

test("workspace navigation starts compact so reading keeps the default focus", () => {
  assert.ok(pageSource.includes("const [sidebarCollapsed, setSidebarCollapsed] = useState(true)"), "workspace sidebar should start collapsed");
  assert.ok(pageSource.includes("setSidebarCollapsed(false)"), "compact sidebar should keep an explicit expand path");
  assert.ok(pageSource.includes("sidebarCollapsed ? 'w-12' : 'w-64 xl:w-72'"), "collapsed sidebar should use a narrow icon rail");
});

test("reader toolbar keeps cleanup tools behind one simple menu", () => {
  assert.ok(editorSource.includes("formatMenuOpen"), "reader should collapse document cleanup controls behind a menu");
  assert.ok(editorSource.includes('aria-label="整理阅读稿"'), "cleanup menu should have one clear default entry point");

  const headerStart = editorSource.indexOf('<div className="flex flex-wrap items-center justify-end gap-2 text-xs text-slate-500">');
  assert.ok(headerStart > 0, "reader header controls should be present");
  const menuStart = editorSource.indexOf("{formatMenuOpen ? (", headerStart);
  assert.ok(menuStart > headerStart, "cleanup menu content should be gated behind formatMenuOpen");

  const defaultHeaderControls = editorSource.slice(headerStart, menuStart);
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
  assert.ok(editorSource.includes("所选片段"), "unresolved context should fall back to plain user-facing copy");
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

test("export sheet defaults to the current reader view", () => {
  assert.ok(exportSheetSource.includes("currentView"), "export sheet should receive the active reader view");
  assert.ok(exportSheetSource.includes("currentMode"), "export sheet should map reader view to a print mode");
  assert.ok(printSource.includes("mode === 'source'"), "print page should support exporting the source view");
  assert.ok(exportSheetSource.includes("modeIncludesTranslation"), "export sheet should know which modes actually need translated content");
  assert.ok(exportSheetSource.includes("showMoreFormats"), "alternate export formats should be behind a disclosure");
  assert.ok(exportSheetSource.includes("更多导出方式"), "export sheet should use one simple label for alternate formats");
  assert.ok(exportSheetSource.includes("useEffect"), "export sheet should reset disclosure state between modal openings");
  assert.ok(exportSheetSource.includes("if (!open) setShowMoreFormats(false)"), "alternate formats should collapse when the export sheet closes");

  const primaryStart = exportSheetSource.indexOf("导出当前视图");
  assert.ok(primaryStart > 0, "export sheet should have a primary current-view action");
  const disclosureStart = exportSheetSource.indexOf("更多导出方式", primaryStart);
  assert.ok(disclosureStart > primaryStart, "alternate formats should appear after the current-view action");

  const primaryExportArea = exportSheetSource.slice(primaryStart, disclosureStart);
  for (const alternateLabel of ["仅导出译文", "原文 + 译文对照", "仅导出批注", "译文 + 批注工作稿"]) {
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
  assert.ok(printSource.includes("mode === 'bilingual' &&"), "bilingual export should render through its own compare branch");
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
  assert.equal(exportSheetSource.includes("译文 + 批注工作稿"), false, "notes export should not use tool-like draft wording");
  assert.ok(exportSheetSource.includes("译文 + 阅读笔记"), "notes export should use reader-facing wording");
  assert.ok(exportSheetSource.includes("和你的阅读笔记一起导出"), "notes export description should explain the visible result");

  const notesModeStart = printSource.indexOf("mode === 'bilingual-notes'");
  assert.ok(notesModeStart > 0, "print preview should handle translation plus notes mode");
  const notesModeArea = printSource.slice(notesModeStart, printSource.indexOf("</div>\r\n        </main>", notesModeStart));
  const translationIndex = notesModeArea.indexOf("译文");
  const notesIndex = notesModeArea.indexOf("阅读笔记");

  assert.ok(translationIndex > 0, "translation plus notes export should include the translation");
  assert.ok(notesIndex > 0, "translation plus notes export should include reading notes");
  assert.ok(translationIndex < notesIndex, "translation should appear before notes in the exported reading draft");
  assert.equal(notesModeArea.includes("批注"), false, "translation plus notes export should avoid annotation-management copy");
});

test("question panel keeps model selection behind advanced controls", () => {
  const aiPanelHeaderMatch = editorSource.match(/<div className="shrink-0 border-b border-slate-200 bg-white px-3 py-2">[\s\S]*?<div ref=\{conversationListRef\}/);
  assert.ok(aiPanelHeaderMatch, "question panel header should be present");

  const aiPanelHeader = aiPanelHeaderMatch[0];
  const defaultHeader = aiPanelHeader.slice(0, aiPanelHeader.indexOf("{assistAdvancedOpen ?"));
  assert.equal(defaultHeader.includes("<ModelSelector"), false, "question panel should not expose raw model selection by default");
  assert.ok(aiPanelHeader.includes("高级"), "question model controls should be discoverable as an advanced option");
  assert.ok(editorSource.includes("回答模型"), "advanced model copy should use task language");
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
  assert.ok(qualitySection.includes("aria-pressed={translationQualityPreset === preset.id}"), "selected preset should be expressed as button state");
  assert.equal(qualitySection.includes("<ModelSelector"), false, "raw model selector should stay out of the default quality section");
  assert.ok(storeSource.includes("translationQualityPreset"), "selected quality preset should live in the store");
  assert.ok(storeSource.includes("setTranslationQualityPreset"), "store should expose a quality preset action");
  assert.ok(storeSource.includes("TRANSLATION_QUALITY_PRESETS"), "store should map presets to real translation model settings");
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
});

test("pdf preview visibly follows the active semantic paragraph", () => {
  assert.ok(pdfViewerSource.includes("semanticToPage"), "PDF viewer should resolve highlighted semantic blocks to pages");
  assert.ok(pdfViewerSource.includes("highlightedAnchorRef"), "PDF viewer should keep a ref to the active PDF anchor");
  assert.ok(pdfViewerSource.includes("scrollIntoView"), "PDF viewer should scroll the active PDF anchor into view");
  assert.ok(pdfViewerSource.includes("visibleAnchors"), "PDF viewer should render the active anchor even when layout overlays are hidden");
  assert.ok(pdfViewerSource.includes("sr-only"), "layout overlay toggle should remain accessible without adding visible noise");
});

test("reader-facing copy avoids implementation jargon", () => {
  const productFacingSource = [pageSource, editorSource, exportSheetSource, pdfViewerSource, printSource].join("\n");
  const forbiddenVisibleCopy = [
    "MinerU 处理中",
    "MinerU 正在解析 PDF",
    "已生成 Markdown",
    "Markdown 工作区",
    "Markdown 标题",
    "当前目标语言的译文缓存",
    "Markdown 草稿",
    "原始翻译缓存",
    "_No source content available_",
    "_No translation available_",
    "_No annotations_",
    "_Empty note_",
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
  ];

  for (const copy of forbiddenVisibleCopy) {
    assert.equal(productFacingSource.includes(copy), false, `${copy} should not appear in reader-facing copy`);
  }

  assert.ok(productFacingSource.includes("正在整理阅读稿"), "parse progress should describe a user-facing reading draft");
  assert.ok(productFacingSource.includes("阅读稿已准备好"), "parsed state should avoid exposing internal document formats");
  assert.ok(productFacingSource.includes("阅读工作区异常"), "error boundary should name the user-facing workspace");
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
    "测试前请先填写 Endpoint",
    "OpenAI-compatible provider 可用于",
    "OpenAI-compatible 或 DeepLX 端点",
    "source_lang",
    "glossary ID",
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
    "服务地址",
    "访问密钥",
    "术语表 ID（可选）",
    "原文语言（可选）",
    "还没有自定义服务",
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
  assert.ok(editorSource.includes("保存编辑"), "translation editing should have a save action");
});

test("translation edits save back into the current workspace", () => {
  assert.ok(storeSource.includes("saveEditedTranslation"), "store should expose a first-class edited translation save action");
  assert.ok(storeSource.includes("targetMarkdown: editedMarkdown"), "edited translation should update the current target markdown");
  assert.ok(storeSource.includes("translationBlocks: []"), "manual edits should become the canonical rendered target");
  assert.ok(storeSource.includes("persistActiveDocumentSnapshot"), "manual edits should be persisted with the active document snapshot");
  assert.ok(editorSource.includes("saveEditedTranslation(translationEditDraft)"), "editor save should write back to the current workspace");
  assert.ok(editorSource.includes("下载副本"), "download should remain as a secondary action");
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
