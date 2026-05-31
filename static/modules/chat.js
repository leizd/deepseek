import { createNetworkClient } from "./network.js";
import { chartSvg, parseChartCell } from "./charts.js";
import {
  createId,
  extensionForLanguage,
  fileKindFromName,
  quoteAwareContent,
  safeFilename,
  tailForContinuation,
  vscodeUriForPath,
} from "./format.js";
import { formatContent, hydrateMermaidDiagrams } from "./markdown.js";
import {
  normalizeFontSize,
  normalizeModel as normalizeModelValue,
  normalizeSeekId,
  normalizeStoredAttachment,
  normalizeTheme,
  normalizeThemeMode,
  normalizeThemeStyle,
  normalizeVoiceLanguage,
} from "./normalize.js";
import { isHttpUrl, resultDomain } from "./panels.js";
import { detectReminderFromText } from "./reminder_parse.js";
import { setupServiceWorker } from "./settings.js";
import { preferredSpeechVoice, speechChunks, speechTextFromMessage } from "./speech_text.js";
import { readChatStream } from "./stream.js";
import {
  agentExecutionReport,
  agentNotesSnapshot,
  agentRunSummary,
  agentRunSummarySignature,
  agentStepHasDetails,
  agentStepId,
  appendTimelineAgent,
  appendTimelineAgentDelta,
  appendTimelineAgentNote,
  appendTimelineAgentReasoning,
  formatAgentDuration,
  normalizeAgentNotes,
  normalizeTimeline,
  resetTimelineAgentPhase,
  timelineStepKey,
} from "./agent_timeline.js";

const storageKeys = {
  messages: "deepseek-mobile.messages",
  conversations: "deepseek-mobile.conversations",
  currentConversation: "deepseek-mobile.current-conversation",
  apiKey: "deepseek-mobile.api-key",
  rememberKey: "deepseek-mobile.remember-key",
  tavilyKey: "deepseek-mobile.tavily-key",
  rememberTavilyKey: "deepseek-mobile.remember-tavily-key",
  model: "deepseek-mobile.model",
  thinkingEnabled: "deepseek-mobile.thinking-enabled",
  reasoningEffort: "deepseek-mobile.reasoning-effort",
  role: "deepseek-mobile.role",
  temperature: "deepseek-mobile.temperature",
  searchEnabled: "deepseek-mobile.search-enabled",
  searchMode: "deepseek-mobile.search-mode",
  agentMode: "deepseek-mobile.agent-mode",
  agentPreset: "deepseek-mobile.agent-preset",
  agentDisplayMode: "deepseek-mobile.agent-display-mode",
  attachmentPrivacySeen: "deepseek-mobile.attachment-privacy-seen",
  attachmentConfirmEachSend: "deepseek-mobile.attachment-confirm-each-send",
  memoryEnabled: "deepseek-mobile.memory-enabled",
  authToken: "deepseek-mobile.auth-token",
  seeks: "deepseek-mobile.seeks",
  activeSeek: "deepseek-mobile.active-seek",
  draft: "deepseek-mobile.draft",
  activeProject: "deepseek-mobile.active-project",
  theme: "deepseek-mobile.theme",
  themeStyle: "deepseek-mobile.theme-style",
  themeMode: "deepseek-mobile.theme-mode",
  readingFontSize: "deepseek-mobile.reading-font-size",
  codeFontSize: "deepseek-mobile.code-font-size",
  voiceLanguage: "deepseek-mobile.voice-language",
  historySideClosed: "deepseek-mobile.history-side-closed",
};

const seekCore = window.DeepSeekSeekCore;
const mathCore = window.DeepSeekMathCore;
const maxCustomSeeks = seekCore.maxCustomSeeks;
const maxSeekReferenceAttachments = seekCore.maxSeekReferenceAttachments;
const network = createNetworkClient(storageKeys);
const { apiAuthToken, apiFetch, uploadFilesWithProgress } = network;

const rolePrompts = {
  general: "你是一个有帮助、回答准确、表达清晰的中文助手。",
  coding: "你是一个严谨的编程助手。优先给出可运行方案，指出关键假设和边界情况。",
  writing: "你是一个中文写作助手。帮助用户组织结构、改进表达，并保持自然准确。",
  study: "你是一个学习教练。用循序渐进的方式讲解问题，必要时给出例题和检查点。",
};

const formulaPrompt =
  "涉及数学、物理、统计或工程公式时，使用标准 LaTeX：行内公式写成 \\( ... \\)，独立公式写成 \\[ ... \\] 或 $$...$$；不要把公式放进代码块，除非用户明确要求源码。";

const presetSeeks = Object.freeze([
  {
    id: "preset-research",
    name: "研究分析",
    description: "拆解问题、列证据、给出可执行结论。",
    instructions:
      "你是一名研究分析型 Seek。先澄清目标和约束，再用结构化方式比较方案。重要结论必须说明依据、风险和下一步行动；不确定时明确标注假设。",
    starter: "帮我分析这个问题，并给出可执行的结论：",
    accent: "blue",
    builtin: true,
  },
  {
    id: "preset-coding",
    name: "编程助手",
    description: "面向代码实现、调试、重构和测试。",
    instructions:
      "你是一名严谨的编程 Seek。优先阅读上下文，给出最小可行改动，说明关键边界和验证方式。代码建议要能落地，避免无关重构。",
    starter: "帮我实现或排查这段代码：",
    accent: "green",
    builtin: true,
  },
  {
    id: "preset-study",
    name: "学习导师",
    description: "适合考研、课程复习和知识点讲解。",
    instructions:
      "你是一名耐心的学习导师 Seek。用由浅入深的方式讲解，先讲核心概念，再给例题、易错点和自测题。发现用户理解断点时及时补桥。",
    starter: "用学习导师的方式讲解：",
    accent: "purple",
    builtin: true,
  },
  {
    id: "preset-writing",
    name: "写作编辑",
    description: "润色、改写、提纲和风格统一。",
    instructions:
      "你是一名中文写作编辑 Seek。先保留原意，再改善结构、语气和节奏。输出时区分修改稿和修改说明，避免空泛评价。",
    starter: "帮我润色这段文字：",
    accent: "orange",
    builtin: true,
  },
]);

const modelRoutes = {
  fast: "deepseek-v4-flash",
  expert: "deepseek-v4-pro",
};
const defaultMode = "expert";
const defaultModel = modelRoutes[defaultMode];
const supportedModels = new Set(Object.values(modelRoutes));
const normalizeModel = (model) => normalizeModelValue(model, supportedModels, defaultModel);
const titleMaxLength = 28;
const tagMaxLength = 24;
const maxPendingAttachments = 5;
const defaultUploadLimits = Object.freeze({ fileMaxBytes: 200_000_000, requestMaxBytes: 220_000_000, maxFiles: 8 });
const maxLocalImagePreviewBytes = 30_000_000;
const maxAttachmentPromptChars = 120000;
const draftSaveIntervalMs = 2000;
const reminderPollIntervalMs = 60000;
const chatRequestTimeoutMs = 240000;
const agentChatRequestTimeoutMs = 75 * 60 * 1000;
// Agent Run 流被提前掐断时最多无进展重连几次（每次退避），再失败就当作真错误而非空综合。
const AGENT_STREAM_MAX_STALLED_RECONNECTS = 6;
const emptyAgentRunAnswerText = "多个 Agent 已完成分析，但综合阶段没有返回正文。请点击“重新综合最终回答”再试一次。";
const contextCompression = {
  enabled: true,
  triggerChars: 110000,
  triggerMessages: 36,
  keepRecentMessages: 16,
  minDeltaMessages: 4,
  minDeltaChars: 12000,
};
const initialConversations = loadConversations();
const initialConversationId = null;
// Tracks streaming messages whose Activity panel was manually dismissed.
const activityAutoDismissedMessageIds = new Set();
const fallbackReasoningStepKey = "reasoning-fallback";

const state = {
  conversations: initialConversations,
  currentConversationId: initialConversationId,
  messages: messagesForConversation(initialConversations, initialConversationId),
  seeks: loadCustomSeeks(),
  projects: [],
  activeSeekId: normalizeSeekId(localStorage.getItem(storageKeys.activeSeek)),
  activeProjectId: localStorage.getItem(storageKeys.activeProject) || "",
  model: normalizeModel(localStorage.getItem(storageKeys.model)),
  thinkingEnabled: loadThinkingEnabled(),
  reasoningEffort: normalizeReasoningEffort(localStorage.getItem(storageKeys.reasoningEffort)),
  role: localStorage.getItem(storageKeys.role) || "general",
  temperature: Number(localStorage.getItem(storageKeys.temperature) || "0.7"),
  hasServerKey: false,
  hasServerSearch: false,
  uploadLimits: { ...defaultUploadLimits },
  hasSearch: true,
  searchMode: loadSearchMode(),
  agentMode: localStorage.getItem(storageKeys.agentMode) === "1",
  agentPreset: normalizeAgentPreset(localStorage.getItem(storageKeys.agentPreset)),
  agentDisplayMode: normalizeAgentDisplayMode(localStorage.getItem(storageKeys.agentDisplayMode)),
  memoryEnabled: localStorage.getItem(storageKeys.memoryEnabled) !== "0",
  busy: false,
  outputPaused: false,
  resumeStreaming: null,
  abortController: null,
  interruptRequested: false,
  activeAssistantId: null,
  pendingAttachments: [],
  uploadingAttachments: [],
  seekEditorAttachments: [],
  seekEditorUploadingAttachments: [],
  uploadActive: false,
  attachmentConfirmEachSend: localStorage.getItem(storageKeys.attachmentConfirmEachSend) === "1",
  installPrompt: null,
  editingConversationId: null,
  editingMessageId: null,
  editingSeekId: "",
  seekSearch: "",
  projectUploading: false,
  historySearch: "",
  activeActivityMessageId: "",
  quoteDraft: null,
  selectionQuoteCandidate: null,
  selectionQuoteLocked: null,
  lastValidQuoteCandidate: null,
  selectionQuoteActionHandledAt: 0,
  draftTimer: 0,
  reminderTimer: 0,
  offlineMode: false,
  authRequired: false,
  themeStyle: normalizeThemeStyle(localStorage.getItem(storageKeys.themeStyle)),
  themeMode: normalizeThemeMode(localStorage.getItem(storageKeys.themeMode) ?? localStorage.getItem(storageKeys.theme)),
  readingFontSize: normalizeFontSize(localStorage.getItem(storageKeys.readingFontSize), 16, 14, 21),
  codeFontSize: normalizeFontSize(localStorage.getItem(storageKeys.codeFontSize), 14, 12, 18),
  voiceLanguage: normalizeVoiceLanguage(localStorage.getItem(storageKeys.voiceLanguage) || navigator.language || "zh-CN"),
  commandQuery: "",
  voiceListening: false,
  voiceRecognition: null,
  voiceBaseText: "",
  speakingMessageId: "",
  speechUtterance: null,
  speechQueue: [],
  dragDepth: 0,
  toastTimer: 0,
  chatRequestTimer: 0,
  draftRestoreTimer: 0,
  activeToastAction: null,
  confirmResolve: null,
  previousFocus: null,
  focusTrap: null,
  focusTrapStack: [],
  imageLightboxItems: [],
  imageLightboxIndex: 0,
  peekClickLockUntil: 0,
};

const freshMessageIds = new Set();
const pendingStreamingMessageIds = new Set();
let streamingRenderFrame = 0;
let backdropHideTimer = 0;
let activeHistoryMenu = null;
let historyMenuRoot = null;

const appShell = document.querySelector(".app-shell");
const chatLog = document.querySelector("#chatLog");
const chatForm = document.querySelector("#chatForm");
const promptInput = document.querySelector("#promptInput");
const fileInput = document.querySelector("#fileInput");
const attachmentList = document.querySelector("#attachmentList");
const sendButton = document.querySelector("#sendButton");
const pauseButton = document.querySelector("#pauseButton");
const stopButton = document.querySelector("#stopButton");
const jumpLatestButton = document.querySelector("#jumpLatestButton");
const conversationPeek = document.querySelector("#conversationPeek");
const modelTabs = document.querySelector("#modelTabs");
const suggestionGrid = document.querySelector("#suggestionGrid");
const deepThinkButton = document.querySelector("#deepThinkButton");
const agentModeButton = document.querySelector("#agentModeButton");
const searchToggleButton = document.querySelector("#searchToggleButton");
const draftRestore = document.querySelector("#draftRestore");
const restoreDraftButton = document.querySelector("#restoreDraftButton");
const discardDraftButton = document.querySelector("#discardDraftButton");
const quotePreview = document.querySelector("#quotePreview");
const attachmentButton = document.querySelector("#attachmentButton");
const voiceInputButton = document.querySelector("#voiceInputButton");
const quoteSelectionButton = document.querySelector("#quoteSelectionButton");
const selectionPopover = document.querySelector("#selectionPopover");
const newChatButton = document.querySelector("#newChatButton");  // 已被合并到 historyNewChatButton，保留为兼容性占位
const exportChatButton = document.querySelector("#exportChatButton");
const historyButton = document.querySelector("#historyButton");
const projectButton = document.querySelector("#projectButton");
const seekButton = document.querySelector("#seekButton");
const activeSeekRow = document.querySelector("#activeSeekRow");
const activeSeekChip = document.querySelector("#activeSeekChip");
const clearSeekButton = document.querySelector("#clearSeekButton");
const activeProjectRow = document.querySelector("#activeProjectRow");
const activeProjectChip = document.querySelector("#activeProjectChip");
const clearProjectButton = document.querySelector("#clearProjectButton");
const closeHistoryButton = document.querySelector("#closeHistoryButton");
const historyPanel = document.querySelector("#historyPanel");
const historyList = document.querySelector("#historyList");
const historyEmpty = document.querySelector("#historyEmpty");
const historyNewChatButton = document.querySelector("#historyNewChatButton");
const historySettingsButton = document.querySelector("#historySettingsButton");
const clearHistoryButton = document.querySelector("#clearHistoryButton");
const historySearchInput = document.querySelector("#historySearchInput");
const projectPanel = document.querySelector("#projectPanel");
const closeProjectPanelButton = document.querySelector("#closeProjectPanelButton");
const projectCreateForm = document.querySelector("#projectCreateForm");
const projectNameInput = document.querySelector("#projectNameInput");
const projectList = document.querySelector("#projectList");
const projectDocuments = document.querySelector("#projectDocuments");
const projectDocumentsTitle = document.querySelector("#projectDocumentsTitle");
const projectDocumentList = document.querySelector("#projectDocumentList");
const projectUploadButton = document.querySelector("#projectUploadButton");
const projectUploadInput = document.querySelector("#projectUploadInput");
const closeSettingsButton = document.querySelector("#closeSettingsButton");
const settingsPanel = document.querySelector("#settingsPanel");
const seekPanel = document.querySelector("#seekPanel");
const closeSeekPanelButton = document.querySelector("#closeSeekPanelButton");
const seekSearchInput = document.querySelector("#seekSearchInput");
const seekCreateButton = document.querySelector("#seekCreateButton");
const seekImportButton = document.querySelector("#seekImportButton");
const seekExportButton = document.querySelector("#seekExportButton");
const seekImportInput = document.querySelector("#seekImportInput");
const seekPresetList = document.querySelector("#seekPresetList");
const seekCustomList = document.querySelector("#seekCustomList");
const seekEditorForm = document.querySelector("#seekEditorForm");
const seekEditorTitle = document.querySelector("#seekEditorTitle");
const seekNameInput = document.querySelector("#seekNameInput");
const seekDescriptionInput = document.querySelector("#seekDescriptionInput");
const seekInstructionsInput = document.querySelector("#seekInstructionsInput");
const seekReferenceButton = document.querySelector("#seekReferenceButton");
const seekReferenceInput = document.querySelector("#seekReferenceInput");
const seekReferenceList = document.querySelector("#seekReferenceList");
const seekStarterInput = document.querySelector("#seekStarterInput");
const seekCancelButton = document.querySelector("#seekCancelButton");
let searchPanel = document.querySelector("#searchPanel");
let searchPanelList = document.querySelector("#searchPanelList");
let closeSearchPanelButton = document.querySelector("#closeSearchPanelButton");
const filePreviewPanel = document.querySelector("#filePreviewPanel");
const closeFilePreviewButton = document.querySelector("#closeFilePreviewButton");
const filePreviewTitle = document.querySelector("#filePreviewTitle");
const filePreviewMeta = document.querySelector("#filePreviewMeta");
const filePreviewText = document.querySelector("#filePreviewText");
const memoryPanel = document.querySelector("#memoryPanel");
const closeMemoryPanelButton = document.querySelector("#closeMemoryPanelButton");
const memoryPanelList = document.querySelector("#memoryPanelList");
const diagnosticsPanel = document.querySelector("#diagnosticsPanel");
const closeDiagnosticsPanelButton = document.querySelector("#closeDiagnosticsPanelButton");
const diagnosticsPanelList = document.querySelector("#diagnosticsPanelList");
const activityPanel = document.querySelector("#activityPanel");
const activityPanelBody = document.querySelector("#activityPanelBody");
const activityPanelTitle = document.querySelector("#activityPanelTitle");
const closeActivityPanelButton = document.querySelector("#closeActivityPanelButton");
const backdrop = document.querySelector("#backdrop");
const dropOverlay = document.querySelector("#dropOverlay");
const statusLiveRegion = document.querySelector("#statusLiveRegion");
const alertLiveRegion = document.querySelector("#alertLiveRegion");
const shortcutPanel = document.querySelector("#shortcutPanel");
const closeShortcutPanelButton = document.querySelector("#closeShortcutPanelButton");
const confirmDialog = document.querySelector("#confirmDialog");
const confirmDialogTitle = document.querySelector("#confirmDialogTitle");
const confirmDialogMessage = document.querySelector("#confirmDialogMessage");
const confirmCancelButton = document.querySelector("#confirmCancelButton");
const confirmOkButton = document.querySelector("#confirmOkButton");
const imageLightbox = document.querySelector("#imageLightbox");
const imageLightboxImage = document.querySelector("#imageLightboxImage");
const imageLightboxCaption = document.querySelector("#imageLightboxCaption");
const imageLightboxPrev = document.querySelector("#imageLightboxPrev");
const imageLightboxNext = document.querySelector("#imageLightboxNext");
const closeImageLightboxButton = document.querySelector("#closeImageLightboxButton");
const apiKeyInput = document.querySelector("#apiKeyInput");
const rememberKeyInput = document.querySelector("#rememberKeyInput");
const tavilyKeyInput = document.querySelector("#tavilyKeyInput");
const rememberTavilyKeyInput = document.querySelector("#rememberTavilyKeyInput");
const memoryEnabledInput = document.querySelector("#memoryEnabledInput");
const viewMemoryButton = document.querySelector("#viewMemoryButton");
const clearMemoryButton = document.querySelector("#clearMemoryButton");
const attachmentConfirmInput = document.querySelector("#attachmentConfirmInput");
const roleSelect = document.querySelector("#roleSelect");
const reasoningEffortSelect = document.querySelector("#reasoningEffortSelect");
const agentPresetSelect = document.querySelector("#agentPresetSelect");
const agentDisplayModeSelect = document.querySelector("#agentDisplayModeSelect");
const temperatureInput = document.querySelector("#temperatureInput");
const exportButton = document.querySelector("#exportButton");
const clearButton = document.querySelector("#clearButton");
const clearLocalDataButton = document.querySelector("#clearLocalDataButton");
const serverKeyNote = document.querySelector("#serverKeyNote");
const computerUrlLink = document.querySelector("#computerUrlLink");
const phoneUrlLink = document.querySelector("#phoneUrlLink");
const installButton = document.querySelector("#installButton");
const offlineBanner = document.querySelector("#offlineBanner");
const commandPalette = document.querySelector("#commandPalette");
const commandPaletteInput = document.querySelector("#commandPaletteInput");
const commandPaletteList = document.querySelector("#commandPaletteList");
const commandPaletteEmpty = document.querySelector("#commandPaletteEmpty");
const themeStyleSelect = document.querySelector("#themeStyleSelect");
const themeModeSelect = document.querySelector("#themeModeSelect");
const readingFontSizeInput = document.querySelector("#readingFontSizeInput");
const codeFontSizeInput = document.querySelector("#codeFontSizeInput");
const voiceLanguageSelect = document.querySelector("#voiceLanguageSelect");

export function bootstrap() {
  normalizeActiveSeekState();
  setupServiceWorker();
  setupSettings();
  applyAppearanceSettings();
  setupEvents();
  loadConfig();
  loadProjects();
  offerDraftRestore();
  startDraftAutosave();
  startReminderPolling();
  renderHistoryList();
  renderSeekPanel();
  render();
  renderOfflineMode();
  renderVoiceInputButton();
  renderSelectionQuoteButton();
  consumeShareTarget();
  resumePendingAgentRuns();
  mathCore.renderPendingMathIn(document);
  resizeComposer();
  updateVisualViewportInsets();
  updateJumpLatestOffset();
}

function setupEvents() {
  chatForm.addEventListener("submit", onSubmit);
  window.addEventListener("keydown", onGlobalKeydown);

  chatLog.addEventListener(
    "scroll",
    () => {
      updateJumpLatestButton();
      updateConversationPeekActive();
    },
    { passive: true }
  );
  window.addEventListener(
    "scroll",
    () => {
      updateJumpLatestButton();
      updateConversationPeekActive();
    },
    { passive: true }
  );
  window.addEventListener("resize", () => {
    updateVisualViewportInsets();
    resizeComposer();
    updateJumpLatestOffset();
    updateJumpLatestButton();
    renderConversationPeek();
    positionSelectionPopover(state.selectionQuoteCandidate);
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", updateVisualViewportInsets);
    window.visualViewport.addEventListener("scroll", updateVisualViewportInsets);
  }
  window.addEventListener("load", () => {
    mathCore.renderPendingMathIn(document);
  });
  window.addEventListener("beforeunload", stopSpeechPlayback);
  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("pointerup", scheduleSelectionRefresh, { passive: true });
  document.addEventListener("mouseup", scheduleSelectionRefresh, { passive: true });
  document.addEventListener("keyup", scheduleSelectionRefresh, { passive: true });
  document.addEventListener("touchend", scheduleSelectionRefresh, { passive: true });
  window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", () => {
    if (state.themeMode === "system") applyAppearanceSettings();
  });
  if (jumpLatestButton) {
    jumpLatestButton.addEventListener("click", () => {
      scrollToLatest({ behavior: "smooth" });
    });
  }
  chatLog.addEventListener("click", onChatLogClick);
  chatLog.addEventListener("input", onChatLogPlanEdit);
  chatLog.addEventListener("change", onChatLogPlanEdit);
  if (conversationPeek) {
    conversationPeek.addEventListener("click", onConversationPeekClick);
  }

  promptInput.addEventListener("input", () => {
    resizeComposer();
    saveDraft();
  });
  promptInput.addEventListener("paste", onPromptPaste);
  promptInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      chatForm.requestSubmit();
      return;
    }
    if (event.key === "ArrowUp" && !state.busy && !promptInput.value && promptInput.selectionStart === 0) {
      event.preventDefault();
      editPreviousUserMessage();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      chatForm.requestSubmit();
    }
  });

  modelTabs.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-mode]");
    if (!button) return;
    setModel(modelRoutes[button.dataset.mode]);
  });

  if (suggestionGrid) {
    suggestionGrid.addEventListener("click", onSuggestionCardClick);
  }

  deepThinkButton.addEventListener("click", () => {
    setThinkingEnabled(!state.thinkingEnabled);
  });

  if (agentModeButton) {
    agentModeButton.addEventListener("click", () => {
      state.agentMode = !state.agentMode;
      localStorage.setItem(storageKeys.agentMode, state.agentMode ? "1" : "0");
      renderAgentModeButton();
    });
  }

  attachmentButton.addEventListener("click", (event) => {
    if (state.uploadActive) {
      event.preventDefault();
    }
  });
  attachmentButton.addEventListener(
    "touchend",
    (event) => {
      if (state.uploadActive) {
        event.preventDefault();
        return;
      }
      if (event.target === fileInput) return;
      event.preventDefault();
      openFilePicker();
    },
    { passive: false }
  );
  attachmentButton.addEventListener("keydown", (event) => {
    if (state.uploadActive) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openFilePicker();
    }
  });
  if (voiceInputButton) {
    voiceInputButton.addEventListener("click", toggleVoiceInput);
  }
  if (quoteSelectionButton) {
    quoteSelectionButton.addEventListener("pointerdown", captureSelectionSnapshot);
    quoteSelectionButton.addEventListener("mousedown", captureSelectionSnapshot);
    quoteSelectionButton.addEventListener("touchstart", captureSelectionSnapshot, { passive: false });
    quoteSelectionButton.addEventListener("pointerup", quoteSelectionButtonPointerUp);
    quoteSelectionButton.addEventListener("touchend", quoteSelectionButtonTouchEnd, { passive: false });
    quoteSelectionButton.addEventListener("click", quoteSelectedAssistantText);
  }
  setupSelectionPopover();
  fileInput.addEventListener("change", onFileInputChange);
  attachmentList.addEventListener("click", onAttachmentListClick);
  document.addEventListener("dragenter", onDocumentDragEnter);
  document.addEventListener("dragover", onDocumentDragOver);
  document.addEventListener("dragleave", onDocumentDragLeave);
  document.addEventListener("drop", onDocumentDrop);
  if (dropOverlay) {
    dropOverlay.addEventListener("dragleave", onDocumentDragLeave);
  }
  if (closeShortcutPanelButton) closeShortcutPanelButton.addEventListener("click", closeShortcutPanel);
  if (shortcutPanel) shortcutPanel.addEventListener("click", (event) => {
    if (event.target === shortcutPanel) closeShortcutPanel();
  });
  if (confirmCancelButton) confirmCancelButton.addEventListener("click", () => resolveConfirmDialog(false));
  if (confirmOkButton) confirmOkButton.addEventListener("click", () => resolveConfirmDialog(true));
  if (confirmDialog) confirmDialog.addEventListener("click", (event) => {
    if (event.target === confirmDialog) resolveConfirmDialog(false);
  });
  if (closeImageLightboxButton) closeImageLightboxButton.addEventListener("click", closeImageLightbox);
  if (imageLightbox) imageLightbox.addEventListener("click", (event) => {
    if (event.target === imageLightbox) closeImageLightbox();
  });
  if (imageLightboxPrev) imageLightboxPrev.addEventListener("click", () => stepImageLightbox(-1));
  if (imageLightboxNext) imageLightboxNext.addEventListener("click", () => stepImageLightbox(1));
  if (quotePreview) {
    quotePreview.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      if (target?.closest("button[data-clear-quote]")) {
        state.quoteDraft = null;
        renderQuotePreview();
        saveDraft();
        return;
      }
      const originButton = target?.closest("button[data-quote-origin]");
      if (originButton) {
        scrollMessageIntoView(originButton.dataset.quoteOrigin || "");
      }
    });
  }

  if (pauseButton) {
    pauseButton.addEventListener("click", () => {
      setOutputPaused(!state.outputPaused);
    });
  }
  if (stopButton) {
    stopButton.addEventListener("click", interruptGeneration);
  }

  searchToggleButton.addEventListener("click", () => {
    if (!state.hasSearch) {
      showToast("请先设置 Tavily API Key 或启动前配置 TAVILY_API_KEY");
      openSettings();
      return;
    }
    state.searchMode = nextSearchMode(state.searchMode);
    localStorage.setItem(storageKeys.searchMode, state.searchMode);
    localStorage.setItem(storageKeys.searchEnabled, state.searchMode === "off" ? "0" : "1");
    renderSearchToggle();
  });

  if (newChatButton) {
    newChatButton.addEventListener("click", () => {
      startNewConversation();
    });
  }
  if (exportChatButton) {
    exportChatButton.addEventListener("click", exportCurrentConversation);
  }

  historyNewChatButton.addEventListener("click", () => {
    startNewConversation();
    closeHistory();
  });

  historyButton.addEventListener("click", toggleHistory);
  if (projectButton) {
    projectButton.addEventListener("click", openProjectPanel);
  }
  if (seekButton) {
    seekButton.addEventListener("click", openSeekPanel);
  }
  if (activeSeekChip) {
    activeSeekChip.addEventListener("click", openSeekPanel);
  }
  if (clearSeekButton) {
    clearSeekButton.addEventListener("click", () => {
      setActiveSeek("");
      showToast("已停用 Seek 助手");
    });
  }
  if (activeProjectChip) {
    activeProjectChip.addEventListener("click", openProjectPanel);
  }
  if (clearProjectButton) {
    clearProjectButton.addEventListener("click", () => {
      setActiveProject("");
      showToast("已退出项目空间");
    });
  }
  if (closeHistoryButton) {
    closeHistoryButton.addEventListener("click", toggleHistory);
  }
  historyList.addEventListener("click", onHistoryListClick);
  historyList.addEventListener("submit", onHistoryTitleSubmit);
  historyList.addEventListener("keydown", onHistoryTitleKeydown);
  historyList.addEventListener("scroll", () => closeHistoryMenu(), { passive: true });
  document.addEventListener("click", (event) => {
    if (!activeHistoryMenu) return;
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    if (target?.closest(".history-menu") || target?.closest(".history-menu-button")) return;
    closeHistoryMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeHistoryMenu();
  });
  if (historySearchInput) {
    historySearchInput.addEventListener("input", () => {
      state.historySearch = historySearchInput.value.trim();
      searchConversations();
    });
  }
  if (restoreDraftButton) {
    restoreDraftButton.addEventListener("click", restoreDraft);
  }
  if (discardDraftButton) {
    discardDraftButton.addEventListener("click", discardDraft);
  }
  historySettingsButton.addEventListener("click", () => {
    closeHistory();
    openSettings();
  });
  clearHistoryButton.addEventListener("click", clearConversationHistory);
  if (closeProjectPanelButton) {
    closeProjectPanelButton.addEventListener("click", closeProjectPanel);
  }
  if (projectCreateForm) {
    projectCreateForm.addEventListener("submit", createProjectFromForm);
  }
  if (projectList) {
    projectList.addEventListener("click", onProjectListClick);
  }
  if (projectUploadButton && projectUploadInput) {
    projectUploadButton.addEventListener("click", () => projectUploadInput.click());
    projectUploadInput.addEventListener("change", onProjectUploadInputChange);
  }
  closeSettingsButton.addEventListener("click", closeSettings);
  if (closeSeekPanelButton) {
    closeSeekPanelButton.addEventListener("click", closeSeekPanel);
  }
  if (seekCreateButton) {
    seekCreateButton.addEventListener("click", () => startSeekEditor());
  }
  if (seekImportButton && seekImportInput) {
    seekImportButton.addEventListener("click", () => {
      seekImportInput.value = "";
      seekImportInput.click();
    });
    seekImportInput.addEventListener("change", importSeeksFromFile);
  }
  if (seekExportButton) {
    seekExportButton.addEventListener("click", exportCustomSeeks);
  }
  if (seekCancelButton) {
    seekCancelButton.addEventListener("click", cancelSeekEditor);
  }
  if (seekEditorForm) {
    seekEditorForm.addEventListener("submit", saveSeekFromForm);
  }
  if (seekReferenceButton && seekReferenceInput) {
    seekReferenceButton.addEventListener("click", () => {
      if (state.busy || state.uploadActive) {
        showToast("文件正在上传，请稍等");
        return;
      }
      seekReferenceInput.value = "";
      seekReferenceInput.click();
    });
    seekReferenceInput.addEventListener("change", onSeekReferenceInputChange);
  }
  if (seekReferenceList) {
    seekReferenceList.addEventListener("click", onSeekReferenceListClick);
  }
  if (seekPresetList) {
    seekPresetList.addEventListener("click", onSeekListClick);
  }
  if (seekCustomList) {
    seekCustomList.addEventListener("click", onSeekListClick);
  }
  if (seekSearchInput) {
    seekSearchInput.addEventListener("input", () => {
      state.seekSearch = seekSearchInput.value.trim();
      renderSeekPanel();
    });
  }
  if (closeSearchPanelButton) {
    closeSearchPanelButton.addEventListener("click", closeSearchPanel);
    closeSearchPanelButton.dataset.bound = "1";
  }
  if (commandPaletteInput) {
    commandPaletteInput.addEventListener("input", () => {
      state.commandQuery = commandPaletteInput.value.trim();
      renderCommandPalette();
    });
    commandPaletteInput.addEventListener("keydown", onCommandPaletteKeydown);
  }
  if (commandPaletteList) {
    commandPaletteList.addEventListener("click", onCommandPaletteClick);
  }
  if (closeFilePreviewButton) {
    closeFilePreviewButton.addEventListener("click", closeFilePreview);
  }
  if (closeMemoryPanelButton) {
    closeMemoryPanelButton.addEventListener("click", closeMemoryPanel);
  }
  if (closeDiagnosticsPanelButton) {
    closeDiagnosticsPanelButton.addEventListener("click", closeDiagnosticsPanel);
  }
  if (closeActivityPanelButton) {
    // v1.3.2：关闭按钮保留 activeActivityMessageId，避免流式更新期间清掉上下文导致
    // 手动重开体验不稳。自动弹开依然被 suppressAutoOpen 抑制，用户点"思考与活动"可重新打开。
    closeActivityPanelButton.addEventListener("click", () => closeActivityPanel({ keepState: true }));
  }
  if (activityPanel) {
    activityPanel.addEventListener("click", onActivityPanelClick);
  }
  window.addEventListener("resize", onActivityViewportChange);
  window.addEventListener("resize", syncHistoryMode);
  syncHistoryMode();
  if (memoryPanelList) {
    memoryPanelList.addEventListener("click", onMemoryPanelClick);
  }
  backdrop.addEventListener("click", closePanels);

  rememberKeyInput.addEventListener("change", () => {
    localStorage.setItem(storageKeys.rememberKey, rememberKeyInput.checked ? "1" : "0");
    if (rememberKeyInput.checked && apiKeyInput.value.trim()) {
      localStorage.setItem(storageKeys.apiKey, apiKeyInput.value.trim());
    } else {
      localStorage.removeItem(storageKeys.apiKey);
    }
  });

  if (rememberTavilyKeyInput) {
    rememberTavilyKeyInput.addEventListener("change", () => {
      localStorage.setItem(storageKeys.rememberTavilyKey, rememberTavilyKeyInput.checked ? "1" : "0");
      if (rememberTavilyKeyInput.checked && tavilyKeyInput?.value.trim()) {
        localStorage.setItem(storageKeys.tavilyKey, tavilyKeyInput.value.trim());
      } else {
        localStorage.removeItem(storageKeys.tavilyKey);
      }
    });
  }

  if (memoryEnabledInput) {
    memoryEnabledInput.addEventListener("change", () => {
      state.memoryEnabled = memoryEnabledInput.checked;
      localStorage.setItem(storageKeys.memoryEnabled, state.memoryEnabled ? "1" : "0");
      showToast(state.memoryEnabled ? "长期记忆已开启" : "长期记忆已关闭");
    });
  }

  if (viewMemoryButton) {
    viewMemoryButton.addEventListener("click", viewMemories);
  }

  if (clearMemoryButton) {
    clearMemoryButton.addEventListener("click", clearMemories);
  }

  if (attachmentConfirmInput) {
    attachmentConfirmInput.addEventListener("change", () => {
      state.attachmentConfirmEachSend = attachmentConfirmInput.checked;
      localStorage.setItem(storageKeys.attachmentConfirmEachSend, state.attachmentConfirmEachSend ? "1" : "0");
    });
  }

  apiKeyInput.addEventListener("input", () => {
    if (rememberKeyInput.checked) {
      localStorage.setItem(storageKeys.apiKey, apiKeyInput.value.trim());
    }
  });

  if (tavilyKeyInput) {
    tavilyKeyInput.addEventListener("input", () => {
      if (rememberTavilyKeyInput?.checked) {
        localStorage.setItem(storageKeys.tavilyKey, tavilyKeyInput.value.trim());
      }
      updateSearchAvailability();
    });
  }

  roleSelect.addEventListener("change", () => {
    state.role = roleSelect.value;
    localStorage.setItem(storageKeys.role, state.role);
  });

  if (reasoningEffortSelect) {
    reasoningEffortSelect.addEventListener("change", () => {
      state.reasoningEffort = normalizeReasoningEffort(reasoningEffortSelect.value);
      localStorage.setItem(storageKeys.reasoningEffort, state.reasoningEffort);
    });
  }

  if (agentPresetSelect) {
    agentPresetSelect.addEventListener("change", () => {
      state.agentPreset = normalizeAgentPreset(agentPresetSelect.value);
      localStorage.setItem(storageKeys.agentPreset, state.agentPreset);
      renderAgentModeButton();
    });
  }

  if (agentDisplayModeSelect) {
    agentDisplayModeSelect.addEventListener("change", () => {
      state.agentDisplayMode = normalizeAgentDisplayMode(agentDisplayModeSelect.value);
      localStorage.setItem(storageKeys.agentDisplayMode, state.agentDisplayMode);
      render();
    });
  }

  temperatureInput.addEventListener("input", () => {
    state.temperature = Number(temperatureInput.value);
    localStorage.setItem(storageKeys.temperature, String(state.temperature));
  });

  if (themeStyleSelect) {
    themeStyleSelect.addEventListener("change", () => {
      state.themeStyle = normalizeThemeStyle(themeStyleSelect.value);
      localStorage.setItem(storageKeys.themeStyle, state.themeStyle);
      applyAppearanceSettings();
    });
  }
  if (themeModeSelect) {
    themeModeSelect.addEventListener("change", () => {
      state.themeMode = normalizeThemeMode(themeModeSelect.value);
      localStorage.setItem(storageKeys.themeMode, state.themeMode);
      applyAppearanceSettings();
    });
  }

  if (readingFontSizeInput) {
    readingFontSizeInput.addEventListener("input", () => {
      state.readingFontSize = normalizeFontSize(readingFontSizeInput.value, 16, 14, 21);
      localStorage.setItem(storageKeys.readingFontSize, String(state.readingFontSize));
      applyAppearanceSettings();
    });
  }

  if (codeFontSizeInput) {
    codeFontSizeInput.addEventListener("input", () => {
      state.codeFontSize = normalizeFontSize(codeFontSizeInput.value, 14, 12, 18);
      localStorage.setItem(storageKeys.codeFontSize, String(state.codeFontSize));
      applyAppearanceSettings();
    });
  }

  if (voiceLanguageSelect) {
    voiceLanguageSelect.addEventListener("change", () => {
      state.voiceLanguage = normalizeVoiceLanguage(voiceLanguageSelect.value);
      localStorage.setItem(storageKeys.voiceLanguage, state.voiceLanguage);
    });
  }

  exportButton.addEventListener("click", exportCurrentConversation);
  clearButton.addEventListener("click", () => {
    clearCurrentConversation();
    render();
    closeSettings();
  });
  if (clearLocalDataButton) {
    clearLocalDataButton.addEventListener("click", clearLocalBrowserData);
  }

  installButton.addEventListener("click", async () => {
    if (!state.installPrompt) return;
    state.installPrompt.prompt();
    await state.installPrompt.userChoice;
    state.installPrompt = null;
    installButton.hidden = true;
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPrompt = event;
    installButton.hidden = false;
  });

  window.addEventListener("resize", () => {
    updateJumpLatestOffset();
    updateJumpLatestButton();
    renderConversationPeek();
  });
}

function setupSettings() {
  const remember = localStorage.getItem(storageKeys.rememberKey) === "1";
  rememberKeyInput.checked = remember;
  apiKeyInput.value = remember ? localStorage.getItem(storageKeys.apiKey) || "" : "";
  if (rememberTavilyKeyInput && tavilyKeyInput) {
    const rememberTavily = localStorage.getItem(storageKeys.rememberTavilyKey) === "1";
    rememberTavilyKeyInput.checked = rememberTavily;
    tavilyKeyInput.value = rememberTavily ? localStorage.getItem(storageKeys.tavilyKey) || "" : "";
  }
  if (memoryEnabledInput) {
    memoryEnabledInput.checked = state.memoryEnabled;
  }
  if (attachmentConfirmInput) {
    attachmentConfirmInput.checked = state.attachmentConfirmEachSend;
  }
  roleSelect.value = state.role;
  if (reasoningEffortSelect) reasoningEffortSelect.value = state.reasoningEffort;
  if (agentPresetSelect) agentPresetSelect.value = state.agentPreset;
  if (agentDisplayModeSelect) agentDisplayModeSelect.value = state.agentDisplayMode;
  temperatureInput.value = String(state.temperature);
  if (!localStorage.getItem(storageKeys.themeMode) && localStorage.getItem(storageKeys.theme)) {
    localStorage.setItem(storageKeys.themeMode, state.themeMode);
  }
  if (themeStyleSelect) themeStyleSelect.value = state.themeStyle;
  if (themeModeSelect) themeModeSelect.value = state.themeMode;
  if (readingFontSizeInput) readingFontSizeInput.value = String(state.readingFontSize);
  if (codeFontSizeInput) codeFontSizeInput.value = String(state.codeFontSize);
  if (voiceLanguageSelect) voiceLanguageSelect.value = state.voiceLanguage;
  updateSearchAvailability({ render: false });
  renderModelTabs();
  renderSearchToggle();
  renderAgentModeButton();
}

function onGlobalKeydown(event) {
  const key = event.key;
  const modifier = event.ctrlKey || event.metaKey;

  if (modifier && key.toLowerCase() === "k") {
    event.preventDefault();
    openCommandPalette();
    return;
  }

  if (key === "?" && !isEditableTarget(event.target)) {
    event.preventDefault();
    openShortcutPanel();
    return;
  }

  if (key === "Escape") {
    if (isSelectionPopoverOpen()) {
      event.preventDefault();
      hideSelectionPopover();
      return;
    }
    if (isConfirmDialogOpen()) {
      event.preventDefault();
      resolveConfirmDialog(false);
      return;
    }
    if (isImageLightboxOpen()) {
      event.preventDefault();
      closeImageLightbox();
      return;
    }
    if (isShortcutPanelOpen()) {
      event.preventDefault();
      closeShortcutPanel();
      return;
    }
    if (isCommandPaletteOpen()) {
      event.preventDefault();
      closeCommandPalette();
      return;
    }
    if (state.busy) {
      event.preventDefault();
      interruptGeneration();
      return;
    }
    if (state.editingMessageId) {
      event.preventDefault();
      cancelMessageEdit();
      return;
    }
    if (hasClosablePanelOpen()) {
      event.preventDefault();
      closePanels();
      return;
    }
  }

  if (key === "Tab" && state.focusTrap) {
    trapFocusWithin(event, state.focusTrap);
  }

  if (modifier && key === "Enter" && !state.busy && !isEditableTarget(event.target)) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
}

function isEditableTarget(target) {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function openCommandPalette() {
  if (!commandPalette || !commandPaletteInput) return;
  state.commandQuery = "";
  commandPaletteInput.value = "";
  commandPalette.hidden = false;
  commandPalette.setAttribute("aria-hidden", "false");
  renderCommandPalette();
  activateFocusTrap(commandPalette);
  requestAnimationFrame(() => commandPaletteInput.focus());
}

function closeCommandPalette() {
  if (!commandPalette) return;
  commandPalette.hidden = true;
  commandPalette.setAttribute("aria-hidden", "true");
  state.commandQuery = "";
  deactivateFocusTrap(commandPalette);
}

function isCommandPaletteOpen() {
  return Boolean(commandPalette && !commandPalette.hidden);
}

function hasClosablePanelOpen() {
  // Escape should dismiss the visible workspace layer, including panels that
  // are not backed by the modal backdrop on wide screens.
  const historyModal = historyPanel?.classList.contains("open") && !document.body.classList.contains("history-side-open");
  return Boolean(
    historyModal ||
      settingsPanel?.classList.contains("open") ||
      seekPanel?.classList.contains("open") ||
      projectPanel?.classList.contains("open") ||
      searchPanel?.classList.contains("open") ||
      filePreviewPanel?.classList.contains("open") ||
      memoryPanel?.classList.contains("open") ||
      diagnosticsPanel?.classList.contains("open") ||
      activityPanel?.classList.contains("open")
  );
}

function commandPaletteItems() {
  const commands = [
    {
      type: "command",
      id: "new-chat",
      label: "新对话",
      description: "清空当前输入并开始一段新对话",
      run: () => startNewConversation(),
    },
    {
      type: "command",
      id: "shortcuts",
      label: "快捷键",
      description: "查看常用键盘操作",
      run: () => openShortcutPanel(),
    },
    {
      type: "command",
      id: "search-history",
      label: "搜索历史",
      description: "打开历史面板并聚焦搜索框",
      run: () => {
        openHistory();
        requestAnimationFrame(() => historySearchInput?.focus());
      },
    },
    {
      type: "command",
      id: "open-seek",
      label: "打开 Seek 助手",
      description: "切换或管理自定义 Seek",
      run: () => openSeekPanel(),
    },
    {
      type: "command",
      id: "settings",
      label: "打开设置",
      description: "调整 Key、主题、字体和本地数据",
      run: () => openSettings(),
    },
  ];

  const seekItems = allSeeks().map((seek) => ({
    type: "seek",
    id: `seek:${seek.id}`,
    label: `切换 Seek：${seek.name}`,
    description: seek.description || seek.instructions || "使用这个 Seek 助手",
    run: () => setActiveSeek(seek.id, { closePanel: true }),
  }));
  if (state.activeSeekId) {
    seekItems.unshift({
      type: "seek",
      id: "seek:none",
      label: "停用当前 Seek",
      description: "回到普通助手提示词",
      run: () => setActiveSeek(""),
    });
  }

  const conversationItems = state.conversations.slice(0, 40).map((conversation) => ({
    type: "history",
    id: `history:${conversation.id}`,
    label: conversation.title || titleFromMessages(conversation.messages || []),
    description: [seekNameForConversation(conversation), formatHistoryTime(conversation.updatedAt)].filter(Boolean).join(" · "),
    run: () => openConversation(conversation.id),
  }));

  return [...commands, ...seekItems, ...conversationItems];
}

function renderCommandPalette() {
  if (!commandPaletteList || !commandPaletteEmpty) return;
  const query = state.commandQuery.toLowerCase();
  const items = commandPaletteItems()
    .filter((item) => !query || [item.label, item.description, item.type].join(" ").toLowerCase().includes(query))
    .slice(0, 12);
  commandPaletteList.replaceChildren();
  commandPaletteEmpty.hidden = items.length > 0;
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "command-palette-item";
    button.dataset.commandId = item.id;
    const label = document.createElement("strong");
    label.textContent = item.label;
    const description = document.createElement("span");
    description.textContent = item.description || item.type;
    button.append(label, description);
    commandPaletteList.append(button);
  }
}

function onCommandPaletteKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeCommandPalette();
    return;
  }
  if (event.key !== "Enter") return;
  const first = commandPaletteList?.querySelector("button[data-command-id]");
  if (!first) return;
  event.preventDefault();
  runCommandPaletteItem(first.dataset.commandId || "");
}

function onCommandPaletteClick(event) {
  const target = event.target instanceof Element ? event.target : event.target?.parentElement;
  const button = target?.closest("button[data-command-id]");
  if (!button) return;
  runCommandPaletteItem(button.dataset.commandId || "");
}

function runCommandPaletteItem(id) {
  const item = commandPaletteItems().find((entry) => entry.id === id);
  if (!item) return;
  closeCommandPalette();
  item.run();
}

async function loadConfig() {
  try {
    const response = await apiFetch("/api/config");
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      state.offlineMode = true;
      state.authRequired = response.status === 401 || data.code === "unauthorized";
      state.hasServerKey = false;
      state.hasServerSearch = false;
      updateSearchAvailability({ render: false });
      renderAccessUrls({});
      renderSearchToggle();
      renderOfflineMode();
      serverKeyNote.textContent = state.authRequired
        ? "本地访问令牌缺失或已失效。请使用启动窗口打印的带 token 链接重新打开。"
        : data.error || "无法读取后端配置，当前不能发送新消息。";
      return;
    }
    const config = await response.json();
    state.offlineMode = false;
    state.authRequired = false;
    state.hasServerKey = Boolean(config.hasServerKey);
    state.hasServerSearch = Boolean(config.hasSearch);
    state.uploadLimits = normalizeUploadLimits(config.uploadLimits);
    updateSearchAvailability({ render: false });
    renderAccessUrls(config);
    renderSearchToggle();
    renderOfflineMode();
    serverKeyNote.textContent = state.hasServerKey
      ? "后端已检测到 DEEPSEEK_API_KEY，手机端可以不填写 API Key。"
      : "没有检测到服务端 API Key。可在这里填写，或启动前设置 DEEPSEEK_API_KEY。";
  } catch {
    state.offlineMode = true;
    state.authRequired = false;
    state.hasServerKey = false;
    state.hasServerSearch = false;
    updateSearchAvailability({ render: false });
    renderAccessUrls({});
    renderSearchToggle();
    renderOfflineMode();
    serverKeyNote.textContent = "无法读取后端配置，当前为离线模式。可查看历史，但不能发送新消息。";
  }
}

function renderAccessUrls(config) {
  const computerUrl = config.computerUrl || window.location.origin;
  const phoneUrl = config.phoneUrl || window.location.origin;
  setAccessLink(computerUrlLink, computerUrl);
  setAccessLink(phoneUrlLink, phoneUrl);
}

function setAccessLink(link, url) {
  link.href = url;
  link.textContent = url;
  link.title = url;
}

function apiUnauthorized(response, data = {}) {
  return response?.status === 401 || data?.code === "unauthorized";
}

function authRequiredMessage() {
  return "本地访问令牌已失效，请使用启动输出的 token 链接重新打开。";
}

function markAuthRequired() {
  state.offlineMode = true;
  state.authRequired = true;
  renderOfflineMode();
  showToast(authRequiredMessage(), { tone: "error" });
}

function apiErrorMessage(response, data, fallback) {
  if (apiUnauthorized(response, data)) {
    markAuthRequired();
    return authRequiredMessage();
  }
  return data?.error || fallback;
}

function renderOfflineMode() {
  if (offlineBanner) {
    offlineBanner.hidden = !state.offlineMode;
    const title = offlineBanner.querySelector("strong");
    const body = offlineBanner.querySelector("span");
    if (title) title.textContent = state.authRequired ? "需要重新认证" : "离线模式";
    if (body) {
      body.textContent = state.authRequired
        ? "本地访问令牌缺失或已失效；请使用启动窗口打印的带 token 链接重新打开。"
        : "后端暂时不可用；可以查看历史、搜索本地会话，但不能发送新消息。";
    }
  }
  appShell.classList.toggle("is-offline", state.offlineMode);
  sendButton.disabled = state.offlineMode || state.busy;
  searchToggleButton.disabled = state.offlineMode;
  renderVoiceInputButton();
  renderSelectionQuoteButton();
}

function speechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function speechRecognitionSupported() {
  return Boolean(speechRecognitionCtor());
}

function speechSynthesisSupported() {
  return Boolean(window.speechSynthesis && window.SpeechSynthesisUtterance);
}

function renderVoiceInputButton() {
  if (!voiceInputButton) return;
  const supported = speechRecognitionSupported();
  voiceInputButton.hidden = !supported;
  voiceInputButton.disabled = !supported || state.offlineMode;
  voiceInputButton.classList.toggle("listening", state.voiceListening);
  voiceInputButton.setAttribute("aria-pressed", String(state.voiceListening));
  voiceInputButton.setAttribute("aria-label", state.voiceListening ? "停止语音输入" : "语音输入");
  voiceInputButton.title = state.voiceListening ? "停止语音输入" : "语音输入";
}

function toggleVoiceInput() {
  if (state.voiceListening) {
    stopVoiceInput();
    return;
  }
  startVoiceInput();
}

function startVoiceInput() {
  const Recognition = speechRecognitionCtor();
  if (!Recognition) {
    showToast("当前浏览器不支持语音输入");
    renderVoiceInputButton();
    return;
  }
  try {
    const recognition = new Recognition();
    state.voiceRecognition = recognition;
    state.voiceBaseText = promptInput.value || "";
    recognition.lang = state.voiceLanguage || normalizeVoiceLanguage(navigator.language || "zh-CN");
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onstart = () => {
      state.voiceListening = true;
      renderVoiceInputButton();
      showToast("正在听写");
    };
    recognition.onresult = onVoiceRecognitionResult;
    recognition.onerror = (event) => {
      if (event.error && !["aborted", "no-speech"].includes(event.error)) {
        showToast("语音输入失败，请重试");
      }
    };
    recognition.onend = () => {
      state.voiceListening = false;
      state.voiceRecognition = null;
      state.voiceBaseText = promptInput.value || state.voiceBaseText;
      renderVoiceInputButton();
      saveDraft();
    };
    recognition.start();
  } catch {
    state.voiceListening = false;
    state.voiceRecognition = null;
    renderVoiceInputButton();
    showToast("语音输入启动失败");
  }
}

function stopVoiceInput() {
  try {
    state.voiceRecognition?.stop();
  } catch {
    state.voiceRecognition = null;
  }
  state.voiceListening = false;
  renderVoiceInputButton();
}

function onVoiceRecognitionResult(event) {
  let finalText = "";
  let interimText = "";
  for (let index = event.resultIndex; index < event.results.length; index += 1) {
    const transcript = String(event.results[index]?.[0]?.transcript || "");
    if (event.results[index]?.isFinal) {
      finalText += transcript;
    } else {
      interimText += transcript;
    }
  }
  if (finalText.trim()) {
    state.voiceBaseText = joinDictationText(state.voiceBaseText, finalText);
  }
  promptInput.value = joinDictationText(state.voiceBaseText, interimText);
  resizeComposer();
  saveDraft();
}

function joinDictationText(base, addition) {
  const left = String(base || "");
  const right = String(addition || "").trim();
  if (!right) return left;
  const separator = left && !/\s$/.test(left) ? " " : "";
  return `${left}${separator}${right}`;
}

function onSelectionChange() {
  const next = selectedAssistantQuoteCandidate();
  if (!next?.text && state.selectionQuoteLocked?.text) {
    renderSelectionQuoteButton();
    return;
  }
  state.selectionQuoteCandidate = next;
  if (next?.text) {
    state.lastValidQuoteCandidate = next;
  }
  renderSelectionQuoteButton();
  positionSelectionPopover(next);
}

function scheduleSelectionRefresh() {
  requestAnimationFrame(onSelectionChange);
  window.setTimeout(onSelectionChange, 80);
}

function captureSelectionSnapshot(event) {
  if (!quoteSelectionButton || quoteSelectionButton.disabled) return;
  if (event.cancelable && event.type !== "touchstart") event.preventDefault();
  const candidate = state.selectionQuoteCandidate || selectedAssistantQuoteCandidate() || state.lastValidQuoteCandidate;
  if (candidate?.text) {
    state.selectionQuoteLocked = candidate;
  }
}

function setupSelectionPopover() {
  if (!selectionPopover) return;
  const lockCandidate = (event) => {
    if (event.cancelable && event.type !== "touchstart") event.preventDefault();
    const candidate = state.selectionQuoteCandidate || selectedAssistantQuoteCandidate() || state.lastValidQuoteCandidate;
    if (candidate?.text) {
      state.selectionQuoteLocked = candidate;
    }
  };
  selectionPopover.addEventListener("pointerdown", lockCandidate);
  selectionPopover.addEventListener("mousedown", lockCandidate);
  selectionPopover.addEventListener("touchstart", lockCandidate, { passive: false });
  selectionPopover.addEventListener("pointerup", onSelectionPopoverPointerUp);
  selectionPopover.addEventListener("touchend", onSelectionPopoverTouchEnd, { passive: false });
  selectionPopover.addEventListener("click", onSelectionPopoverClick);
  chatLog.addEventListener("scroll", hideSelectionPopover, { passive: true });
  window.addEventListener("scroll", hideSelectionPopover, { passive: true });
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!isSelectionPopoverOpen() || selectionPopover.contains(event.target)) return;
      requestAnimationFrame(() => {
        if (!selectedAssistantQuoteCandidate()?.text) hideSelectionPopover();
      });
    },
    { passive: true }
  );
}

function onSelectionPopoverClick(event) {
  if (shouldSkipSelectionSyntheticClick(event)) return;
  handleSelectionPopoverAction(event);
}

function onSelectionPopoverPointerUp(event) {
  if (event.pointerType === "mouse") return;
  handleSelectionPointerActivation(event, () => handleSelectionPopoverAction(event));
}

function onSelectionPopoverTouchEnd(event) {
  handleSelectionPointerActivation(event, () => handleSelectionPopoverAction(event));
}

function handleSelectionPopoverAction(event) {
  const button = event.target instanceof Element ? event.target.closest("button[data-selection-action]") : null;
  if (!button) return;
  const candidate = state.selectionQuoteLocked || state.selectionQuoteCandidate || selectedAssistantQuoteCandidate() || state.lastValidQuoteCandidate;
  state.selectionQuoteLocked = null;
  hideSelectionPopover();
  if (!candidate?.text) return;
  if (button.dataset.selectionAction === "quote") {
    setFragmentQuote(candidate.messageId, candidate.text);
    haptic("light");
    return;
  }
  if (button.dataset.selectionAction === "copy") {
    copyText(candidate.text).then((ok) => showToast(ok ? "已复制所选内容" : "复制失败，请长按文本手动复制"));
  }
}

function quoteSelectionButtonPointerUp(event) {
  if (event.pointerType === "mouse") return;
  handleSelectionPointerActivation(event, quoteSelectedAssistantText);
}

function quoteSelectionButtonTouchEnd(event) {
  handleSelectionPointerActivation(event, quoteSelectedAssistantText);
}

function handleSelectionPointerActivation(event, run) {
  if (recentlyHandledSelectionAction()) return;
  if (event?.cancelable) event.preventDefault();
  event?.stopPropagation?.();
  state.selectionQuoteActionHandledAt = Date.now();
  run();
}

function shouldSkipSelectionSyntheticClick(event) {
  if (!recentlyHandledSelectionAction()) return false;
  if (event?.cancelable) event.preventDefault();
  event?.stopPropagation?.();
  return true;
}

function recentlyHandledSelectionAction() {
  return Date.now() - Number(state.selectionQuoteActionHandledAt || 0) < 550;
}

function positionSelectionPopover(candidate) {
  if (!selectionPopover) return;
  const selection = window.getSelection?.();
  if (!candidate?.text || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
    if (!state.selectionQuoteLocked?.text) hideSelectionPopover();
    return;
  }
  const range = selection.getRangeAt(0);
  const rect = selectionRectForRange(range);
  if (!rect || (!rect.width && !rect.height)) {
    if (!state.selectionQuoteLocked?.text) hideSelectionPopover();
    return;
  }

  selectionPopover.hidden = false;
  selectionPopover.dataset.messageId = candidate.messageId;
  selectionPopover.style.visibility = "hidden";
  selectionPopover.classList.add("is-visible");
  selectionPopover.setAttribute("aria-hidden", "false");
  const popoverRect = selectionPopover.getBoundingClientRect();

  const margin = 8;
  const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches || navigator.maxTouchPoints > 0;
  let top = coarsePointer ? rect.bottom + margin : rect.top - popoverRect.height - margin;
  if (!coarsePointer && top < margin) {
    top = rect.bottom + margin;
  }
  if (top + popoverRect.height > window.innerHeight - margin) {
    top = Math.max(margin, window.innerHeight - popoverRect.height - margin);
  }
  let left = rect.left + rect.width / 2 - popoverRect.width / 2;
  left = Math.max(margin, Math.min(window.innerWidth - popoverRect.width - margin, left));

  selectionPopover.style.top = `${Math.round(top)}px`;
  selectionPopover.style.left = `${Math.round(left)}px`;
  selectionPopover.style.visibility = "";
}

function selectionRectForRange(range) {
  const rects = Array.from(range.getClientRects?.() || []).filter((rect) => rect && (rect.width || rect.height));
  if (rects.length) {
    const first = rects[0];
    const last = rects[rects.length - 1];
    const left = Math.min(...rects.map((rect) => rect.left));
    const right = Math.max(...rects.map((rect) => rect.right));
    return {
      top: first.top,
      bottom: last.bottom,
      left,
      right,
      width: Math.max(1, right - left),
      height: Math.max(1, last.bottom - first.top),
    };
  }
  return range.getBoundingClientRect?.() || null;
}

function hideSelectionPopover() {
  if (!selectionPopover) return;
  selectionPopover.classList.remove("is-visible");
  selectionPopover.setAttribute("aria-hidden", "true");
  selectionPopover.hidden = true;
  selectionPopover.removeAttribute("data-message-id");
}

function isSelectionPopoverOpen() {
  return Boolean(selectionPopover && !selectionPopover.hidden);
}

function selectedAssistantQuoteCandidate() {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const bubble = chatBubbleForSelection(selection, range);
  if (!bubble) return null;

  const messageNode = bubble.closest(".message[data-message-id]");
  const messageId = messageNode?.dataset.messageId || "";
  if (!messageId) return null;

  const text = selectedAssistantText(range, bubble);
  if (!text) return null;
  const role = messageNode.classList.contains("user") ? "user" : "assistant";
  return { messageId, role, text };
}

function chatBubbleForSelection(selection, range) {
  const anchorBubble = chatBubbleForSelectionNode(selection.anchorNode);
  const focusBubble = chatBubbleForSelectionNode(selection.focusNode);
  if (anchorBubble && anchorBubble === focusBubble && rangeIntersectsElement(range, anchorBubble)) {
    return anchorBubble;
  }
  const textBubbles = chatBubblesForTextRange(range);
  if (textBubbles.length === 1) return textBubbles[0];
  const bubbles = Array.from(chatLog?.querySelectorAll(".message[data-message-id] .bubble") || []).filter((bubble) =>
    rangeIntersectsElement(range, bubble)
  );
  return bubbles.length === 1 ? bubbles[0] : null;
}

function chatBubblesForTextRange(range) {
  const root = selectionSearchRoot(range);
  if (!root) return [];
  const bubbles = new Set();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!String(node.nodeValue || "").trim()) return NodeFilter.FILTER_REJECT;
      const bubble = chatBubbleForSelectionNode(node);
      if (!bubble) return NodeFilter.FILTER_REJECT;
      if (!rangeIntersectsTextNode(range, node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node = walker.nextNode();
  while (node) {
    const bubble = chatBubbleForSelectionNode(node);
    if (bubble) bubbles.add(bubble);
    if (bubbles.size > 1) break;
    node = walker.nextNode();
  }
  return Array.from(bubbles);
}

function selectionSearchRoot(range) {
  const element = elementFromSelectionNode(range?.commonAncestorContainer);
  return element?.closest(".message[data-message-id]") || chatLog || null;
}

function chatBubbleForSelectionNode(node) {
  const element = elementFromSelectionNode(node);
  const bubble = element?.closest(".bubble");
  if (!bubble?.closest(".message[data-message-id]")) return null;
  return bubble;
}

function elementFromSelectionNode(node) {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
}

function selectedAssistantText(range, bubble) {
  const formulas = selectedMathSources(range, bubble);
  const selectedText = String(window.getSelection?.()?.toString() || "")
    .replace(/\s+/g, " ")
    .trim();
  if (formulas.length && selectionLivesInsideMath(formulas)) {
    return formulas.map((item) => item.source).join("\n").slice(0, 4000);
  }
  if (formulas.length) {
    const latex = formulas.map((item) => item.source).join("\n");
    return `${selectedText}\n\nLaTeX:\n${latex}`.trim().slice(0, 4000);
  }
  return selectedText.slice(0, 4000);
}

function selectedMathSources(range, bubble) {
  const seen = new Set();
  const sources = [];
  for (const element of bubble.querySelectorAll("[data-latex], .math-pending[data-math]")) {
    if (!rangeIntersectsElement(range, element)) continue;
    const source = String(element.dataset.latex || element.dataset.math || "").trim();
    if (!source || seen.has(source)) continue;
    seen.add(source);
    sources.push({ element, source });
  }
  return sources.slice(0, 8);
}

function selectionLivesInsideMath(formulas) {
  const selection = window.getSelection?.();
  if (!selection || !formulas.length) return false;
  const anchor = elementFromSelectionNode(selection.anchorNode);
  const focus = elementFromSelectionNode(selection.focusNode);
  return formulas.some(({ element }) => element.contains(anchor) && element.contains(focus));
}

function rangeIntersectsElement(range, element) {
  try {
    return range.intersectsNode(element);
  } catch {
    return false;
  }
}

function rangeIntersectsTextNode(range, node) {
  try {
    const nodeRange = document.createRange();
    nodeRange.selectNodeContents(node);
    return (
      range.compareBoundaryPoints(Range.END_TO_START, nodeRange) > 0 &&
      range.compareBoundaryPoints(Range.START_TO_END, nodeRange) < 0
    );
  } catch {
    return false;
  }
}

function renderSelectionQuoteButton() {
  if (!quoteSelectionButton) return;
  const enabled = Boolean((state.selectionQuoteCandidate || state.lastValidQuoteCandidate)?.text) && !state.offlineMode;
  quoteSelectionButton.disabled = !enabled;
  quoteSelectionButton.classList.toggle("active", enabled);
  quoteSelectionButton.setAttribute("aria-pressed", String(enabled));
}

function quoteSelectedAssistantText(event) {
  if (event?.type === "click" && shouldSkipSelectionSyntheticClick(event)) return;
  const candidate = state.selectionQuoteLocked || state.selectionQuoteCandidate || selectedAssistantQuoteCandidate() || state.lastValidQuoteCandidate;
  state.selectionQuoteLocked = null;
  if (!candidate?.text) {
    showToast("请先在聊天消息里选择一段内容");
    renderSelectionQuoteButton();
    return;
  }
  setFragmentQuote(candidate.messageId, candidate.text);
}

function setFragmentQuote(messageId, fragment) {
  const text = String(fragment || "").trim();
  if (!text) return;
  const message = state.messages.find((item) => item.id === messageId);
  if (!message || !["assistant", "user"].includes(message.role)) {
    clearSelectionQuoteState();
    return;
  }
  state.quoteDraft = {
    messageId,
    role: message.role,
    text,
    fragment: text,
    isFragment: true,
  };
  clearSelectionQuoteState();
  window.getSelection?.()?.removeAllRanges?.();
  renderQuotePreview();
  promptInput.focus();
  saveDraft();
}

function clearSelectionQuoteState({ render = true } = {}) {
  state.selectionQuoteCandidate = null;
  state.selectionQuoteLocked = null;
  state.lastValidQuoteCandidate = null;
  hideSelectionPopover();
  if (render) renderSelectionQuoteButton();
}

async function consumeShareTarget() {
  const params = new URLSearchParams(window.location.search);
  const shareId = params.get("share") || "";
  if (!shareId) return;
  params.delete("share");
  const nextQuery = params.toString();
  const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`;
  window.history.replaceState(null, "", nextUrl);
  try {
    const response = await apiFetch(`/api/share-target?id=${encodeURIComponent(shareId)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "读取分享内容失败");
    if (await confirmShareTarget(data.share || {})) {
      applyShareTarget(data.share || {});
    }
  } catch (error) {
    showToast(error.message || "读取分享内容失败");
  }
}

function confirmShareTarget(share) {
  const prompt = String(share.prompt || "").trim();
  const attachments = Array.isArray(share.attachments) ? share.attachments.length : 0;
  const errors = Array.isArray(share.errors) ? share.errors.length : 0;
  const preview = prompt ? `\n\n${prompt.slice(0, 120)}${prompt.length > 120 ? "..." : ""}` : "";
  const fileText = attachments ? `\n\n附件：${attachments} 个` : "";
  const errorText = errors ? `\n未识别文件：${errors} 个` : "";
  return confirmAction({
    title: "导入分享内容？",
    message: `导入这次分享内容到当前草稿？${fileText}${errorText}${preview}`,
    okText: "导入",
  });
}

function applyShareTarget(share) {
  const prompt = String(share.prompt || "").trim();
  const attachments = Array.isArray(share.attachments)
    ? share.attachments.map(normalizeStoredAttachment).filter(Boolean)
    : [];
  if (prompt) {
    promptInput.value = promptInput.value.trim() ? `${promptInput.value.trim()}\n\n${prompt}` : prompt;
  }
  const slots = Math.max(0, maxPendingAttachments - state.pendingAttachments.length);
  state.pendingAttachments.push(...attachments.slice(0, slots));
  renderAttachmentList();
  renderQuotePreview();
  resizeComposer();
  saveDraft();
  promptInput.focus();
  const skipped = Math.max(0, attachments.length - slots);
  const errors = Array.isArray(share.errors) ? share.errors : [];
  if (errors.length) {
    showToast(`已导入分享内容，${errors.length} 个文件未能识别`);
  } else if (skipped) {
    showToast(`已导入分享内容，另有 ${skipped} 个附件超过上限`);
  } else {
    showToast("已导入分享内容");
  }
}

function applyAppearanceSettings() {
  const root = document.documentElement;
  root.dataset.theme = state.themeStyle;
  root.dataset.mode = state.themeMode;
  root.style.setProperty("--content-font-size", `${state.readingFontSize}px`);
  root.style.setProperty("--code-font-size", `${state.codeFontSize}px`);
  syncMetaThemeColor();
}

function syncMetaThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const computed = getComputedStyle(document.documentElement);
  let value = computed.getPropertyValue("--bg-base-solid").trim() || computed.getPropertyValue("--bg-base").trim() || "#ffffff";
  if (value.startsWith("linear-gradient")) {
    value = computed.getPropertyValue("--bg-base-solid").trim() || "#ffffff";
  }
  meta.setAttribute("content", value);
}

function normalizeActiveSeekState() {
  if (state.activeSeekId && !findSeekById(state.activeSeekId)) {
    state.activeSeekId = "";
    localStorage.removeItem(storageKeys.activeSeek);
  }
}

function buildSystemPrompt(seekContext = state.activeSeekId) {
  const parts = [rolePrompts[state.role] || rolePrompts.general, formulaPrompt];
  const seek = resolveSeekContext(seekContext);
  if (seek) {
    const references = normalizeSeekReferenceAttachments(seek.referenceAttachments || []);
    parts.push(
      [
        `[Seek: ${seek.name}]`,
        seek.description ? `定位：${seek.description}` : "",
        "请优先遵循以下 Seek 专属指令：",
        seek.instructions,
        references.length
          ? `参考文件：${references.map((attachment) => attachment.name).join("、")}。这些文件会作为 Seek 背景资料参与本轮附件检索，请优先结合相关片段回答。`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
  return parts.filter(Boolean).join("\n\n");
}

function activeSeek() {
  return findSeekById(state.activeSeekId);
}

function activeSeekSnapshot() {
  return seekSnapshotFromSeek(activeSeek());
}

function activeProject() {
  return state.projects.find((project) => project.id === state.activeProjectId) || null;
}

function activeProjectSnapshot() {
  const project = activeProject();
  if (!project) {
    return { projectId: "", projectName: "", projectAttachments: [] };
  }
  return {
    projectId: project.id,
    projectName: project.name,
    projectAttachments: normalizeProjectAttachments(project.documents || []),
  };
}

function memoryScopeFromIds(projectId, seekId) {
  projectId = String(projectId || "").trim();
  seekId = normalizeSeekId(seekId || "");
  if (projectId) return `project:${projectId}`;
  if (seekId) return `seek:${seekId}`;
  return "global";
}

function memoryScopeForContext(context = null) {
  if (!context) return memoryScopeFromIds(state.activeProjectId, state.activeSeekId);
  return memoryScopeFromIds(context.projectId, context.seekId);
}

function memoryScopeForRequest(context, requestMessages = []) {
  for (let index = requestMessages.length - 1; index >= 0; index -= 1) {
    const message = requestMessages[index];
    if (message?.role !== "user") continue;
    const scope = memoryScopeForContext(message);
    if (scope !== "global") return scope;
    break;
  }
  return memoryScopeForContext(context);
}

function projectSnapshotFromMessage(message) {
  const projectId = String(message?.projectId || "").trim();
  if (!projectId) return null;
  return {
    projectId,
    projectName: String(message?.projectName || ""),
    projectAttachments: normalizeProjectAttachments(message?.projectAttachments || []),
  };
}

function seekSnapshotFromSeek(seek) {
  return seekCore.seekSnapshotFromSeek(seek);
}

function seekSnapshotFromMessage(message) {
  return seekCore.seekSnapshotFromMessage(message);
}

function resolveSeekContext(source = state.activeSeekId) {
  const seek = seekCore.resolveSeekContext(source, allSeeks());
  if (seek) {
    return {
      ...seek,
      referenceAttachments: normalizeSeekReferenceAttachments(seek.referenceAttachments || seek.seekReferenceAttachments || []),
      accent: findSeekById(seek.id)?.accent || seek.accent || "blue",
    };
  }
  return null;
}

function seekNameForMessage(message) {
  return seekCore.seekNameForMessage(message, allSeeks());
}

function seekDigestForPrompt(source = state.activeSeekId) {
  const seek = resolveSeekContext(source);
  if (!seek) return "";
  const references = normalizeSeekReferenceAttachments(seek.referenceAttachments || []).map((attachment) =>
    [attachment.fileId || "", attachment.name || "", attachment.kind || "", Number(attachment.charCount) || 0].join(":")
  );
  return [seek.id || "", seek.name || "", seek.description || "", seek.instructions || "", ...references].join("\n");
}

function allSeeks() {
  return [...presetSeeks, ...state.seeks];
}

function findSeekById(id) {
  return seekCore.findSeekById(allSeeks(), id);
}

function loadCustomSeeks() {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKeys.seeks) || "[]");
    if (!Array.isArray(parsed)) return [];
    return seekCore.normalizeCustomSeeks(parsed, { createId });
  } catch {
    return [];
  }
}

function normalizeSeek(value) {
  return seekCore.normalizeSeek(value, { createId });
}

function normalizeSeekText(value, maxLength) {
  return seekCore.normalizeSeekText(value, maxLength);
}

function normalizeSeekInstructions(value, maxLength) {
  return seekCore.normalizeSeekInstructions(value, maxLength);
}

function normalizeSeekReferenceAttachments(values) {
  return seekCore.normalizeSeekReferenceAttachments(values, { createId });
}

function saveCustomSeeks() {
  state.seeks = seekCore.normalizeCustomSeeks(state.seeks, { createId });
  localStorage.setItem(storageKeys.seeks, JSON.stringify(state.seeks));
}

function seekExportPayload() {
  return seekCore.seekExportPayload(state.seeks, { exportedAt: new Date().toISOString() });
}

function mergeImportedSeeks(payload) {
  const existingSeeks = allSeeks();
  return seekCore.mergeImportedSeeks(state.seeks, payload, existingSeeks, { createId, now: Date.now() });
}

function setActiveSeek(id, options = {}) {
  // 切 Seek 若要顺带开新对话，流式生成中先挡住，避免半套用（Seek 切了但 startNewConversation 被拦）。
  if (options.newChat && state.busy) {
    showToast("正在生成回复，请先停止再切换 Seek");
    return;
  }
  const seek = findSeekById(id);
  state.activeSeekId = seek ? seek.id : "";
  if (state.activeSeekId) {
    localStorage.setItem(storageKeys.activeSeek, state.activeSeekId);
  } else {
    localStorage.removeItem(storageKeys.activeSeek);
  }

  if (options.newChat) {
    startNewConversation();
  }

  const conversation = currentConversation();
  if (conversation) {
    conversation.seekId = state.activeSeekId;
    conversation.updatedAt = Date.now();
    saveConversations();
  }

  renderActiveSeekChip();
  renderSeekPanel();
  renderModelTabs();

  if (options.closePanel) {
    closeSeekPanel();
  }
}

function renderActiveSeekChip() {
  const seek = activeSeek();
  if (activeSeekRow) activeSeekRow.hidden = !seek;
  if (activeSeekChip) activeSeekChip.hidden = !seek;
  if (!seek) {
    if (promptInput) promptInput.placeholder = "问问 DeepSeek";
    return;
  }
  if (!activeSeekChip) return;
  activeSeekChip.textContent = `Seek 助手 · ${seek.name}`;
  activeSeekChip.title = seek.description || seek.instructions;
  activeSeekChip.dataset.accent = seek.accent || "blue";
  if (promptInput) promptInput.placeholder = `给 ${seek.name} 发送消息`;
}

function setActiveProject(id) {
  state.activeProjectId = String(id || "");
  if (state.activeProjectId) {
    localStorage.setItem(storageKeys.activeProject, state.activeProjectId);
  } else {
    localStorage.removeItem(storageKeys.activeProject);
  }
  renderActiveProjectChip();
  renderProjectPanel();
}

function renderActiveProjectChip() {
  const project = activeProject();
  if (activeProjectRow) activeProjectRow.hidden = !project;
  if (activeProjectChip) activeProjectChip.hidden = !project;
  if (!project || !activeProjectChip) return;
  const count = Array.isArray(project.documents) ? project.documents.length : 0;
  activeProjectChip.textContent = `项目 · ${project.name} · ${count} 份文档`;
  activeProjectChip.title = "当前对话会自动检索这个项目的文档库";
}

function renderSeekPanel() {
  renderActiveSeekChip();
  if (!seekPresetList || !seekCustomList) return;
  const query = state.seekSearch.toLowerCase();
  const matches = (seek) =>
    !query ||
    [seek.name, seek.description, seek.instructions, seek.starter]
      .join(" ")
      .toLowerCase()
      .includes(query);

  renderSeekCards(seekPresetList, presetSeeks.filter(matches), "没有匹配的推荐 Seek 助手。");
  renderSeekCards(seekCustomList, state.seeks.filter(matches), "还没有自己的自定义 Seek。点击“新建 Seek”开始。");
}

function renderSeekCards(host, seeks, emptyText) {
  host.replaceChildren();
  if (!seeks.length) {
    const empty = document.createElement("p");
    empty.className = "panel-empty";
    empty.textContent = emptyText;
    host.append(empty);
    return;
  }
  for (const seek of seeks) {
    host.append(renderSeekCard(seek));
  }
}

function renderSeekCard(seek) {
  const card = document.createElement("article");
  card.className = "seek-card";
  card.classList.toggle("active", seek.id === state.activeSeekId);
  card.dataset.accent = seek.accent || "blue";

  const avatar = document.createElement("div");
  avatar.className = "seek-avatar";
  avatar.textContent = seek.name.slice(0, 1).toUpperCase();

  const body = document.createElement("div");
  body.className = "seek-card-body";

  const title = document.createElement("h4");
  title.textContent = seek.name;
  const description = document.createElement("p");
  description.textContent = seek.description || seek.instructions;
  body.append(title, description);

  const references = normalizeSeekReferenceAttachments(seek.referenceAttachments || []);
  if (references.length) {
    const referenceBadge = document.createElement("span");
    referenceBadge.className = "seek-reference-badge";
    referenceBadge.textContent = `参考 ${references.length} 个文件`;
    body.append(referenceBadge);
  }

  if (seek.starter) {
    const starter = document.createElement("button");
    starter.type = "button";
    starter.className = "seek-starter-button";
    starter.dataset.seekStarter = seek.id;
    starter.textContent = seek.starter;
    body.append(starter);
  }

  const actions = document.createElement("div");
  actions.className = "seek-card-actions";

  const use = document.createElement("button");
  use.type = "button";
  use.className = "secondary-button";
  use.dataset.seekUse = seek.id;
  use.textContent = seek.id === state.activeSeekId ? "停用" : "使用";
  actions.append(use);

  const start = document.createElement("button");
  start.type = "button";
  start.className = "seek-primary-button";
  start.dataset.seekStart = seek.id;
  start.textContent = "新对话";
  actions.append(start);

  if (seek.builtin) {
    const fork = document.createElement("button");
    fork.type = "button";
    fork.className = "secondary-button";
    fork.dataset.seekFork = seek.id;
    fork.textContent = "复制";
    actions.append(fork);
  } else {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "secondary-button";
    edit.dataset.seekEdit = seek.id;
    edit.textContent = "编辑";
    actions.append(edit);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger-button";
    remove.dataset.seekDelete = seek.id;
    remove.textContent = "删除";
    actions.append(remove);
  }

  card.append(avatar, body, actions);
  return card;
}

function onSeekListClick(event) {
  const target = event.target;
  const starter = target?.closest("button[data-seek-starter]");
  if (starter) {
    const seek = findSeekById(starter.dataset.seekStarter);
    if (!seek) return;
    setActiveSeek(seek.id, { newChat: true });
    promptInput.value = seek.starter || "";
    resizeComposer();
    promptInput.focus();
    closeSeekPanel();
    return;
  }

  const use = target?.closest("button[data-seek-use]");
  if (use) {
    const nextId = use.dataset.seekUse || "";
    if (nextId === state.activeSeekId) {
      setActiveSeek("", { closePanel: true });
      showToast("已停用 Seek 助手");
    } else {
      setActiveSeek(nextId, { closePanel: true });
    }
    return;
  }

  const start = target?.closest("button[data-seek-start]");
  if (start) {
    const seek = findSeekById(start.dataset.seekStart);
    setActiveSeek(start.dataset.seekStart || "", { closePanel: true, newChat: true });
    if (seek?.starter) {
      promptInput.value = seek.starter;
      resizeComposer();
    }
    promptInput.focus();
    return;
  }

  const fork = target?.closest("button[data-seek-fork]");
  if (fork) {
    forkSeek(fork.dataset.seekFork || "");
    return;
  }

  const edit = target?.closest("button[data-seek-edit]");
  if (edit) {
    startSeekEditor(edit.dataset.seekEdit || "");
    return;
  }

  const remove = target?.closest("button[data-seek-delete]");
  if (remove) {
    deleteSeek(remove.dataset.seekDelete || "");
  }
}

function startSeekEditor(id = "") {
  if (!seekEditorForm) return;
  const seek = state.seeks.find((item) => item.id === id) || null;
  state.editingSeekId = seek?.id || "";
  seekEditorTitle.textContent = seek ? "编辑 Seek" : "新建 Seek";
  seekNameInput.value = seek?.name || "";
  seekDescriptionInput.value = seek?.description || "";
  seekInstructionsInput.value = seek?.instructions || "";
  state.seekEditorAttachments = normalizeSeekReferenceAttachments(seek?.referenceAttachments || []);
  state.seekEditorUploadingAttachments = [];
  renderSeekReferenceList();
  seekStarterInput.value = seek?.starter || "";
  seekEditorForm.hidden = false;
  requestAnimationFrame(() => seekNameInput.focus());
}

function cancelSeekEditor() {
  state.editingSeekId = "";
  state.seekEditorAttachments = [];
  state.seekEditorUploadingAttachments = [];
  renderSeekReferenceList();
  if (seekEditorForm) seekEditorForm.hidden = true;
}

function saveSeekFromForm(event) {
  event.preventDefault();
  const name = normalizeSeekText(seekNameInput.value, 32);
  const description = normalizeSeekText(seekDescriptionInput.value, 140);
  const instructions = normalizeSeekInstructions(seekInstructionsInput.value, 5000);
  const starter = normalizeSeekText(seekStarterInput.value, 160);
  if (state.seekEditorUploadingAttachments.length) {
    const hasActiveUpload = state.seekEditorUploadingAttachments.some((item) => item.status !== "error");
    showToast(hasActiveUpload ? "参考文件还在上传或识别，请稍等" : "请先移除识别失败的参考文件");
    return;
  }
  if (!name || !instructions) {
    showToast("Seek 需要名称和专属指令");
    return;
  }

  const now = Date.now();
  const existingIndex = state.seeks.findIndex((seek) => seek.id === state.editingSeekId);
  if (existingIndex < 0 && state.seeks.length >= maxCustomSeeks) {
    showToast(`最多保存 ${maxCustomSeeks} 个自定义 Seek`);
    return;
  }
  if (seekCore.hasDuplicateSeekName(allSeeks(), name, state.editingSeekId)) {
    showToast(`已存在名为「${name}」的 Seek`);
    return;
  }
  const next = {
    id: existingIndex >= 0 ? state.seeks[existingIndex].id : `seek-${createId()}`,
    name,
    description,
    instructions,
    starter,
    referenceAttachments: normalizeSeekReferenceAttachments(state.seekEditorAttachments),
    accent: existingIndex >= 0 ? state.seeks[existingIndex].accent : ["blue", "green", "purple", "orange"][state.seeks.length % 4],
    builtin: false,
    createdAt: existingIndex >= 0 ? state.seeks[existingIndex].createdAt : now,
    updatedAt: now,
  };

  if (existingIndex >= 0) {
    state.seeks.splice(existingIndex, 1, next);
  } else {
    state.seeks.unshift(next);
  }
  saveCustomSeeks();
  setActiveSeek(next.id);
  cancelSeekEditor();
  renderSeekPanel();
  showToast("Seek 已保存");
}

function forkSeek(id) {
  const source = findSeekById(id);
  if (!source) return;
  if (state.seeks.length >= maxCustomSeeks) {
    showToast(`最多保存 ${maxCustomSeeks} 个自定义 Seek`);
    return;
  }
  const existingNames = new Set(allSeeks().map((seek) => normalizeSeekText(seek.name, 32)).filter(Boolean));
  const now = Date.now();
  const next = normalizeSeek({
    id: `seek-${createId()}`,
    name: seekCore.uniqueSeekName(source.name, existingNames, 32),
    description: source.description,
    instructions: source.instructions,
    starter: source.starter,
    referenceAttachments: source.referenceAttachments,
    accent: source.accent,
    createdAt: now,
    updatedAt: now,
  });
  if (!next) {
    showToast("无法复制这个 Seek");
    return;
  }
  state.seeks.unshift(next);
  saveCustomSeeks();
  renderSeekPanel();
  startSeekEditor(next.id);
  showToast(`已复制「${source.name}」，可以继续编辑`);
}

function exportCustomSeeks() {
  if (!state.seeks.length) {
    showToast("还没有可导出的自定义 Seek");
    return;
  }
  const payload = seekExportPayload();
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  downloadTextFile(text, `deepseek-seeks-${new Date().toISOString().slice(0, 10)}.json`, "application/json;charset=utf-8");
  showToast(`已导出 ${payload.seeks.length} 个自定义 Seek`);
}

async function importSeeksFromFile(event) {
  const file = event.target?.files?.[0];
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    const result = mergeImportedSeeks(payload);
    if (!result.importedCount) {
      showToast(result.skippedCount ? "没有可导入的 Seek，可能已达到上限" : "没有找到可导入的 Seek");
      return;
    }
    state.seeks = result.seeks;
    saveCustomSeeks();
    renderSeekPanel();
    const skipped = result.skippedCount ? `，跳过 ${result.skippedCount} 个` : "";
    showToast(`已导入 ${result.importedCount} 个 Seek${skipped}`);
  } catch {
    showToast("导入失败，请选择有效的 Seek JSON 文件");
  } finally {
    if (seekImportInput) seekImportInput.value = "";
  }
}

async function deleteSeek(id) {
  const seek = state.seeks.find((item) => item.id === id);
  if (!seek) return;
  if (!(await confirmAction({ title: "删除 Seek？", message: `删除 Seek「${seek.name}」？`, okText: "删除", danger: true }))) return;
  state.seeks = state.seeks.filter((item) => item.id !== id);
  haptic("heavy");
  saveCustomSeeks();
  if (state.activeSeekId === id) {
    setActiveSeek("");
  } else {
    renderSeekPanel();
  }
}

function messageForApi(message, includeImages = false) {
  const apiMessage = { role: message.role, content: messageContentForApi(message) };
  if (message.projectId) apiMessage.projectId = message.projectId;
  if (message.seekId) apiMessage.seekId = message.seekId;
  const attachments = attachmentsForApi(message, includeImages);
  if (attachments.length) {
    apiMessage.attachments = attachments;
  }
  return apiMessage;
}

// 组装发往 /api/chat 的消息序列。只给最后一条 user 消息（本轮提问）的图片附件注入
// base64，后端据此把它组装成多模态视觉请求；历史图片不带 base64，退回 OCR 文字，
// 既省 token 又保持长历史的 prompt cache 前缀稳定。
function buildApiMessages(messages) {
  const nonStreaming = (Array.isArray(messages) ? messages : []).filter((message) => !message.streaming);
  const lastUserId = [...nonStreaming].reverse().find((message) => message.role === "user")?.id || "";
  return nonStreaming.map((message) =>
    messageForApi(message, Boolean(lastUserId) && message.role === "user" && message.id === lastUserId)
  );
}

function attachmentsForApi(message, includeImages = false) {
  const attachments = combinedAttachmentsForMessage(message);
  return attachments
    .map((attachment) => {
      const apiAttachment = {
        fileId: attachment.fileId || "",
        projectId: attachment.projectId || "",
        name: attachment.name || "附件",
        type: attachment.type || "",
        size: Number(attachment.size) || 0,
        kind: attachment.kind || "text",
        charCount: Number(attachment.charCount) || 0,
        chunkCount: Number(attachment.chunkCount) || 0,
        text: attachment.fileId ? "" : String(attachment.text || ""),
      };
      // 仅本轮（includeImages）的图片附件带上 base64，交给后端组装多模态视觉请求。
      if (includeImages && attachment.kind === "image") {
        const imageData = attachment.imagePreview || attachment.thumbnail || "";
        if (typeof imageData === "string" && imageData.startsWith("data:image/")) {
          apiAttachment.imageData = imageData;
        }
      }
      return apiAttachment;
    })
    .filter((attachment) => attachment.fileId || attachment.text || attachment.imageData);
}

function messageContentForApi(message) {
  const content = String(message.content || "").trim();
  const attachments = combinedAttachmentsForMessage(message);
  if (!attachments.length) return content;

  const legacyAttachments = attachments.filter((attachment) => !attachment.fileId && attachment.text);
  if (!legacyAttachments.length) {
    return content || "请根据附件内容回答。";
  }

  const attachmentContext = formatAttachmentsForPrompt(legacyAttachments);
  return `${content || "请根据附件内容回答。"}\n\n${attachmentContext}`.trim();
}

function combinedAttachmentsForMessage(message) {
  return mergeAttachmentLists(
    message?.attachments,
    message?.role === "user" ? message.seekReferenceAttachments : [],
    message?.role === "user" ? message.projectAttachments : []
  );
}

function mergeAttachmentLists(...lists) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const attachment = normalizeStoredAttachment(raw);
      if (!attachment) continue;
      const key = attachment.fileId
        ? `file:${attachment.fileId}`
        : `inline:${attachment.name}:${attachment.size}:${attachment.text.slice(0, 100)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(attachment);
    }
  }
  return merged;
}

function formatAttachmentsForPrompt(attachments) {
  let used = 0;
  const lines = ["[用户上传的文件内容]"];

  for (const [index, attachment] of attachments.entries()) {
    if (!attachment.text) continue;
    const header = `\n--- 文件 ${index + 1}: ${attachment.name} (${formatBytes(attachment.size)}) ---`;
    const remaining = maxAttachmentPromptChars - used;
    if (remaining <= 0) {
      lines.push("\n[其余附件内容因长度限制未发送]");
      break;
    }
    const text = attachment.text.slice(0, remaining);
    used += text.length;
    lines.push(header, text);
    if (attachment.truncated) {
      lines.push("[文件内容较长，已截断]");
    }
  }

  return lines.join("\n");
}

function currentConversation() {
  return state.conversations.find((item) => item.id === state.currentConversationId) || null;
}

function compressedRequestParts(messages, contextSummary, deltaCount = 0) {
  const conversation = currentConversation();
  return {
    messages,
    contextSummary,
    contextSummaryGeneration: Number(conversation?.contextSummaryGeneration) || 0,
    contextSummaryMessageCount: Number(conversation?.contextSummaryMessageCount) || 0,
    contextCompressionDeltaCount: Number(deltaCount) || 0,
  };
}

function messagesAfterCompressedBoundary(requestMessages, compressedCount) {
  const start = Math.min(Math.max(0, Number(compressedCount) || 0), requestMessages.length);
  const messages = requestMessages.slice(start);
  if (messages.length) return messages;
  const fallbackCount = Math.min(contextCompression.keepRecentMessages, requestMessages.length);
  return requestMessages.slice(-fallbackCount);
}

async function buildCompressedRequestParts(apiKey, requestMessages, seekContext = state.activeSeekId) {
  const conversation = currentConversation();
  const existingSummary = conversation?.contextSummary || "";
  const alreadyCompressedCount = Math.max(0, Number(conversation?.contextSummaryMessageCount) || 0);
  if (!contextCompression.enabled) {
    const messages = existingSummary
      ? messagesAfterCompressedBoundary(requestMessages, alreadyCompressedCount)
      : requestMessages;
    return compressedRequestParts(messages, existingSummary);
  }

  const totalChars = messagesApproxChars(requestMessages);
  const shouldCompress =
    requestMessages.length > contextCompression.triggerMessages ||
    totalChars > contextCompression.triggerChars;

  if (!shouldCompress) {
    const messages = existingSummary
      ? messagesAfterCompressedBoundary(requestMessages, alreadyCompressedCount)
      : requestMessages;
    return compressedRequestParts(messages, existingSummary);
  }

  const keep = Math.min(contextCompression.keepRecentMessages, requestMessages.length);
  const compressEnd = Math.max(0, requestMessages.length - keep);
  const safeAlreadyCompressedCount = Math.min(alreadyCompressedCount, compressEnd);
  const deltaMessages = requestMessages.slice(safeAlreadyCompressedCount, compressEnd);
  const recentMessages = requestMessages.slice(compressEnd);

  if (!deltaMessages.length) {
    return compressedRequestParts(recentMessages, existingSummary);
  }

  const deltaChars = messagesApproxChars(deltaMessages);
  const deltaIsSmall =
    deltaMessages.length < contextCompression.minDeltaMessages &&
    deltaChars < contextCompression.minDeltaChars;

  if (deltaIsSmall) {
    return compressedRequestParts(
      requestMessages.slice(safeAlreadyCompressedCount),
      existingSummary
    );
  }

  const fingerprint = lightweightHash(
    JSON.stringify({
      previousSummary: existingSummary.slice(0, 2000),
      compressedUntil: compressEnd,
      seek: seekDigestForPrompt(seekContext),
      delta: deltaMessages.map(messageDigestForCompression),
    })
  );

  if (
    existingSummary &&
    conversation?.contextSummaryFingerprint === fingerprint &&
    Number(conversation?.contextSummaryMessageCount) === compressEnd
  ) {
    return compressedRequestParts(recentMessages, existingSummary);
  }

  showToast("正在压缩历史上下文");

  try {
    const summary = await compressContextOnServer(
      apiKey,
      deltaMessages,
      existingSummary,
      conversation?.contextPins || [],
      seekContext
    );
    saveContextSummary(summary, fingerprint, compressEnd);
    return compressedRequestParts(recentMessages, summary, deltaMessages.length);
  } catch (error) {
    console.warn("Context compression failed:", error);

    const fallbackMessages = requestMessages.slice(safeAlreadyCompressedCount);
    const fallbackChars = messagesApproxChars(fallbackMessages);

    if (fallbackMessages.length > 40) {
      throw new Error("Context compression failed and the uncompressed history is too long to send safely.");
    }

    if (fallbackChars <= 120000) {
      showToast("上下文压缩失败，已保留未压缩消息继续");
      return compressedRequestParts(fallbackMessages, existingSummary);
    }

    showToast("上下文压缩失败，已改用最近对话继续");
    return compressedRequestParts(recentMessages, existingSummary);
  }
}

async function compressContextOnServer(apiKey, messages, previousSummary, contextPins = [], seekContext = state.activeSeekId) {
  const response = await apiFetch("/api/compress-context", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey,
      compressionModel: modelRoutes.fast,
      systemPrompt: buildSystemPrompt(seekContext),
      previousSummary,
      contextPins,
      messages,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `上下文压缩失败：${response.status}`);
  }

  const summary = String(data.summary || "").trim();
  if (!summary) {
    throw new Error("压缩结果为空");
  }
  return summary;
}

function saveContextSummary(summary, fingerprint, messageCount) {
  ensureCurrentConversation();
  const conversation = currentConversation();
  if (!conversation) return;

  conversation.contextSummary = String(summary || "").slice(0, 12000);
  conversation.contextSummaryFingerprint = fingerprint;
  conversation.contextSummaryMessageCount = Number(messageCount) || 0;
  conversation.contextSummaryGeneration = Number(conversation.contextSummaryGeneration || 0) + 1;
  conversation.updatedAt = Date.now();
  saveConversations();
}

function clearContextSummary() {
  const conversation = currentConversation();
  if (!conversation) return;
  conversation.contextSummary = "";
  conversation.contextSummaryFingerprint = "";
  conversation.contextSummaryMessageCount = 0;
  conversation.contextSummaryGeneration = 0;
  conversation.updatedAt = Date.now();
  saveConversations();
}

function messagesApproxChars(messages) {
  return messages.reduce((total, message) => {
    const contentChars = String(message.content || "").length;
    const attachmentChars = combinedAttachmentsForMessage(message).reduce((sum, attachment) => {
      return sum + Number(attachment.charCount || 0) + String(attachment.text || "").length;
    }, 0);

    return total + contentChars + attachmentChars;
  }, 0);
}

function messageDigestForCompression(message) {
  return {
    role: message.role,
    content: String(message.content || "").slice(0, 6000),
    attachments: combinedAttachmentsForMessage(message).map((attachment) => ({
          fileId: attachment.fileId || "",
          name: attachment.name || "",
          kind: attachment.kind || "",
          charCount: Number(attachment.charCount) || 0,
          chunkCount: Number(attachment.chunkCount) || 0,
        })),
  };
}

function lightweightHash(value) {
  const text = String(value || "");
  let hash = 2166136261;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16);
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function confirmAttachmentSendIfNeeded() {
  const hasSeenNotice = localStorage.getItem(storageKeys.attachmentPrivacySeen) === "1";
  if (hasSeenNotice && !state.attachmentConfirmEachSend) {
    return true;
  }

  const confirmed = await confirmAction({
    title: "发送附件？",
    message: "附件会在本地后端解析并分块索引，本轮只把与问题相关的片段发送给 DeepSeek API。确认发送吗？",
    okText: "确认发送",
  });
  if (confirmed) {
    localStorage.setItem(storageKeys.attachmentPrivacySeen, "1");
  }
  return confirmed;
}

function offerDraftRestore() {
  const draft = loadDraft();
  if (!draft || (!draft.content && !draft.attachments.length && !draft.quoteDraft)) return;
  if (!draftRestore) return;
  const preview = [draft.content, draft.quoteDraft?.fragment || draft.quoteDraft?.text || ""]
    .map((item) => String(item || "").replace(/\s+/g, " ").trim())
    .find(Boolean);
  const label = draftRestore.querySelector("span");
  if (label) {
    const suffix = preview ? `：${preview.slice(0, 80)}${preview.length > 80 ? "..." : ""}` : "";
    label.textContent = `发现未发送草稿${suffix}`;
  }
  draftRestore.hidden = false;
  window.clearTimeout(state.draftRestoreTimer);
  state.draftRestoreTimer = window.setTimeout(() => {
    if (draftRestore) draftRestore.hidden = true;
  }, 8000);
}

function loadDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(storageKeys.draft) || "null");
    if (!draft || typeof draft !== "object") return null;
    return {
      content: String(draft.content || ""),
      attachments: Array.isArray(draft.attachments)
        ? draft.attachments.map(normalizeStoredAttachment).filter(Boolean)
        : [],
      quoteDraft: draft.quoteDraft && typeof draft.quoteDraft === "object" ? draft.quoteDraft : null,
      savedAt: Number(draft.savedAt) || 0,
    };
  } catch {
    return null;
  }
}

async function loadProjects() {
  try {
    const response = await apiFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list" }),
    });
    const data = await response.json().catch(() => ({}));
    state.projects = Array.isArray(data.projects) ? data.projects.map(normalizeProject).filter(Boolean) : [];
    if (state.activeProjectId && !activeProject()) {
      setActiveProject("");
    }
    renderActiveProjectChip();
    renderProjectPanel();
  } catch {
    state.projects = [];
  }
}

function normalizeProject(value) {
  if (!value || typeof value !== "object") return null;
  return {
    id: String(value.id || ""),
    name: String(value.name || "项目").slice(0, 60),
    documents: normalizeProjectAttachments(value.documents || []),
    createdAt: Number(value.createdAt) || 0,
    updatedAt: Number(value.updatedAt) || 0,
  };
}

async function createProjectFromForm(event) {
  event.preventDefault();
  const name = projectNameInput?.value.trim() || "";
  if (!name) {
    showToast("请输入项目名称");
    projectNameInput?.focus();
    return;
  }
  try {
    const response = await apiFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", name }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "创建项目失败");
    const project = normalizeProject(data.project);
    if (project) {
      state.projects.unshift(project);
      setActiveProject(project.id);
      if (projectNameInput) projectNameInput.value = "";
    }
  } catch (error) {
    showToast(error.message || "创建项目失败");
  }
}

function renderProjectPanel() {
  renderActiveProjectChip();
  updateProjectUploadControls();
  if (!projectList || !projectDocumentList || !projectDocuments) return;
  projectList.replaceChildren();
  if (!state.projects.length) {
    const empty = document.createElement("p");
    empty.className = "panel-empty";
    empty.textContent = "还没有项目。创建一个项目后上传长期资料。";
    projectList.append(empty);
  }
  for (const project of state.projects) {
    const item = document.createElement("article");
    item.className = "project-item";
    item.classList.toggle("active", project.id === state.activeProjectId);

    const open = document.createElement("button");
    open.type = "button";
    open.dataset.projectOpen = project.id;
    open.className = "project-open-button";
    open.innerHTML = `<strong></strong><span></span>`;
    open.querySelector("strong").textContent = project.name;
    open.querySelector("span").textContent = `${project.documents.length} 份文档`;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "history-delete-button";
    remove.dataset.projectDelete = project.id;
    remove.setAttribute("aria-label", `删除项目 ${project.name}`);
    remove.textContent = "×";

    item.append(open, remove);
    projectList.append(item);
  }

  const project = activeProject();
  projectDocuments.hidden = !project;
  projectDocumentList.replaceChildren();
  if (!project) return;
  projectDocumentsTitle.textContent = `${project.name} · 文档库`;
  if (!project.documents.length) {
    const empty = document.createElement("p");
    empty.className = "panel-empty";
    empty.textContent = "这个项目还没有文档。";
    projectDocumentList.append(empty);
    return;
  }
  for (const doc of project.documents) {
    const row = document.createElement("article");
    row.className = "project-document";
    row.innerHTML = `<strong></strong><span></span>`;
    row.querySelector("strong").textContent = doc.name;
    row.querySelector("span").textContent = `${String(doc.kind || "FILE").toUpperCase()} · ${formatBytes(doc.size)} · ${doc.chunkCount || 0} 段`;
    projectDocumentList.append(row);
  }
}

function onProjectListClick(event) {
  const target = event.target instanceof Element ? event.target : event.target?.parentElement;
  const open = target?.closest("button[data-project-open]");
  if (open) {
    setActiveProject(open.dataset.projectOpen || "");
    return;
  }
  const remove = target?.closest("button[data-project-delete]");
  if (remove) {
    deleteProject(remove.dataset.projectDelete || "");
  }
}

async function deleteProject(id) {
  const project = state.projects.find((item) => item.id === id);
  if (
    !project ||
    !(await confirmAction({
      title: "删除项目？",
      message: `删除项目「${project.name}」？文档库也会从本机移除。`,
      okText: "删除",
      danger: true,
    }))
  ) {
    return;
  }
  try {
    await apiFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", id }),
    });
    state.projects = state.projects.filter((item) => item.id !== id);
    if (state.activeProjectId === id) setActiveProject("");
    renderProjectPanel();
  } catch (error) {
    showToast(error.message || "删除项目失败");
  }
}

async function onProjectUploadInputChange(event) {
  const files = Array.from(event.target?.files || []);
  if (!files.length || !state.activeProjectId) return;
  const selectedFiles = validatedUploadFiles(files, {
    remainingSlots: state.uploadLimits.maxFiles,
    maxSlots: state.uploadLimits.maxFiles,
    slotMessage: `一次最多上传 ${state.uploadLimits.maxFiles} 个文件`,
  });
  if (!selectedFiles.length) {
    if (projectUploadInput) projectUploadInput.value = "";
    return;
  }
  state.projectUploading = true;
  updateProjectUploadControls();
  try {
    const form = new FormData();
    for (const file of selectedFiles) form.append("files", file, file.name);
    const response = await apiFetch(`/api/project-files?projectId=${encodeURIComponent(state.activeProjectId)}`, {
      method: "POST",
      body: form,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "项目文档上传失败");
    await loadProjects();
    showToast(`已加入 ${Array.isArray(data.documents) ? data.documents.length : selectedFiles.length} 份项目文档`);
  } catch (error) {
    showToast(error.message || "项目文档上传失败");
  } finally {
    state.projectUploading = false;
    updateProjectUploadControls();
    if (projectUploadInput) projectUploadInput.value = "";
  }
}

function updateProjectUploadControls() {
  if (projectUploadButton) projectUploadButton.disabled = state.projectUploading || !state.activeProjectId;
}

function restoreDraft() {
  const draft = loadDraft();
  if (!draft) return;
  promptInput.value = draft.content || "";
  state.pendingAttachments = draft.attachments || [];
  state.quoteDraft = draft.quoteDraft || null;
  window.clearTimeout(state.draftRestoreTimer);
  if (draftRestore) draftRestore.hidden = true;
  renderAttachmentList();
  renderQuotePreview();
  resizeComposer();
  promptInput.focus();
  showToast("已恢复草稿");
}

function discardDraft() {
  clearDraft();
  window.clearTimeout(state.draftRestoreTimer);
  if (draftRestore) draftRestore.hidden = true;
  showToast("已丢弃草稿");
}

function startDraftAutosave() {
  saveDraft();
  state.draftTimer = window.setInterval(saveDraft, draftSaveIntervalMs);
}

function saveDraft() {
  const content = promptInput?.value || "";
  const attachments = (state.pendingAttachments || []).map((attachment) => ({ ...attachment }));
  const quoteDraft = state.quoteDraft ? { ...state.quoteDraft } : null;
  if (!content.trim() && !attachments.length && !quoteDraft) {
    localStorage.removeItem(storageKeys.draft);
    return;
  }
  localStorage.setItem(
    storageKeys.draft,
    JSON.stringify({
      content,
      attachments,
      quoteDraft,
      savedAt: Date.now(),
    })
  );
}

function clearDraft() {
  localStorage.removeItem(storageKeys.draft);
  if (draftRestore) draftRestore.hidden = true;
}

async function scheduleReminder(reminder) {
  try {
    const response = await apiFetch("/api/reminders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", ...reminder }),
    });
    if (response.ok) {
      showToast("已创建本地提醒");
      await ensureNotificationPermission();
    }
  } catch {
    // The chat request should not fail just because the optional reminder queue is unavailable.
  }
}

function startReminderPolling() {
  pollDueReminders();
  state.reminderTimer = window.setInterval(pollDueReminders, reminderPollIntervalMs);
}

async function pollDueReminders() {
  try {
    const response = await apiFetch("/api/reminders/due", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    for (const reminder of Array.isArray(data.reminders) ? data.reminders : []) {
      showReminderNotification(reminder);
    }
  } catch {
    // Silent polling failure: reminders are local best-effort notifications.
  }
}

async function ensureNotificationPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return (await Notification.requestPermission()) === "granted";
}

async function showReminderNotification(reminder) {
  const title = reminder.title || "DeepSeek 提醒";
  const body = reminder.content || "";
  if (!(await ensureNotificationPermission())) {
    showToast(`${title}：${body}`);
    return;
  }
  const registration = await navigator.serviceWorker?.ready.catch(() => null);
  if (registration?.active) {
    registration.active.postMessage({ type: "show_reminder", title, body, tag: reminder.id || "deepseek-reminder" });
  } else if ("Notification" in window) {
    new Notification(title, { body, tag: reminder.id || "deepseek-reminder" });
  }
}

async function viewMemories() {
  try {
    const response = await apiFetch("/api/memory");
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || `读取记忆失败：${response.status}`);
    }

    const memories = Array.isArray(data.memories) ? data.memories : [];
    openMemoryPanel(memories);
  } catch (error) {
    showToast(error.message || "读取记忆失败");
  }
}

async function clearMemories() {
  if (
    !(await confirmAction({
      title: "清空长期记忆？",
      message: "这不会删除历史对话，但会移除所有已保存的长期记忆。",
      okText: "清空",
      danger: true,
    }))
  ) {
    return;
  }

  try {
    const response = await apiFetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clear" }),
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || `清空记忆失败：${response.status}`);
    }

    showToast(`已清空 ${data.deleted || 0} 条长期记忆`);
    closeMemoryPanel();
  } catch (error) {
    showToast(error.message || "清空记忆失败");
  }
}

function openMemoryPanel(memories) {
  if (!memoryPanel || !memoryPanelList) return;
  closeHistory();
  closeSettings();
  closeSeekPanel();
  closeSearchPanel();
  closeFilePreview();
  closeDiagnosticsPanel();
  closeActivityPanel();
  renderMemoryPanel(memories);
  memoryPanel.classList.add("open");
  memoryPanel.setAttribute("aria-hidden", "false");
  setBackdropVisible(true);
  activateFocusTrap(memoryPanel);
}

function closeMemoryPanel() {
  if (!memoryPanel) return;
  memoryPanel.classList.remove("open");
  memoryPanel.setAttribute("aria-hidden", "true");
  deactivateFocusTrap(memoryPanel);
  syncBackdrop();
}

function renderMemoryPanel(memories) {
  if (!memoryPanelList) return;
  memoryPanelList.replaceChildren();

  if (!memories.length) {
    const empty = document.createElement("p");
    empty.className = "panel-empty";
    empty.textContent = "暂无长期记忆。";
    memoryPanelList.append(empty);
    return;
  }

  for (const memory of memories) {
    const item = document.createElement("article");
    item.className = "memory-item";

    const meta = document.createElement("div");
    meta.className = "memory-item-meta";
    meta.textContent = `[${memory.category || "fact"}] ${memory.scope || "global"}`;

    const content = document.createElement("p");
    content.textContent = memory.content || "";

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "memory-delete-button";
    deleteButton.dataset.memoryDeleteId = memory.id || "";
    deleteButton.textContent = "删除";

    item.append(meta, content, deleteButton);
    memoryPanelList.append(item);
  }
}

async function onMemoryPanelClick(event) {
  const target = event.target instanceof Element ? event.target : event.target?.parentElement;
  const deleteButton = target?.closest("button[data-memory-delete-id]");
  if (!deleteButton) return;

  const id = deleteButton.dataset.memoryDeleteId || "";
  if (!id) return;

  try {
    const response = await apiFetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "deleteById", id }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `删除记忆失败：${response.status}`);
    }
    showToast(data.deleted ? "已删除 1 条长期记忆" : "没有找到这条记忆");
    viewMemories();
  } catch (error) {
    showToast(error.message || "删除记忆失败");
  }
}

function handleMemorySuggestionEvent(event, assistantMessage) {
  const suggestion = normalizeMemorySuggestion(event);
  if (!suggestion) return;
  if (!Array.isArray(assistantMessage.memorySuggestions)) {
    assistantMessage.memorySuggestions = [];
  }
  if (!assistantMessage.memorySuggestions.some((item) => item.content === suggestion.content && item.scope === suggestion.scope)) {
    assistantMessage.memorySuggestions.push(suggestion);
  }
  showMemorySuggestionToast(suggestion);
  updateStreamingMessage(assistantMessage);
}

function normalizeMemorySuggestion(value) {
  const content = String(value?.content || "").trim().slice(0, 1200);
  if (!content) return null;
  const category = ["preference", "project", "todo", "fact"].includes(value?.category) ? value.category : "fact";
  const scope = normalizeMemoryScope(value?.scope);
  const conflicts = Array.isArray(value?.conflicts) ? value.conflicts.slice(0, 5) : [];
  return { content, category, scope, conflicts };
}

function normalizeMemoryScope(value) {
  const scope = String(value || "global").trim();
  return /^(global|project:[A-Za-z0-9_.:-]{1,80}|seek:[A-Za-z0-9_.:-]{1,80})$/.test(scope) ? scope : "global";
}

function showMemorySuggestionToast(suggestion) {
  const existing = document.querySelector(".memory-suggestion-toast");
  if (existing) removeWithMotion(existing);

  const toast = document.createElement("section");
  toast.className = "memory-suggestion-toast";
  toast.setAttribute("role", "dialog");
  toast.setAttribute("aria-label", "长期记忆建议");

  const title = document.createElement("strong");
  title.textContent = "是否保存这条记忆？";
  const body = document.createElement("p");
  body.textContent = suggestion.content;
  const meta = document.createElement("span");
  meta.className = "memory-suggestion-meta";
  meta.textContent = `${suggestion.category} · ${suggestion.scope}`;

  const actions = document.createElement("div");
  actions.className = "memory-suggestion-actions";
  const dismissButton = document.createElement("button");
  dismissButton.type = "button";
  dismissButton.className = "secondary-button";
  dismissButton.textContent = "暂不保存";
  dismissButton.addEventListener("click", () => removeWithMotion(toast));

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "seek-save-button";
  saveButton.textContent = "保存";
  saveButton.addEventListener("click", async () => {
    saveButton.disabled = true;
    const saved = await saveMemorySuggestion(suggestion);
    if (saved) removeWithMotion(toast);
    saveButton.disabled = false;
  });

  actions.append(dismissButton, saveButton);
  toast.append(title, body, meta, actions);
  document.body.append(toast);
}

async function saveMemorySuggestion(suggestion, replaceIds = []) {
  try {
    const response = await apiFetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add",
        content: suggestion.content,
        category: suggestion.category,
        scope: suggestion.scope,
        replaceIds,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 409 && data.code === "memory_conflict" && Array.isArray(data.conflicts) && data.conflicts.length) {
      const summary = data.conflicts.map((item) => `- ${item.content || ""}`).join("\n");
      if (
        await confirmAction({
          title: "替换冲突记忆？",
          message: `这条记忆可能和已有记忆冲突，是否替换？\n\n${summary}`,
          okText: "替换",
          danger: true,
        })
      ) {
        return saveMemorySuggestion(suggestion, data.conflicts.map((item) => item.id).filter(Boolean));
      }
      return false;
    }
    if (!response.ok) {
      throw new Error(data.error || `保存记忆失败：${response.status}`);
    }
    showToast("已保存长期记忆");
    return true;
  } catch (error) {
    showToast(error.message || "保存记忆失败");
    return false;
  }
}

function openDiagnosticsPanelForMessage(messageId) {
  const message = state.messages.find((item) => item.id === messageId);
  if (!message) return;
  openDiagnosticsPanel(message);
}

function openDiagnosticsPanel(message) {
  if (!diagnosticsPanel || !diagnosticsPanelList) return;
  closeHistory();
  closeSettings();
  closeSeekPanel();
  closeSearchPanel();
  closeFilePreview();
  closeMemoryPanel();
  closeActivityPanel();
  renderDiagnosticsPanel(message);
  diagnosticsPanel.classList.add("open");
  diagnosticsPanel.setAttribute("aria-hidden", "false");
  setBackdropVisible(true);
  activateFocusTrap(diagnosticsPanel);
}

function closeDiagnosticsPanel() {
  if (!diagnosticsPanel) return;
  diagnosticsPanel.classList.remove("open");
  diagnosticsPanel.setAttribute("aria-hidden", "true");
  deactivateFocusTrap(diagnosticsPanel);
  syncBackdrop();
}

function renderDiagnosticsPanel(message) {
  if (!diagnosticsPanelList) return;
  diagnosticsPanelList.replaceChildren();

  const diagnostics = message.diagnostics && typeof message.diagnostics === "object" ? message.diagnostics : {};
  const usage = message.usage && typeof message.usage === "object" ? message.usage : {};
  const agentCache = diagnostics.agentCache && typeof diagnostics.agentCache === "object" ? diagnostics.agentCache : null;
  const rows = [
    ["请求消息数", diagnostics.requestMessageCount],
    ["压缩摘要字符", diagnostics.contextSummaryChars],
    ["摘要代数", diagnostics.contextSummaryGeneration],
    ["已压缩消息数", diagnostics.contextSummaryMessageCount],
    ["本轮新增压缩消息数", diagnostics.contextCompressionDeltaCount],
    ["长期记忆", diagnostics.memoryEnabled === false ? "关闭" : `开启 · 命中 ${numberOrZero(diagnostics.memoryHitCount)} 条`],
    ["附件数量", diagnostics.attachmentCount],
    ["搜索轮数", diagnostics.searchRoundCount ?? searchRounds(message.search).length],
    ["搜索来源数", diagnostics.searchResultCount ?? searchResults(message.search).length],
    ["搜索缓存", message.search?.cached ? "是" : "否"],
    ["Prompt tokens", usage.prompt_tokens ?? usage.promptTokens],
    ["Completion tokens", usage.completion_tokens ?? usage.completionTokens],
    ["Total tokens", usage.total_tokens ?? usage.totalTokens],
    ["Cache hit tokens", diagnostics.cacheHitTokens ?? usage.prompt_cache_hit_tokens ?? usage.promptCacheHitTokens],
    ["Cache miss tokens", diagnostics.cacheMissTokens ?? usage.prompt_cache_miss_tokens ?? usage.promptCacheMissTokens],
    ["Cache hit rate", diagnostics.cacheHitRate === undefined ? undefined : `${diagnostics.cacheHitRate}%`],
    ["Agent 缓存总 tokens", formatAgentCacheTotal(agentCache)],
    ["Agent 缓存命中 tokens", agentCache?.hitTokens],
    ["Agent 缓存未命中 tokens", agentCache?.missTokens],
    ["Agent 缓存命中率", formatAgentCacheRate(agentCache)],
    ["各 Agent 缓存明细", formatAgentCacheByAgent(agentCache?.byAgent)],
  ];

  for (const [label, value] of rows) {
    if (value === undefined || value === null || value === "") continue;
    const row = document.createElement("div");
    row.className = "diagnostics-row";
    if (String(value).includes("\n")) {
      row.classList.add("is-multiline");
    }
    const key = document.createElement("span");
    key.textContent = label;
    const val = document.createElement("strong");
    val.textContent = String(value);
    row.append(key, val);
    diagnosticsPanelList.append(row);
  }

  if (!diagnosticsPanelList.children.length) {
    const empty = document.createElement("p");
    empty.className = "panel-empty";
    empty.textContent = "这条回复暂无诊断信息。";
    diagnosticsPanelList.append(empty);
  }
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function formatAgentCacheTotal(agentCache) {
  if (!agentCache || typeof agentCache !== "object") return undefined;
  if (agentCache.hasData === false || agentCache.hitRate === null) return "无数据";
  return agentCache.totalTokens ?? numberOrZero(agentCache.hitTokens) + numberOrZero(agentCache.missTokens);
}

function formatAgentCacheRate(agentCache) {
  if (!agentCache || typeof agentCache !== "object") return undefined;
  if (agentCache.hasData === false || agentCache.hitRate === null) return "无数据";
  return `${numberOrZero(agentCache.hitRate)}%`;
}

function formatAgentCacheByAgent(byAgent) {
  if (!byAgent || typeof byAgent !== "object") return undefined;
  const labels = {
    researcher: "资料",
    coder: "代码",
    reasoner: "推理",
    critic: "审查",
    synthesizer: "综合",
  };
  const items = Object.entries(byAgent)
    .map(([key, value]) => {
      if (!value || typeof value !== "object") return "";
      const hit = numberOrZero(value.hitTokens);
      const miss = numberOrZero(value.missTokens);
      if (value.hasData === false || value.hitRate === null || hit + miss === 0) {
        return `${labels[key] || key} 无数据`;
      }
      const rate = value.hitRate === undefined ? Math.round((hit / (hit + miss)) * 1000) / 10 : numberOrZero(value.hitRate);
      return `${labels[key] || key} ${rate}% · hit ${hit} / miss ${miss}`;
    })
    .filter(Boolean);
  return items.length ? items.join("\n") : undefined;
}

async function onSubmit(event) {
  event.preventDefault();
  if (state.busy) return;
  if (state.offlineMode) {
    showToast(state.authRequired ? "本地访问令牌已失效，请用启动输出的 token 链接重新打开。" : "当前处于离线模式，只能查看历史，不能发送新消息。");
    return;
  }

  const content = promptInput.value.trim();
  const attachments = state.pendingAttachments.slice();
  if (state.uploadingAttachments.length) {
    const hasActiveUpload = state.uploadingAttachments.some((item) => item.status !== "error");
    showToast(hasActiveUpload ? "文件还在上传或识别，请稍等" : "请先移除识别失败的文件");
    return;
  }
  if (!content && !attachments.length) return;

  const apiKey = apiKeyInput.value.trim();
  if (!apiKey && !state.hasServerKey) {
    showToast("请先在设置里填写 DeepSeek API Key");
    openSettings();
    return;
  }

  const seekSnapshot = activeSeekSnapshot();
  const seekReferenceAttachments = normalizeSeekReferenceAttachments(seekSnapshot.seekReferenceAttachments || []);
  const projectSnapshot = activeProjectSnapshot();
  const projectAttachments = normalizeProjectAttachments(projectSnapshot.projectAttachments || []);
  if ((attachments.length || seekReferenceAttachments.length || projectAttachments.length) && !(await confirmAttachmentSendIfNeeded())) {
    return;
  }

  const userContent = quoteAwareContent(content || `请识别附件：${attachments.map((item) => item.name).join("、")}`, state.quoteDraft);
  const reminderDraft = detectReminderFromText(content);
  const userMessage = { id: createId(), role: "user", content: userContent, attachments, ...seekSnapshot, ...projectSnapshot, createdAt: Date.now() };
  markMessageFresh(userMessage);
  state.messages.push(userMessage);
  state.pendingAttachments = [];
  state.uploadingAttachments = [];
  state.quoteDraft = null;
  clearSelectionQuoteState();
  promptInput.value = "";
  renderAttachmentList();
  renderQuotePreview();
  resizeComposer();
  clearDraft();
  if (reminderDraft) {
    scheduleReminder(reminderDraft);
  }

  setBusy(true);
  const assistantMessage = {
    id: createId(),
    role: "assistant",
    content: "",
    reasoning: "",
    systemNotes: [],
    memorySuggestions: [],
    model: state.model,
    thinking: state.thinkingEnabled,
    reasoningEffort: state.reasoningEffort,
    agentMode: state.agentMode,
    ...seekSnapshot,
    ...projectSnapshot,
    createdAt: Date.now(),
    streaming: true,
    search: null,
    timeline: [],
  };
  markMessageFresh(assistantMessage);
  state.messages.push(assistantMessage);
  persistMessages();
  render();

  prepareAssistantRequest(assistantMessage, false);
  try {
    const requestMessages = buildApiMessages(state.messages);
    const compressedParts = await buildCompressedRequestParts(apiKey, requestMessages, assistantMessage);

    const requestPayload = requestPayloadFromParts(apiKey, assistantMessage, compressedParts, {
      model: state.model,
      thinkingEnabled: state.thinkingEnabled,
      reasoningEffort: state.reasoningEffort,
    });
    if (state.agentMode) {
      await startAgentRunForMessage(assistantMessage, requestPayload);
    } else {
      await streamChatPayload(assistantMessage, requestPayload);
    }
    assistantMessage.completedAt = Date.now();
    assistantMessage.streaming = false;
    settleStuckSearchSteps(assistantMessage);
    ensureAssistantHasVisibleContent(assistantMessage);
    clearAssistantRequestMarkers(assistantMessage);
    updateStreamingMessage(assistantMessage);
    persistMessages();
  } catch (error) {
    if (isAbortError(error)) {
      markAssistantInterrupted(assistantMessage);
      return;
    }
    assistantMessage.completedAt = Date.now();
    assistantMessage.streaming = false;
    assistantMessage.error = true;
    settleStuckSearchSteps(assistantMessage);
    assistantMessage.content = `调用失败：${error.message}`;
    clearAssistantRequestMarkers(assistantMessage);
    updateStreamingMessage(assistantMessage);
    persistMessages();
  } finally {
    finishAssistantRequest(assistantMessage);
    setBusy(false);
  }
}

function requestPayloadFromParts(apiKey, assistantMessage, compressedParts, overrides = {}) {
  const searchEnabled = shouldRequestSearch();
  return {
    apiKey,
    model: overrides.model || assistantMessage.model || state.model,
    thinkingEnabled: Boolean(overrides.thinkingEnabled ?? assistantMessage.thinking ?? state.thinkingEnabled),
    reasoningEffort: normalizeReasoningEffort(overrides.reasoningEffort || assistantMessage.reasoningEffort || state.reasoningEffort),
    temperature: state.temperature,
    stream: true,
    agentMode: Boolean(assistantMessage.agentMode || state.agentMode),
    searchEnabled,
    searchMode: state.searchMode,
    tavilyApiKey: tavilyApiKeyForSearch(searchEnabled),
    memoryEnabled: state.memoryEnabled,
    memoryScope: memoryScopeForRequest(assistantMessage, compressedParts.messages),
    systemPrompt: buildSystemPrompt(assistantMessage),
    contextSummary: compressedParts.contextSummary,
    contextSummaryGeneration: compressedParts.contextSummaryGeneration,
    contextSummaryMessageCount: compressedParts.contextSummaryMessageCount,
    contextCompressionDeltaCount: compressedParts.contextCompressionDeltaCount,
    messages: compressedParts.messages,
  };
}

async function streamChatPayload(assistantMessage, requestPayload) {
  const response = await apiFetch("/api/chat", {
    method: "POST",
    signal: state.abortController?.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestPayload),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(apiErrorMessage(response, data, `请求失败：${response.status}`));
  }

  await readChatStream(response, {
    waitUntilResumed: waitUntilOutputResumed,
    onEvent: (event) => handleStreamEvent(event, assistantMessage),
  });
}

async function startAgentRunForMessage(assistantMessage, requestPayload) {
  const options = agentRunRequestOptions();
  const response = await apiFetch("/api/agent-runs", {
    method: "POST",
    signal: state.abortController?.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      payload: requestPayload,
      confirmPlan: options.confirmPlan,
      agentPreset: options.agentPreset,
      conversationId: state.currentConversationId || "",
      messageId: assistantMessage.id,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(apiErrorMessage(response, data, `创建 Agent Run 失败：${response.status}`));
  }
  const run = data.run || {};
  assistantMessage.agentRunId = data.runId || run.runId || "";
  assistantMessage.agentRunStatus = run.status || "created";
  assistantMessage.agentRunLastEventIndex = -1;
  assistantMessage.agentPreset = options.agentPreset;
  updateStreamingMessage(assistantMessage);
  persistMessages();
  await attachAgentRunStream(assistantMessage);
}

async function resumePendingAgentRuns() {
  if (state.busy || state.offlineMode) return;
  const message = [...state.messages].reverse().find((item) => {
    if (!item?.agentRunId) return false;
    return ["created", "planning", "running"].includes(item.agentRunStatus);
  });
  if (!message) return;
  setBusy(true);
  message.streaming = true;
  prepareAssistantRequest(message, false);
  updateStreamingMessage(message);
  try {
    await attachAgentRunStream(message);
    completeAgentRunMessage(message);
  } catch (error) {
    if (isAbortError(error)) {
      markAssistantInterrupted(message);
      return;
    }
    message.streaming = false;
    message.error = true;
    message.content = `恢复 Agent Run 失败：${error.message}`;
    updateStreamingMessage(message);
    persistMessages();
  } finally {
    finishAssistantRequest(message);
    setBusy(false);
  }
}

// 这些状态表示 Agent Run 还没到终态（与 resumePendingAgentRuns 一致）。流若在此之前结束需重连续读。
function agentRunStreamIncomplete(message) {
  return ["created", "planning", "running"].includes(String(message?.agentRunStatus || ""));
}

async function attachAgentRunStream(assistantMessage) {
  const runId = String(assistantMessage.agentRunId || "");
  if (!runId) throw new Error("缺少 Agent Run ID");
  // 单次读流可能在 run 到达终态前结束（慢任务 / 网络抖动 / 连接被中间层切断）。若就此收手，会把
  // 后端其实已经产出的最终答案丢掉，前端反而显示"综合阶段没有返回正文"。这里循环带 ?after=lastIndex
  // 重连续读，直到 run 真正到终态；服务端 stream_agent_run 会一直挂到终态才关，所以正常情况下只连一两次。
  let stalledReconnects = 0;
  while (true) {
    const before = Number.isFinite(Number(assistantMessage.agentRunLastEventIndex))
      ? Number(assistantMessage.agentRunLastEventIndex)
      : -1;
    const response = await apiFetch(`/api/agent-runs/${encodeURIComponent(runId)}/stream?after=${before}`, {
      method: "GET",
      signal: state.abortController?.signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(apiErrorMessage(response, data, `连接 Agent Run 失败：${response.status}`));
    }
    await readChatStream(response, {
      waitUntilResumed: waitUntilOutputResumed,
      onEvent: (event) => handleStreamEvent(event, assistantMessage),
    });
    // 流结束。run 已到终态（done / awaiting_plan / failed …）→ 收工。
    if (!agentRunStreamIncomplete(assistantMessage)) return;
    // 未到终态却断流：重连。读到新事件就清零退避计数；连续无进展则退避 + 设上限，避免忙循环。
    const advanced = Number(assistantMessage.agentRunLastEventIndex) > before;
    stalledReconnects = advanced ? 0 : stalledReconnects + 1;
    if (stalledReconnects > AGENT_STREAM_MAX_STALLED_RECONNECTS) {
      throw new Error("Agent Run 流多次中断，未能读到最终结果");
    }
    if (!advanced) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(2000, 400 * stalledReconnects)));
    }
  }
}

async function continueGeneration(messageId) {
  if (state.busy) return;
  if (state.offlineMode) {
    showToast("当前处于离线模式，不能继续生成。");
    return;
  }
  const assistantMessage = state.messages.find((message) => message.id === messageId && message.role === "assistant");
  if (!assistantMessage || !assistantMessage.interrupted) return;

  const apiKey = apiKeyInput.value.trim();
  if (!apiKey && !state.hasServerKey) {
    showToast("请先在设置里填写 DeepSeek API Key");
    openSettings();
    return;
  }

  assistantMessage.streaming = true;
  assistantMessage.interrupted = false;
  assistantMessage.error = false;
  assistantMessage.reasoningEffort = normalizeReasoningEffort(assistantMessage.reasoningEffort || state.reasoningEffort);
  delete assistantMessage.completedAt;
  setBusy(true);
  prepareAssistantRequest(assistantMessage, true);
  updateStreamingMessage(assistantMessage);

  try {
    const requestMessages = messagesForContinuation(assistantMessage);
    const compressedParts = await buildCompressedRequestParts(apiKey, requestMessages, assistantMessage);

    const response = await apiFetch("/api/chat", {
      method: "POST",
      signal: state.abortController?.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey,
        model: assistantMessage.model || state.model,
        thinkingEnabled: Boolean(assistantMessage.thinking ?? state.thinkingEnabled),
        reasoningEffort: assistantMessage.reasoningEffort,
        temperature: state.temperature,
        stream: true,
        agentMode: state.agentMode,
        searchEnabled: shouldRequestSearch() && !hasSearchResults(assistantMessage.search),
        searchMode: state.searchMode,
        tavilyApiKey: tavilyApiKeyForSearch(shouldRequestSearch() && !hasSearchResults(assistantMessage.search)),
        memoryEnabled: state.memoryEnabled,
        memoryScope: memoryScopeForRequest(assistantMessage, compressedParts.messages),
        searchContext: searchContextForPayload(assistantMessage.search),
        continuationContext: continuationContextFor(assistantMessage),
        systemPrompt: buildSystemPrompt(assistantMessage),
        contextSummary: compressedParts.contextSummary,
        contextSummaryGeneration: compressedParts.contextSummaryGeneration,
        contextSummaryMessageCount: compressedParts.contextSummaryMessageCount,
        contextCompressionDeltaCount: compressedParts.contextCompressionDeltaCount,
        messages: compressedParts.messages,
      }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `请求失败：${response.status}`);
    }

    await readChatStream(response, {
      waitUntilResumed: waitUntilOutputResumed,
      onEvent: (event) => handleStreamEvent(event, assistantMessage),
    });
    assistantMessage.completedAt = Date.now();
    assistantMessage.streaming = false;
    assistantMessage.interrupted = false;
    settleStuckSearchSteps(assistantMessage);
    ensureAssistantHasVisibleContent(assistantMessage);
    clearAssistantRequestMarkers(assistantMessage);
    updateStreamingMessage(assistantMessage);
    persistMessages();
  } catch (error) {
    if (isAbortError(error)) {
      markAssistantInterrupted(assistantMessage);
      return;
    }
    assistantMessage.completedAt = Date.now();
    assistantMessage.streaming = false;
    assistantMessage.error = true;
    assistantMessage.interrupted = false;
    settleStuckSearchSteps(assistantMessage);
    assistantMessage.content = `调用失败：${error.message}`;
    clearAssistantRequestMarkers(assistantMessage);
    updateStreamingMessage(assistantMessage);
    persistMessages();
  } finally {
    finishAssistantRequest(assistantMessage);
    setBusy(false);
  }
}

async function regenerateMessage(messageId) {
  if (state.busy) return;
  if (state.offlineMode) {
    showToast("当前处于离线模式，不能重新生成。");
    return;
  }

  const targetIndex = state.messages.findIndex((message) => message.id === messageId && message.role === "assistant");
  if (targetIndex <= 0) return;

  const assistantMessage = state.messages[targetIndex];
  const requestMessages = messagesBeforeAssistant(assistantMessage);
  if (!requestMessages.some((message) => message.role === "user")) {
    showToast("没有可重新生成的用户问题");
    return;
  }

  const apiKey = apiKeyInput.value.trim();
  if (!apiKey && !state.hasServerKey) {
    showToast("请先在设置里填写 DeepSeek API Key");
    openSettings();
    return;
  }

  state.messages = state.messages.slice(0, targetIndex + 1);
  clearSelectionQuoteState();
  clearContextSummary();
  assistantMessage.content = "";
  assistantMessage.reasoning = "";
  assistantMessage.systemNotes = [];
  assistantMessage.memorySuggestions = [];
  assistantMessage.search = null;
  assistantMessage.timeline = [];
  assistantMessage.usage = {};
  assistantMessage.diagnostics = null;
  assistantMessage.error = false;
  assistantMessage.interrupted = false;
  assistantMessage.streaming = true;
  assistantMessage.model = assistantMessage.model || state.model;
  assistantMessage.thinking = Boolean(assistantMessage.thinking ?? state.thinkingEnabled);
  assistantMessage.reasoningEffort = normalizeReasoningEffort(assistantMessage.reasoningEffort || state.reasoningEffort);
  assistantMessage.agentMode = Boolean(state.agentMode);
  delete assistantMessage.completedAt;
  delete assistantMessage.reasoningEndedAt;

  setBusy(true);
  prepareAssistantRequest(assistantMessage, false);
  persistMessages();
  render();

  try {
    const compressedParts = await buildCompressedRequestParts(apiKey, requestMessages, assistantMessage);

    const response = await apiFetch("/api/chat", {
      method: "POST",
      signal: state.abortController?.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey,
        model: assistantMessage.model,
        thinkingEnabled: assistantMessage.thinking,
        reasoningEffort: assistantMessage.reasoningEffort,
        temperature: state.temperature,
        stream: true,
        agentMode: state.agentMode,
        searchEnabled: shouldRequestSearch(),
        searchMode: state.searchMode,
        tavilyApiKey: tavilyApiKeyForSearch(shouldRequestSearch()),
        memoryEnabled: state.memoryEnabled,
        memoryScope: memoryScopeForRequest(assistantMessage, compressedParts.messages),
        systemPrompt: buildSystemPrompt(assistantMessage),
        contextSummary: compressedParts.contextSummary,
        contextSummaryGeneration: compressedParts.contextSummaryGeneration,
        contextSummaryMessageCount: compressedParts.contextSummaryMessageCount,
        contextCompressionDeltaCount: compressedParts.contextCompressionDeltaCount,
        messages: compressedParts.messages,
      }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `请求失败：${response.status}`);
    }

    await readChatStream(response, {
      waitUntilResumed: waitUntilOutputResumed,
      onEvent: (event) => handleStreamEvent(event, assistantMessage),
    });
    assistantMessage.completedAt = Date.now();
    assistantMessage.streaming = false;
    assistantMessage.interrupted = false;
    settleStuckSearchSteps(assistantMessage);
    ensureAssistantHasVisibleContent(assistantMessage);
    clearAssistantRequestMarkers(assistantMessage);
    updateStreamingMessage(assistantMessage);
    persistMessages();
  } catch (error) {
    if (isAbortError(error)) {
      markAssistantInterrupted(assistantMessage);
      return;
    }
    assistantMessage.completedAt = Date.now();
    assistantMessage.streaming = false;
    assistantMessage.error = true;
    assistantMessage.interrupted = false;
    settleStuckSearchSteps(assistantMessage);
    assistantMessage.content = `调用失败：${error.message}`;
    clearAssistantRequestMarkers(assistantMessage);
    updateStreamingMessage(assistantMessage);
    persistMessages();
  } finally {
    finishAssistantRequest(assistantMessage);
    setBusy(false);
  }
}

async function submitMessageEdit(messageId, content) {
  if (state.busy) return;
  if (state.offlineMode) {
    showToast("当前处于离线模式，不能发送修改后的消息。");
    return;
  }

  const userIndex = state.messages.findIndex((message) => message.id === messageId && message.role === "user");
  if (userIndex < 0) return;

  const userMessage = state.messages[userIndex];
  const attachments = Array.isArray(userMessage.attachments) ? userMessage.attachments : [];
  const nextContent = String(content || "").trim();
  if (!nextContent && !attachments.length) {
    showToast("请输入修改后的内容");
    return;
  }

  const apiKey = apiKeyInput.value.trim();
  if (!apiKey && !state.hasServerKey) {
    showToast("请先在设置里填写 DeepSeek API Key");
    openSettings();
    return;
  }
  if (
    (attachments.length ||
      normalizeSeekReferenceAttachments(userMessage.seekReferenceAttachments || []).length ||
      normalizeProjectAttachments(userMessage.projectAttachments || []).length) &&
    !(await confirmAttachmentSendIfNeeded())
  ) {
    return;
  }

  userMessage.content = nextContent || `请识别附件：${attachments.map((item) => item.name).join("、")}`;
  const seekSnapshot = seekSnapshotFromSeek(resolveSeekContext(userMessage) || activeSeek());
  Object.assign(userMessage, seekSnapshot);
  Object.assign(userMessage, projectSnapshotFromMessage(userMessage) || activeProjectSnapshot());
  userMessage.updatedAt = Date.now();
  state.messages = state.messages.slice(0, userIndex + 1);
  state.editingMessageId = null;
  clearSelectionQuoteState();
  clearContextSummary();

  const assistantMessage = {
    id: createId(),
    role: "assistant",
    content: "",
    reasoning: "",
    systemNotes: [],
    memorySuggestions: [],
    model: state.model,
    thinking: state.thinkingEnabled,
    reasoningEffort: state.reasoningEffort,
    agentMode: state.agentMode,
    ...seekSnapshot,
    ...(projectSnapshotFromMessage(userMessage) || {}),
    createdAt: Date.now(),
    streaming: true,
    search: null,
    timeline: [],
  };
  markMessageFresh(assistantMessage);
  state.messages.push(assistantMessage);

  setBusy(true);
  prepareAssistantRequest(assistantMessage, false);
  persistMessages();
  render();

  try {
    const requestMessages = buildApiMessages(state.messages);
    const compressedParts = await buildCompressedRequestParts(apiKey, requestMessages, assistantMessage);

    const response = await apiFetch("/api/chat", {
      method: "POST",
      signal: state.abortController?.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey,
        model: state.model,
        thinkingEnabled: state.thinkingEnabled,
        reasoningEffort: state.reasoningEffort,
        temperature: state.temperature,
        stream: true,
        agentMode: state.agentMode,
        searchEnabled: shouldRequestSearch(),
        searchMode: state.searchMode,
        tavilyApiKey: tavilyApiKeyForSearch(shouldRequestSearch()),
        memoryEnabled: state.memoryEnabled,
        memoryScope: memoryScopeForRequest(assistantMessage, compressedParts.messages),
        systemPrompt: buildSystemPrompt(assistantMessage),
        contextSummary: compressedParts.contextSummary,
        contextSummaryGeneration: compressedParts.contextSummaryGeneration,
        contextSummaryMessageCount: compressedParts.contextSummaryMessageCount,
        contextCompressionDeltaCount: compressedParts.contextCompressionDeltaCount,
        messages: compressedParts.messages,
      }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `请求失败：${response.status}`);
    }

    await readChatStream(response, {
      waitUntilResumed: waitUntilOutputResumed,
      onEvent: (event) => handleStreamEvent(event, assistantMessage),
    });
    assistantMessage.completedAt = Date.now();
    assistantMessage.streaming = false;
    settleStuckSearchSteps(assistantMessage);
    ensureAssistantHasVisibleContent(assistantMessage);
    clearAssistantRequestMarkers(assistantMessage);
    updateStreamingMessage(assistantMessage);
    persistMessages();
  } catch (error) {
    if (isAbortError(error)) {
      markAssistantInterrupted(assistantMessage);
      return;
    }
    assistantMessage.completedAt = Date.now();
    assistantMessage.streaming = false;
    assistantMessage.error = true;
    settleStuckSearchSteps(assistantMessage);
    assistantMessage.content = `调用失败：${error.message}`;
    clearAssistantRequestMarkers(assistantMessage);
    updateStreamingMessage(assistantMessage);
    persistMessages();
  } finally {
    finishAssistantRequest(assistantMessage);
    setBusy(false);
  }
}

function startMessageEdit(messageId) {
  if (state.busy) return;
  const message = state.messages.find((item) => item.id === messageId && item.role === "user");
  if (!message) return;
  state.editingMessageId = message.id;
  render();
  requestAnimationFrame(() => scrollMessageIntoView(message.id));
}

function editPreviousUserMessage() {
  const message = [...state.messages].reverse().find((item) => item.role === "user");
  if (!message) return;
  startMessageEdit(message.id);
}

function cancelMessageEdit() {
  if (!state.editingMessageId) return;
  const messageId = state.editingMessageId;
  state.editingMessageId = null;
  render();
  requestAnimationFrame(() => scrollMessageIntoView(messageId));
}

function resizeMessageEditTextarea(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
}

function scrollMessageIntoView(messageId, { block = "center", behavior = "auto" } = {}) {
  chatLog.querySelector(`[data-message-id="${messageId}"]`)?.scrollIntoView({
    block,
    behavior,
  });
}

function prepareAssistantRequest(message, continuing) {
  message._continuing = Boolean(continuing);
  message._requestContentStart = String(message.content || "").length;
  message._requestReasoningStart = String(message.reasoning || "").length;
  state.abortController = new AbortController();
  state.interruptRequested = false;
  state.activeAssistantId = message.id;
  window.clearTimeout(state.chatRequestTimer);
  const requestTimeoutMs = (message.agentMode || state.agentMode) ? agentChatRequestTimeoutMs : chatRequestTimeoutMs;
  state.chatRequestTimer = window.setTimeout(() => {
    if (state.activeAssistantId !== message.id || !state.abortController) return;
    state.interruptRequested = true;
    state.abortController.abort();
  }, requestTimeoutMs);
}

function finishAssistantRequest(message) {
  clearAssistantRequestMarkers(message);
  if (state.activeAssistantId === message.id) {
    window.clearTimeout(state.chatRequestTimer);
    state.chatRequestTimer = 0;
    state.abortController = null;
    state.interruptRequested = false;
    state.activeAssistantId = null;
  }
}

function clearAssistantRequestMarkers(message) {
  delete message._continuing;
  delete message._requestContentStart;
  delete message._requestReasoningStart;
}

function interruptGeneration() {
  if (!state.busy) return;
  state.interruptRequested = true;
  setOutputPaused(false);
  state.abortController?.abort();
}

function isAbortError(error) {
  return state.interruptRequested || error?.name === "AbortError";
}

function markAssistantInterrupted(message) {
  message.completedAt = Date.now();
  message.streaming = false;
  message.interrupted = true;
  message.error = false;
  settleStuckSearchSteps(message, "搜索已中断");
  clearAssistantRequestMarkers(message);
  updateStreamingMessage(message);
  persistMessages();
}

function messagesForContinuation(assistantMessage) {
  const index = state.messages.findIndex((message) => message.id === assistantMessage.id);
  const previousMessages = buildApiMessages(index >= 0 ? state.messages.slice(0, index) : state.messages)
    .filter((message) => message.content);

  const partialContent = String(assistantMessage.content || "").trim();
  if (partialContent) {
    previousMessages.push({ role: "assistant", content: partialContent });
  }

  previousMessages.push({ role: "user", content: continuationPromptFor(assistantMessage) });
  return previousMessages;
}

function messagesBeforeAssistant(assistantMessage) {
  const index = state.messages.findIndex((message) => message.id === assistantMessage.id);
  return buildApiMessages(index >= 0 ? state.messages.slice(0, index) : state.messages)
    .filter((message) => message.content);
}

function continuationPromptFor(message) {
  if (String(message.content || "").trim()) {
    return "请从上一条回答被中断的位置继续生成。不要重复已经输出过的内容，直接接着往下写。";
  }
  return "请继续完成刚才被中断的回答。上一轮可能停在思考、搜索或正文生成阶段，请接着完成最终答复，不要解释中断。";
}

function continuationContextFor(message) {
  const parts = [
    "这是一次继续生成请求。请保持原回答的语言、结构和上下文，从中断处继续；不要重新开始，不要重复已经输出过的正文。",
  ];

  if (message.reasoning) {
    parts.push(`上一次中断前已有推理过程（仅供衔接，不要原样复述给用户）：\n${tailForContinuation(message.reasoning, 9000)}`);
  }

  if (message.content) {
    parts.push(`上一次已经输出给用户的正文如下，请从最后一句之后继续：\n${tailForContinuation(message.content, 9000)}`);
  }

  return parts.join("\n\n");
}

function hasSearchResults(search) {
  return searchResults(search).length > 0;
}

function searchContextForPayload(search) {
  const results = searchResults(search);
  if (!results.length) return "";

  const lines = [
    "You may continue using these web search results.",
    `搜索问题: ${search?.query || ""}`,
    "要求: 继续生成时优先复用这些来源；不要为了继续生成而重复搜索；涉及来源时使用下面的精确 [^Wn] 标记。",
    "",
    "搜索来源:",
  ];

  for (const [index, result] of results.entries()) {
    const citationId = result.citation_id || `W${index + 1}`;
    lines.push(`[^${citationId}] ${result.title || `Web source ${index + 1}`}`);
    lines.push(`URL: ${result.url || ""}`);
    if (result.content) lines.push(`摘要: ${result.content}`);
  }

  return lines.join("\n");
}

function markMessageFresh(message) {
  if (message?.id) {
    freshMessageIds.add(message.id);
  }
}

function resetMotionState() {
  freshMessageIds.clear();
  pendingStreamingMessageIds.clear();
  if (streamingRenderFrame) {
    cancelAnimationFrame(streamingRenderFrame);
    streamingRenderFrame = 0;
  }
}

function decorateFreshMessage(node, messageId) {
  if (!freshMessageIds.has(messageId)) return;
  node.dataset.fresh = "true";
  const clear = () => {
    delete node.dataset.fresh;
    freshMessageIds.delete(messageId);
  };
  node.addEventListener("animationend", clear, { once: true });
  window.setTimeout(clear, 360);
}

function render() {
  chatLog.replaceChildren();
  appShell.classList.toggle("is-empty", state.messages.length === 0);
  renderActiveSeekChip();
  renderActiveProjectChip();

  if (state.messages.length === 0) {
    renderConversationPeek();
    updateJumpLatestButton();
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const message of state.messages) {
    fragment.append(renderMessage(message));
  }
  chatLog.append(fragment);
  renderConversationPeek();
  scrollToLatest({ behavior: "auto" });
  requestAnimationFrame(updateConversationPeekActive);
}

function renderConversationPeek() {
  if (!conversationPeek) return;

  const userMessages = state.messages.filter((message) => message.role === "user");
  conversationPeek.replaceChildren();
  conversationPeek.hidden = userMessages.length < 2;
  if (conversationPeek.hidden) return;

  const list = document.createElement("div");
  list.className = "conversation-peek-list";

  for (const message of userMessages) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "conversation-peek-item";
    button.dataset.peekMessage = message.id;
    button.title = messagePreview(message);

    const text = document.createElement("span");
    text.className = "conversation-peek-text";
    text.textContent = messagePreview(message);

    const marker = document.createElement("span");
    marker.className = "conversation-peek-marker";
    marker.setAttribute("aria-hidden", "true");

    button.append(text, marker);
    list.append(button);
  }

  conversationPeek.append(list);
  updateConversationPeekActive();
}

function updateConversationPeekActive() {
  if (!conversationPeek || conversationPeek.hidden) return;
  if (state.peekClickLockUntil && Date.now() < state.peekClickLockUntil) return;

  const activeId = activeConversationMessageId();
  setConversationPeekActive(activeId);
}

function setConversationPeekActive(activeId) {
  if (!conversationPeek) return;
  for (const button of conversationPeek.querySelectorAll(".conversation-peek-item")) {
    const isActive = button.dataset.peekMessage === activeId;
    button.classList.toggle("active", isActive);
    if (isActive) {
      button.setAttribute("aria-current", "true");
    } else {
      button.removeAttribute("aria-current");
    }
  }
}

function activeConversationMessageId() {
  const userNodes = Array.from(chatLog.querySelectorAll(".message.user[data-message-id]"));
  if (!userNodes.length) return "";
  if (chatLog.scrollTop + chatLog.clientHeight >= chatLog.scrollHeight - 4) {
    return userNodes[userNodes.length - 1].dataset.messageId || "";
  }

  const chatRect = chatLog.getBoundingClientRect();
  const threshold = chatRect.top + Math.min(chatLog.clientHeight * 0.45, 360);
  let activeId = userNodes[0].dataset.messageId || "";

  for (const node of userNodes) {
    if (node.getBoundingClientRect().top <= threshold) {
      activeId = node.dataset.messageId || activeId;
    }
  }

  return activeId;
}

function messagePreview(message) {
  const text = String(message.content || "").replace(/\s+/g, " ").trim();
  if (text) return text.length > 18 ? `${text.slice(0, 18)}...` : text;

  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const attachmentNames = attachments.map((item) => item.name).filter(Boolean);
  if (attachmentNames.length) {
    const label = `附件：${attachmentNames.join("、")}`;
    return label.length > 18 ? `${label.slice(0, 18)}...` : label;
  }

  return "未命名问题";
}

function renderMessage(message) {
  if (!message.id) message.id = createId();

  const wrapper = document.createElement("article");
  wrapper.className = `message ${message.role}${message.error ? " error" : ""}`;
  wrapper.dataset.messageId = message.id;
  decorateFreshMessage(wrapper, message.id);

  if (message.role === "user" && state.editingMessageId === message.id) {
    wrapper.classList.add("editing");
    wrapper.append(renderUserEditForm(message));
    return wrapper;
  }

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const meta = document.createElement("div");
  meta.className = "meta";

  const label = document.createElement("span");
  label.textContent = message.role === "user" ? "你" : responseLabel(message);

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = message.role === "user" ? "message-icon-action" : "copy-button";
  if (message.role === "user") {
    copyButton.title = "复制";
    copyButton.setAttribute("aria-label", "复制");
    copyButton.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="9" y="9" width="11" height="11" rx="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
    `;
  } else {
    copyButton.textContent = "复制";
  }
  copyButton.addEventListener("click", async () => {
    const copied = await copyText(message.content || "");
    showToast(copied ? "已复制" : "复制失败，请长按文本手动复制");
  });

  const metaActions = document.createElement("div");
  metaActions.className = "message-meta-actions";
  metaActions.append(copyButton);
  if (canEditUserMessage(message)) {
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "message-icon-action";
    editButton.dataset.editMessage = message.id;
    editButton.title = "修改";
    editButton.setAttribute("aria-label", "修改");
    editButton.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 20h9"></path>
        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
      </svg>
    `;
    metaActions.append(editButton);
  }

  meta.append(label, metaActions);
  bubble.append(meta);

  if (message.attachments?.length) {
    bubble.append(renderMessageAttachments(message.attachments));
  }

  if (messageHasActivity(message)) {
    bubble.append(renderActivityEntry(message));
  }

  if (shouldShowAgentPlanWorkbench(message)) {
    bubble.append(renderAgentPlanWorkbench(message));
  }

  const content = document.createElement("div");
  content.className = "content answer-content";
  content.innerHTML = formatContent(message.content || (message.streaming ? "正在生成回复..." : ""), { streaming: message.streaming });
  hydrateMermaidDiagrams(content);
  bubble.append(content);
  if (message.role === "user") {
    bubble.append(renderUserMobileActions(message));
  }
  const actions = renderAssistantActions(message);
  if (actions) {
    bubble.append(actions);
  }
  wrapper.append(bubble);
  return wrapper;
}

function renderUserMobileActions(message) {
  const actions = document.createElement("div");
  actions.className = "user-mobile-actions";

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "user-mobile-action";
  copy.setAttribute("aria-label", "复制消息");
  copy.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
    <span>复制</span>
  `;
  copy.addEventListener("click", async () => {
    const copied = await copyText(message.content || "");
    showToast(copied ? "已复制" : "复制失败，请长按文本手动复制");
  });
  actions.append(copy);

  if (canEditUserMessage(message)) {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "user-mobile-action";
    edit.dataset.editMessage = message.id;
    edit.setAttribute("aria-label", "修改消息");
    edit.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 20h9"></path>
        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
      </svg>
      <span>修改</span>
    `;
    actions.append(edit);
  }

  return actions;
}

const editableAgentPhases = [
  { id: "researcher", label: "Researcher" },
  { id: "coder", label: "Coder" },
  { id: "reasoner", label: "Reasoner" },
  { id: "critic", label: "Critic" },
];

function shouldShowAgentPlanWorkbench(message) {
  return Boolean(
    message?.role === "assistant" &&
      message.agentRunId &&
      message.agentRunStatus === "awaiting_plan" &&
      Array.isArray(message.agentRunPlan)
  );
}

function renderAgentPlanWorkbench(message) {
  const panel = document.createElement("div");
  panel.className = "agent-plan-workbench";
  panel.dataset.agentPlanWorkbench = message.id || "";

  const header = document.createElement("div");
  header.className = "agent-plan-header";
  const title = document.createElement("strong");
  title.textContent = message.agentAutoPlanLabel || "Agent 执行计划";
  const status = document.createElement("span");
  status.textContent = "等待确认";
  header.append(title, status);
  panel.append(header);

  const presets = document.createElement("div");
  presets.className = "agent-plan-presets";
  for (const [preset, label] of [
    ["full", "完整 4-Agent"],
    ["code", "仅代码分析"],
    ["research", "仅资料检索"],
    ["critic", "仅反驳审查"],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.agentPlanPreset = preset;
    button.dataset.agentPlanMessage = message.id || "";
    button.textContent = label;
    presets.append(button);
  }
  panel.append(presets);

  const list = document.createElement("div");
  list.className = "agent-plan-list";
  const plan = normalizedEditableAgentPlan(message.agentRunPlan);
  for (const [index, item] of plan.entries()) {
    list.append(renderAgentPlanRow(message, item, index, plan.length));
  }
  panel.append(list);

  const actions = document.createElement("div");
  actions.className = "agent-plan-actions";

  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.dataset.agentPlanAdd = message.id || "";
  addButton.textContent = "添加 Agent";

  const confirmButton = document.createElement("button");
  confirmButton.type = "button";
  confirmButton.className = "primary";
  confirmButton.dataset.confirmAgentPlan = message.id || "";
  confirmButton.disabled = state.busy;
  confirmButton.textContent = "确认执行";

  actions.append(addButton, confirmButton);
  panel.append(actions);
  return panel;
}

function renderAgentPlanRow(message, item, index, count) {
  const row = document.createElement("div");
  row.className = "agent-plan-row";

  const select = document.createElement("select");
  select.dataset.agentPlanPhase = String(index);
  select.dataset.agentPlanMessage = message.id || "";
  select.setAttribute("aria-label", "选择 Agent");
  for (const phase of editableAgentPhases) {
    const option = document.createElement("option");
    option.value = phase.id;
    option.textContent = phase.label;
    select.append(option);
  }
  select.value = item.id;

  const task = document.createElement("textarea");
  task.dataset.agentPlanTask = String(index);
  task.dataset.agentPlanMessage = message.id || "";
  task.rows = 2;
  task.maxLength = 500;
  task.value = item.task || "";
  task.setAttribute("aria-label", "Agent 任务");
  task.addEventListener("input", () => resizeMessageEditTextarea(task));
  requestAnimationFrame(() => resizeMessageEditTextarea(task));

  const remove = document.createElement("button");
  remove.type = "button";
  remove.dataset.agentPlanRemove = String(index);
  remove.dataset.agentPlanMessage = message.id || "";
  remove.disabled = count <= 1;
  remove.setAttribute("aria-label", "移除 Agent");
  remove.textContent = "移除";

  row.append(select, task, remove);
  return row;
}

function syncAgentPlanWorkbench(bubble, message) {
  const existing = bubble.querySelector(":scope > .agent-plan-workbench");
  if (!shouldShowAgentPlanWorkbench(message)) {
    existing?.remove();
    return;
  }
  const fresh = renderAgentPlanWorkbench(message);
  if (existing) {
    existing.replaceWith(fresh);
    return;
  }
  const content = bubble.querySelector(":scope > .answer-content");
  if (content) bubble.insertBefore(fresh, content);
  else bubble.append(fresh);
}

function renderAssistantActions(message) {
  if (!canShowAssistantActions(message)) return null;

  const actions = document.createElement("div");
  actions.className = "assistant-actions";

  if (message.error) {
    const retryButton = document.createElement("button");
    retryButton.type = "button";
    retryButton.className = "continue-generation-button retry";
    retryButton.dataset.regenerateMessage = message.id;
    retryButton.disabled = state.busy;
    retryButton.textContent = "重试";
    actions.append(retryButton);
  }

  if (message.interrupted) {
    const continueButton = document.createElement("button");
    continueButton.type = "button";
    continueButton.className = "continue-generation-button";
    continueButton.dataset.continueGeneration = message.id;
    continueButton.disabled = state.busy;
    continueButton.textContent = "继续生成";
    actions.append(continueButton);
  }

  const regenerateButton = document.createElement("button");
  regenerateButton.type = "button";
  regenerateButton.className = "assistant-icon-action";
  regenerateButton.dataset.regenerateMessage = message.id;
  regenerateButton.disabled = state.busy;
  regenerateButton.title = "重新生成";
  regenerateButton.setAttribute("aria-label", "重新生成");
  regenerateButton.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36"></path>
      <path d="M21 3v6h-6"></path>
    </svg>
  `;

  actions.append(regenerateButton);

  if (speechSynthesisSupported() && String(message.content || "").trim()) {
    const speakButton = document.createElement("button");
    speakButton.type = "button";
    speakButton.className = "assistant-icon-action";
    speakButton.dataset.speakMessage = message.id;
    speakButton.classList.toggle("active", state.speakingMessageId === message.id);
    speakButton.title = state.speakingMessageId === message.id ? "停止朗读" : "朗读这段";
    speakButton.setAttribute("aria-label", state.speakingMessageId === message.id ? "停止朗读" : "朗读这段");
    speakButton.setAttribute("aria-pressed", String(state.speakingMessageId === message.id));
    speakButton.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M11 5 6 9H3v6h3l5 4V5Z"></path>
        <path d="M16 9.5a4 4 0 0 1 0 5"></path>
        <path d="M19 7a8 8 0 0 1 0 10"></path>
      </svg>
    `;
    actions.append(speakButton);
  }

  actions.append(renderFeedbackButton(message, "up"), renderFeedbackButton(message, "down"));

  const more = document.createElement("details");
  more.className = "assistant-more-menu";
  const summary = document.createElement("summary");
  summary.className = "assistant-icon-action";
  summary.title = "更多";
  summary.setAttribute("aria-label", "更多操作");
  summary.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="5" cy="12" r="1"></circle>
      <circle cx="12" cy="12" r="1"></circle>
      <circle cx="19" cy="12" r="1"></circle>
    </svg>
  `;
  const menu = document.createElement("div");
  menu.className = "assistant-more-list";

  const branchButton = document.createElement("button");
  branchButton.type = "button";
  branchButton.className = "assistant-menu-action";
  branchButton.dataset.branchFromMessage = message.id;
  branchButton.disabled = state.busy;
  branchButton.textContent = "从这里分叉";
  menu.append(branchButton);

  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.className = "assistant-menu-action";
  exportButton.dataset.exportMessage = message.id;
  exportButton.textContent = "导出单条回复";
  menu.append(exportButton);

  if (agentExecutionReport(message)) {
    const agentReportButton = document.createElement("button");
    agentReportButton.type = "button";
    agentReportButton.className = "assistant-menu-action";
    agentReportButton.dataset.copyAgentReport = message.id;
    agentReportButton.textContent = "复制 Agent 过程";
    menu.append(agentReportButton);
  }

  if (message.agentRunId && !message.streaming) {
    if (message.agentRunStatus === "awaiting_plan") {
      const confirmPlanButton = document.createElement("button");
      confirmPlanButton.type = "button";
      confirmPlanButton.className = "assistant-menu-action";
      confirmPlanButton.dataset.confirmAgentPlan = message.id;
      confirmPlanButton.disabled = state.busy;
      confirmPlanButton.textContent = "确认执行 Agent 计划";
      menu.append(confirmPlanButton);
    }

    const synthButton = document.createElement("button");
    synthButton.type = "button";
    synthButton.className = "assistant-menu-action";
    synthButton.dataset.agentRerun = message.id;
    synthButton.dataset.agentPhase = "synthesizer";
    synthButton.disabled = state.busy || message.agentRunStatus === "awaiting_plan";
    synthButton.textContent = "重新综合最终回答";
    menu.append(synthButton);
  }

  if (message.diagnostics || message.usage || message.search) {
    const diagnosticsButton = document.createElement("button");
    diagnosticsButton.type = "button";
    diagnosticsButton.className = "assistant-menu-action";
    diagnosticsButton.dataset.diagnosticsMessage = message.id;
    diagnosticsButton.textContent = "诊断";
    menu.append(diagnosticsButton);
  }

  more.append(summary, menu);
  actions.append(more);
  return actions;
}

function renderFeedbackButton(message, value) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "assistant-icon-action feedback";
  button.dataset.feedbackMessage = message.id;
  button.dataset.feedbackValue = value;
  button.classList.toggle("active", message.feedback === value);
  button.setAttribute("aria-pressed", String(message.feedback === value));
  button.setAttribute("aria-label", value === "up" ? "这条回复有帮助" : "这条回复没帮助");
  button.title = value === "up" ? "有帮助" : "没帮助";
  button.innerHTML =
    value === "up"
      ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path><path d="M7 11l4-8a3 3 0 0 1 3 3v4h5a2 2 0 0 1 2 2l-1 7a3 3 0 0 1-3 3H7V11Z"></path></svg>`
      : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 2h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"></path><path d="M17 13l-4 8a3 3 0 0 1-3-3v-4H5a2 2 0 0 1-2-2l1-7a3 3 0 0 1 3-3h10v11Z"></path></svg>`;
  return button;
}

function renderUserEditForm(message) {
  const form = document.createElement("form");
  form.className = "message-edit-form";
  form.dataset.editMessageForm = message.id;

  if (message.attachments?.length) {
    form.append(renderMessageAttachments(message.attachments));
  }

  const textarea = document.createElement("textarea");
  textarea.className = "message-edit-textarea";
  textarea.name = "content";
  textarea.value = message.content || "";
  textarea.rows = 1;
  textarea.setAttribute("aria-label", "修改消息");
  textarea.addEventListener("input", () => resizeMessageEditTextarea(textarea));
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelMessageEdit();
    }
  });

  const actions = document.createElement("div");
  actions.className = "message-edit-actions";

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "message-edit-cancel";
  cancelButton.dataset.cancelMessageEdit = message.id;
  cancelButton.textContent = "取消";

  const submitButton = document.createElement("button");
  submitButton.type = "submit";
  submitButton.className = "message-edit-submit";
  submitButton.textContent = "发送";

  actions.append(cancelButton, submitButton);
  form.append(textarea, actions);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitMessageEdit(message.id, textarea.value);
  });

  requestAnimationFrame(() => {
    resizeMessageEditTextarea(textarea);
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  });

  return form;
}

function canEditUserMessage(message) {
  if (message.role !== "user" || state.busy) return false;
  return state.messages.some((item) => item.id === message.id);
}

function canShowAssistantActions(message) {
  if (message.role !== "assistant" || message.streaming) return false;
  const index = state.messages.findIndex((item) => item.id === message.id);
  return index > 0 && state.messages.slice(0, index).some((item) => item.role === "user");
}

function syncAssistantActions(bubble, message) {
  const existing = bubble.querySelector(".assistant-actions");
  const next = renderAssistantActions(message);
  if (existing && next) {
    existing.replaceWith(next);
  } else if (existing) {
    existing.remove();
  } else if (next) {
    bubble.append(next);
  }
}

function toggleSpeakMessage(messageId) {
  if (!speechSynthesisSupported()) {
    showToast("当前浏览器不支持朗读");
    return;
  }
  if (state.speakingMessageId === messageId) {
    stopSpeechPlayback();
    return;
  }
  const message = state.messages.find((item) => item.id === messageId);
  const text = speechTextFromMessage(message);
  if (!text) return;
  const chunks = speechChunks(text);
  if (!chunks.length) return;
  stopSpeechPlayback({ render: false });
  state.speakingMessageId = messageId;
  state.speechQueue = chunks;
  speakNextChunk(messageId);
  syncVisibleAssistantActions();
}

function speakNextChunk(messageId) {
  if (state.speakingMessageId !== messageId) return;
  const chunk = state.speechQueue.shift();
  if (!chunk) {
    clearSpeechPlayback(messageId);
    return;
  }
  const utterance = new SpeechSynthesisUtterance(chunk);
  const lang = state.voiceLanguage || normalizeVoiceLanguage(document.documentElement.lang || navigator.language || "zh-CN");
  utterance.lang = lang;
  const voice = preferredSpeechVoice(lang);
  if (voice) utterance.voice = voice;
  utterance.rate = 1;
  utterance.onend = () => speakNextChunk(messageId);
  utterance.onerror = () => clearSpeechPlayback(messageId);
  state.speechUtterance = utterance;
  window.speechSynthesis.speak(utterance);
}

function stopSpeechPlayback({ render = true } = {}) {
  if (speechSynthesisSupported()) {
    window.speechSynthesis.cancel();
  }
  state.speakingMessageId = "";
  state.speechUtterance = null;
  state.speechQueue = [];
  if (render) syncVisibleAssistantActions();
}

function clearSpeechPlayback(messageId) {
  if (state.speakingMessageId && state.speakingMessageId !== messageId) return;
  state.speakingMessageId = "";
  state.speechUtterance = null;
  state.speechQueue = [];
  syncVisibleAssistantActions();
}

function renderModelTabs() {
  let activeMode = defaultMode;
  for (const button of modelTabs.querySelectorAll("button[data-mode]")) {
    const isActive = modelRoutes[button.dataset.mode] === state.model;
    button.classList.toggle("active", isActive);
    if (isActive) activeMode = button.dataset.mode || activeMode;
  }
  modelTabs.dataset.activeMode = activeMode;
  deepThinkButton.classList.toggle("active", state.thinkingEnabled);
  deepThinkButton.setAttribute("aria-pressed", String(state.thinkingEnabled));
  deepThinkButton.title = state.thinkingEnabled ? "关闭深度思考" : "开启深度思考";
  const title = document.querySelector(".empty-title h1");
  if (title) {
    const seek = activeSeek();
    if (seek) {
      title.textContent = `使用 ${seek.name} Seek 助手开始对话`;
      return;
    }
    if (state.model === modelRoutes.expert) {
      title.textContent = state.thinkingEnabled ? "使用专家模式开始对话" : "使用专家模式（关闭思考）开始对话";
    } else {
      title.textContent = state.thinkingEnabled ? "使用快速思考模式开始对话" : "使用快速模式开始对话";
    }
  }
}

function setModel(model) {
  state.model = normalizeModel(model);
  setThinkingEnabled(state.model === modelRoutes.expert, { render: false });
  localStorage.setItem(storageKeys.model, state.model);
  renderModelTabs();
}

function setThinkingEnabled(enabled, { render = true } = {}) {
  state.thinkingEnabled = Boolean(enabled);
  localStorage.setItem(storageKeys.thinkingEnabled, state.thinkingEnabled ? "1" : "0");
  if (render) renderModelTabs();
}

function clientTavilyKey() {
  return tavilyKeyInput?.value.trim() || "";
}

function tavilyApiKeyForSearch(searchEnabled) {
  return searchEnabled ? clientTavilyKey() : "";
}

function updateSearchAvailability({ render = true } = {}) {
  state.hasSearch = Boolean(state.hasServerSearch || clientTavilyKey());
  if (render) renderSearchToggle();
}

function renderSearchToggle() {
  const active = state.searchMode !== "off" && state.hasSearch;
  searchToggleButton.classList.toggle("active", active);
  searchToggleButton.classList.toggle("force", state.searchMode === "on" && state.hasSearch);
  searchToggleButton.disabled = !state.hasSearch;
  searchToggleButton.setAttribute("aria-pressed", String(active));
  const label = searchToggleButton.querySelector("span");
  if (label) {
    if (!state.hasSearch) label.textContent = "搜索不可用";
    else if (state.searchMode === "off") label.textContent = "搜索关闭";
    else if (state.searchMode === "on") label.textContent = "强制搜索";
    else label.textContent = "自动搜索";
  }
  searchToggleButton.title = state.searchMode === "on" ? "本轮总是联网搜索" : state.searchMode === "auto" ? "由模型决定本轮是否联网" : "关闭联网搜索";
}

function renderAgentModeButton() {
  if (!agentModeButton) return;
  agentModeButton.classList.toggle("active", state.agentMode);
  agentModeButton.setAttribute("aria-pressed", String(state.agentMode));
  const presetLabel = state.agentPreset === "auto" ? "自动选择" : state.agentPreset === "plan" ? "先确认计划" : "完整直跑";
  agentModeButton.title = state.agentMode ? `关闭多 Agent 思考 · ${presetLabel}` : `开启多 Agent 思考 · ${presetLabel}`;
  const label = agentModeButton.querySelector("span");
  if (label) label.textContent = state.agentMode ? `多 Agent · ${presetLabel}` : "多 Agent";
}

function loadSearchMode() {
  const mode = String(localStorage.getItem(storageKeys.searchMode) || "").toLowerCase();
  if (["off", "auto", "on"].includes(mode)) return mode;
  return localStorage.getItem(storageKeys.searchEnabled) === "0" ? "off" : "auto";
}

function nextSearchMode(mode) {
  if (mode === "off") return "auto";
  if (mode === "auto") return "on";
  return "off";
}

function shouldRequestSearch() {
  return state.hasSearch && state.searchMode !== "off";
}

function seekReferenceSlotsRemaining() {
  return Math.max(
    0,
    maxSeekReferenceAttachments - state.seekEditorAttachments.length - state.seekEditorUploadingAttachments.length
  );
}

function updateSeekReferenceControls() {
  if (!seekReferenceButton) return;
  const full = seekReferenceSlotsRemaining() <= 0;
  seekReferenceButton.disabled = state.busy || state.uploadActive || full;
  seekReferenceButton.textContent = full ? "已满" : "添加文件";
}

async function onSeekReferenceInputChange(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;

  try {
    if (state.busy || state.uploadActive) {
      showToast("文件正在上传，请稍等");
      return;
    }

    const remainingSlots = seekReferenceSlotsRemaining();
    if (remainingSlots <= 0) {
      showToast(`每个 Seek 最多添加 ${maxSeekReferenceAttachments} 个参考文件`);
      return;
    }

    const selectedFiles = validatedUploadFiles(files, {
      remainingSlots,
      maxSlots: maxSeekReferenceAttachments,
      slotMessage: `每个 Seek 最多添加 ${maxSeekReferenceAttachments} 个参考文件`,
    });
    if (!selectedFiles.length) return;

    const uploadItems = selectedFiles.map((file) => ({
      id: createId(),
      name: file.name || "参考文件",
      size: Number(file.size) || 0,
      file,
      kind: fileKindFromName(file.name),
      status: file.size ? "uploading" : "error",
      progress: 0,
      error: file.size ? "" : "空文件或浏览器无法读取",
    }));

    await decorateUploadItemsWithImagePreviews(uploadItems);
    state.seekEditorUploadingAttachments.push(...uploadItems);
    renderSeekReferenceList();

    const filesToUpload = selectedFiles.filter((file) => file.size);
    if (!filesToUpload.length) {
      for (const item of uploadItems) {
        if (item.status === "error") showToast(item.error);
      }
      return;
    }

    state.uploadActive = true;
    attachmentButton.setAttribute("aria-disabled", "true");
    updateSeekReferenceControls();
    showToast(`正在上传 ${filesToUpload.length} 个 Seek 参考文件`);

    try {
      const result = await uploadFilesWithProgress(
        filesToUpload,
        (progress) => {
          updateSeekReferenceUploadItems(uploadItems, { status: "uploading", progress });
        },
        () => {
          updateSeekReferenceUploadItems(uploadItems, { status: "processing", progress: 100 });
        },
        { ocrEnabled: true }
      );
      applySeekReferenceUploadResult(uploadItems, result);
    } catch (error) {
      for (const item of uploadItems) {
        if (item.status !== "error") {
          markSeekReferenceUploadFailed(item.id, friendlyUploadError(error.message || "文件识别失败"));
        }
      }
    } finally {
      state.uploadActive = false;
      attachmentButton.setAttribute("aria-disabled", String(state.uploadActive));
      updateSeekReferenceControls();
    }
  } finally {
    seekReferenceInput.value = "";
  }
}

function updateSeekReferenceUploadItems(uploadItems, patch) {
  const ids = new Set(uploadItems.map((item) => item.id));
  for (const item of state.seekEditorUploadingAttachments) {
    if (!ids.has(item.id) || item.status === "error") continue;
    Object.assign(item, patch);
  }
  renderSeekReferenceList();
}

function applySeekReferenceUploadResult(uploadItems, result) {
  const files = Array.isArray(result.files) ? result.files : [];
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const remainingUploadIds = uploadItems.filter((item) => item.status !== "error").map((item) => item.id);

  const takeUploadId = (name) => {
    const namedIndex = remainingUploadIds.findIndex((id) => {
      const item = state.seekEditorUploadingAttachments.find((attachment) => attachment.id === id);
      return item && item.name === name;
    });
    const fallbackIndex = remainingUploadIds.findIndex((id) =>
      state.seekEditorUploadingAttachments.some((attachment) => attachment.id === id)
    );
    const index = namedIndex >= 0 ? namedIndex : fallbackIndex;
    if (index < 0) return "";
    const [uploadId] = remainingUploadIds.splice(index, 1);
    return uploadId || "";
  };

  for (const file of files) {
    const attachment = normalizeAttachment(file);
    const uploadId = takeUploadId(attachment.name);
    if (!uploadId) continue;
    const source = uploadItems.find((item) => item.id === uploadId);
    if (source?.thumbnail) attachment.thumbnail = source.thumbnail;
    if (source?.imagePreview) attachment.imagePreview = source.imagePreview;
    state.seekEditorUploadingAttachments = state.seekEditorUploadingAttachments.filter((item) => item.id !== uploadId);
    state.seekEditorAttachments.push(attachment);
  }

  for (const error of errors) {
    const name = String(error.name || "");
    const uploadId = takeUploadId(name);
    if (uploadId) {
      markSeekReferenceUploadFailed(uploadId, friendlyUploadError(error.error || "文件识别失败"));
    }
  }

  for (const uploadId of remainingUploadIds) {
    markSeekReferenceUploadFailed(uploadId, "文件没有返回识别结果，请重试");
  }

  state.seekEditorAttachments = normalizeSeekReferenceAttachments(state.seekEditorAttachments);
  renderSeekReferenceList();
  if (files.length) {
    showToast(`已添加 ${files.length} 个 Seek 参考文件`);
  }
}

function markSeekReferenceUploadFailed(uploadId, error) {
  const item = state.seekEditorUploadingAttachments.find((attachment) => attachment.id === uploadId);
  if (item) {
    item.status = "error";
    item.progress = 0;
    item.error = friendlyUploadError(error);
  }
  renderSeekReferenceList();
  showToast(friendlyUploadError(error));
}

function renderSeekReferenceList() {
  if (!seekReferenceList) return;
  seekReferenceList.replaceChildren();

  if (!state.seekEditorAttachments.length && !state.seekEditorUploadingAttachments.length) {
    const empty = document.createElement("p");
    empty.className = "seek-reference-empty";
    empty.textContent = "还没有参考文件。";
    seekReferenceList.append(empty);
    updateSeekReferenceControls();
    return;
  }

  for (const attachment of state.seekEditorUploadingAttachments) {
    seekReferenceList.append(renderSeekReferenceItem(attachment, { uploading: true }));
  }

  for (const attachment of state.seekEditorAttachments) {
    seekReferenceList.append(renderSeekReferenceItem(attachment, { uploading: false }));
  }

  updateSeekReferenceControls();
}

function renderSeekReferenceItem(attachment, { uploading = false } = {}) {
  const item = document.createElement("div");
  item.className = `seek-reference-item ${uploading && attachment.status === "error" ? "error" : ""}`;

  const info = document.createElement("div");
  info.className = "seek-reference-info";

  const name = document.createElement("span");
  name.className = "seek-reference-name";
  name.textContent = attachment.name || "参考文件";

  const meta = document.createElement("span");
  meta.className = "seek-reference-meta";
  if (uploading && attachment.status === "error") {
    meta.textContent = `${String(attachment.kind || "FILE").toUpperCase()} · ${formatBytes(attachment.size)} · ${
      attachment.error || "识别失败"
    }`;
  } else if (uploading && attachment.status === "uploading") {
    meta.textContent = `${String(attachment.kind || "FILE").toUpperCase()} · ${formatBytes(attachment.size)} · 上传 ${
      attachment.progress || 0
    }%`;
  } else if (uploading) {
    meta.textContent = `${String(attachment.kind || "FILE").toUpperCase()} · ${formatBytes(attachment.size)} · 正在识别...`;
  } else {
    const chunkLabel = attachment.chunked || attachment.chunkCount > 1 ? ` · 已分块 ${attachment.chunkCount} 段` : "";
    meta.textContent = `${String(attachment.kind || "FILE").toUpperCase()} · ${formatBytes(attachment.size)}${chunkLabel}${
      attachment.truncated ? " · 已截断" : ""
    }`;
  }

  info.append(name, meta);
  if (uploading && attachment.status === "uploading") {
    const progress = document.createElement("span");
    progress.className = "attachment-progress";
    const bar = document.createElement("span");
    bar.style.width = `${Math.max(0, Math.min(100, Number(attachment.progress) || 0))}%`;
    progress.append(bar);
    info.append(progress);
  }

  const actions = document.createElement("div");
  actions.className = "attachment-actions";
  if (uploading && isOcrRetryError(attachment)) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "attachment-remove";
    retry.dataset.retrySeekReferenceOcr = attachment.id;
    retry.setAttribute("aria-label", `OCR ${attachment.name}`);
    retry.textContent = "OCR";
    actions.append(retry);
  }
  if (!uploading && (attachment.preview || attachment.text)) {
    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "attachment-preview";
    preview.dataset.previewSeekReference = attachment.id;
    preview.textContent = "预览";
    actions.append(preview);
  }

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "attachment-remove";
  remove.dataset.removeSeekReference = attachment.id;
  remove.setAttribute("aria-label", `移除 ${attachment.name}`);
  remove.textContent = "×";
  actions.append(remove);

  item.append(info, actions);
  return item;
}

async function retrySeekReferenceWithOcr(uploadId) {
  if (state.uploadActive) return;
  const item = state.seekEditorUploadingAttachments.find((attachment) => attachment.id === uploadId);
  if (!isOcrRetryError(item)) return;

  item.status = "uploading";
  item.progress = 0;
  item.error = "";
  state.uploadActive = true;
  attachmentButton.setAttribute("aria-disabled", "true");
  renderSeekReferenceList();

  try {
    const result = await uploadFilesWithProgress(
      [item.file],
      (progress) => {
        updateSeekReferenceUploadItems([item], { status: "uploading", progress });
      },
      () => {
        updateSeekReferenceUploadItems([item], { status: "processing", progress: 100 });
      },
      { ocrEnabled: true }
    );
    applySeekReferenceUploadResult([item], result);
  } catch (error) {
    markSeekReferenceUploadFailed(item.id, friendlyUploadError(error.message || "OCR 失败"));
  } finally {
    state.uploadActive = false;
    attachmentButton.setAttribute("aria-disabled", String(state.uploadActive));
    updateSeekReferenceControls();
  }
}

function onSeekReferenceListClick(event) {
  const retryButton = event.target.closest("button[data-retry-seek-reference-ocr]");
  if (retryButton) {
    retrySeekReferenceWithOcr(retryButton.dataset.retrySeekReferenceOcr || "");
    return;
  }

  const previewButton = event.target.closest("button[data-preview-seek-reference]");
  if (previewButton) {
    const attachment = state.seekEditorAttachments.find((item) => item.id === previewButton.dataset.previewSeekReference);
    if (attachment) {
      openFilePreview(attachment);
    }
    return;
  }

  const removeButton = event.target.closest("button[data-remove-seek-reference]");
  if (!removeButton) return;
  state.seekEditorAttachments = state.seekEditorAttachments.filter((item) => item.id !== removeButton.dataset.removeSeekReference);
  state.seekEditorUploadingAttachments = state.seekEditorUploadingAttachments.filter(
    (item) => item.id !== removeButton.dataset.removeSeekReference
  );
  renderSeekReferenceList();
}

async function onFileInputChange(event) {
  const files = Array.from(event.target.files || []);
  await uploadPendingAttachmentFiles(files, { emptyMessage: "没有选择文件" });
  fileInput.value = "";
}

function onPromptPaste(event) {
  const files = Array.from(event.clipboardData?.files || []);
  if (!files.length) return;
  event.preventDefault();
  uploadPendingAttachmentFiles(files, { emptyMessage: "剪贴板里没有可导入文件" });
}

function onDocumentDragEnter(event) {
  if (!hasTransferFiles(event.dataTransfer)) return;
  event.preventDefault();
  state.dragDepth += 1;
  setDropOverlayVisible(true);
}

function onDocumentDragOver(event) {
  if (!hasTransferFiles(event.dataTransfer)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  setDropOverlayVisible(true);
}

function onDocumentDragLeave(event) {
  if (!hasTransferFiles(event.dataTransfer)) return;
  state.dragDepth = Math.max(0, state.dragDepth - 1);
  if (state.dragDepth === 0) setDropOverlayVisible(false);
}

function onDocumentDrop(event) {
  if (!hasTransferFiles(event.dataTransfer)) return;
  event.preventDefault();
  state.dragDepth = 0;
  setDropOverlayVisible(false);
  uploadPendingAttachmentFiles(filesFromTransfer(event.dataTransfer), { emptyMessage: "没有可导入文件" });
}

function hasTransferFiles(dataTransfer) {
  return Array.from(dataTransfer?.types || []).includes("Files");
}

function filesFromTransfer(dataTransfer) {
  return Array.from(dataTransfer?.files || []);
}

function setDropOverlayVisible(visible) {
  if (!dropOverlay) return;
  dropOverlay.hidden = !visible;
  dropOverlay.setAttribute("aria-hidden", String(!visible));
}

async function uploadPendingAttachmentFiles(files, { emptyMessage = "没有选择文件" } = {}) {
  if (!files.length) {
    showToast(emptyMessage);
    return;
  }

  if (state.uploadActive) {
    showToast("文件正在上传，请稍等");
    return;
  }

  const remainingSlots = maxPendingAttachments - state.pendingAttachments.length - state.uploadingAttachments.length;
  if (remainingSlots <= 0) {
    showToast(`最多同时添加 ${maxPendingAttachments} 个文件`);
    return;
  }

  const selectedFiles = validatedUploadFiles(files, {
    remainingSlots,
    maxSlots: maxPendingAttachments,
    slotMessage: `最多同时添加 ${maxPendingAttachments} 个文件`,
  });
  if (!selectedFiles.length) return;

  const uploadItems = selectedFiles.map((file) => ({
    id: createId(),
    name: file.name || "所选文件",
    size: Number(file.size) || 0,
    file,
    kind: fileKindFromName(file.name),
    status: file.size ? "uploading" : "error",
    progress: 0,
    ocrRetryAvailable: false,
    error: file.size ? "" : "空文件或浏览器无法读取",
  }));

  await decorateUploadItemsWithImagePreviews(uploadItems);
  state.uploadingAttachments.push(...uploadItems);
  renderAttachmentList();
  resizeComposer();
  saveDraft();

  const filesToUpload = selectedFiles.filter((file) => file.size);
  if (!filesToUpload.length) {
    for (const item of uploadItems) {
      if (item.status === "error") {
        showToast(item.error);
      }
    }
    return;
  }

  state.uploadActive = true;
  attachmentButton.setAttribute("aria-disabled", "true");
  updateSeekReferenceControls();
  showToast(`正在上传 ${filesToUpload.length} 个文件`);

  try {
    const result = await uploadFilesWithProgress(
      filesToUpload,
      (progress) => {
        updateUploadItems(uploadItems, { status: "uploading", progress });
      },
      () => {
        updateUploadItems(uploadItems, { status: "processing", progress: 100 });
      },
      { ocrEnabled: true }
    );
    applyBatchUploadResult(uploadItems, result);
  } catch (error) {
    for (const item of uploadItems) {
      if (item.status !== "error") {
        markUploadFailed(item.id, friendlyUploadError(error.message || "文件识别失败"));
      }
    }
  } finally {
    state.uploadActive = false;
    attachmentButton.setAttribute("aria-disabled", String(state.uploadActive));
    updateSeekReferenceControls();
  }
}

function validatedUploadFiles(files, { remainingSlots, maxSlots, slotMessage }) {
  const selectedBySlot = files.slice(0, Math.max(0, remainingSlots));
  if (files.length > selectedBySlot.length) {
    showToast(`${slotMessage}，已忽略多余文件`);
  }
  const valid = [];
  let requestBytes = 0;
  for (const file of selectedBySlot) {
    const size = Number(file.size) || 0;
    if (!size) {
      valid.push(file);
      continue;
    }
    if (size > state.uploadLimits.fileMaxBytes) {
      announceStatus(`${file.name || "文件"} 超过 ${formatBytes(state.uploadLimits.fileMaxBytes)} 单文件限制`, { alert: true });
      showToast(`${file.name || "文件"} 超过 ${formatBytes(state.uploadLimits.fileMaxBytes)}，已跳过`);
      continue;
    }
    if (requestBytes + size > state.uploadLimits.requestMaxBytes) {
      announceStatus(`本次上传超过 ${formatBytes(state.uploadLimits.requestMaxBytes)} 请求上限`, { alert: true });
      showToast(`本次上传超过 ${formatBytes(state.uploadLimits.requestMaxBytes)}，已跳过多余文件`);
      continue;
    }
    requestBytes += size;
    valid.push(file);
  }
  if (!valid.length && remainingSlots > 0 && maxSlots) {
    haptic("error");
  }
  return valid;
}

function normalizeUploadLimits(value) {
  if (!value || typeof value !== "object") return { ...defaultUploadLimits };
  return {
    fileMaxBytes: positiveNumber(value.fileMaxBytes, defaultUploadLimits.fileMaxBytes),
    requestMaxBytes: positiveNumber(value.requestMaxBytes, defaultUploadLimits.requestMaxBytes),
    maxFiles: positiveNumber(value.maxFiles, defaultUploadLimits.maxFiles),
  };
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

async function decorateUploadItemsWithImagePreviews(uploadItems) {
  await Promise.all(
    uploadItems.map(async (item) => {
      if (!isBrowserImageFile(item.file) || item.size > maxLocalImagePreviewBytes) {
        if (isBrowserImageFile(item.file) && item.size > maxLocalImagePreviewBytes) {
          item.previewNote = "图片较大，已跳过本地预览";
        }
        return;
      }
      try {
        Object.assign(item, await createImageAttachmentPreview(item.file));
      } catch {
        item.previewNote = "图片预览生成失败";
      }
    })
  );
}

function isBrowserImageFile(file) {
  return file instanceof File && String(file.type || "").startsWith("image/");
}

function createImageAttachmentPreview(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("image failed"));
      image.onload = () => {
        resolve({
          thumbnail: imageDataUrlFromCanvas(image, 96, 0.78),
          imagePreview: imageDataUrlFromCanvas(image, 1600, 0.84),
        });
      };
      image.src = String(reader.result || "");
    };
    reader.readAsDataURL(file);
  });
}

function imageDataUrlFromCanvas(image, maxSize, quality) {
  const scale = Math.min(1, maxSize / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height, 1));
  const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
  const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")?.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality);
}

function updateUploadItems(uploadItems, patch) {
  const ids = new Set(uploadItems.map((item) => item.id));
  for (const item of state.uploadingAttachments) {
    if (!ids.has(item.id) || item.status === "error") continue;
    Object.assign(item, patch);
  }
  renderAttachmentList();
  resizeComposer();
}

function applyBatchUploadResult(uploadItems, result) {
  const files = Array.isArray(result.files) ? result.files : [];
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const remainingUploadIds = uploadItems.filter((item) => item.status !== "error").map((item) => item.id);

  const takeUploadId = (name) => {
    const namedIndex = remainingUploadIds.findIndex((id) => {
      const item = state.uploadingAttachments.find((attachment) => attachment.id === id);
      return item && item.name === name;
    });
    const fallbackIndex = remainingUploadIds.findIndex((id) =>
      state.uploadingAttachments.some((attachment) => attachment.id === id)
    );
    const index = namedIndex >= 0 ? namedIndex : fallbackIndex;
    if (index < 0) return "";
    const [uploadId] = remainingUploadIds.splice(index, 1);
    return uploadId || "";
  };

  for (const file of files) {
    const attachment = normalizeAttachment(file);
    const uploadId = takeUploadId(attachment.name);
    if (!uploadId) continue;
    const source = uploadItems.find((item) => item.id === uploadId);
    if (source?.thumbnail) attachment.thumbnail = source.thumbnail;
    if (source?.imagePreview) attachment.imagePreview = source.imagePreview;
    state.uploadingAttachments = state.uploadingAttachments.filter((item) => item.id !== uploadId);
    state.pendingAttachments.push(attachment);
  }

  for (const error of errors) {
    const name = String(error.name || "");
    const uploadId = takeUploadId(name);
    if (uploadId) {
      markUploadFailed(uploadId, friendlyUploadError(error.error || "文件识别失败"));
    }
  }

  for (const uploadId of remainingUploadIds) {
    markUploadFailed(uploadId, "文件没有返回识别结果，请重试");
  }

  renderAttachmentList();
  resizeComposer();
  saveDraft();
  if (files.length) {
    showToast(`已识别 ${files.length} 个文件`);
  }
}

function markUploadFailed(uploadId, error) {
  const item = state.uploadingAttachments.find((attachment) => attachment.id === uploadId);
  if (item) {
    item.status = "error";
    item.progress = 0;
    item.error = friendlyUploadError(error);
  }
  renderAttachmentList();
  resizeComposer();
  showToast(friendlyUploadError(error));
}

function friendlyUploadError(message) {
  const text = String(message || "文件识别失败");
  // OCR_REQUIRED：开关没勾。优先识别，给出明确的勾选指引（这条比 OCR_UNAVAILABLE 更具体）
  if (/ocr_required|OCR to be enabled|OCR_ENABLED=1/i.test(text)) {
    return "图片需要 OCR 才能识别文字。请在启动器勾选「开启 OCR 图像光学字符识别支持 (OCR_ENABLED)」，重启服务后重试。";
  }
  // OCR_UNAVAILABLE：引擎启动或运行失败。保留后端真实细节，方便用户自助诊断
  if (/No OCR engine|OCR dependencies|Tesseract|ocr_unavailable/i.test(text)) {
    const detail = text.length > 260 ? text.slice(0, 260) + "…" : text;
    return `OCR 不可用：${detail}（请确认 Tesseract 在 PATH 且服务进程能 import pytesseract；扫描 PDF 还需要 pdftoppm。重启服务后重试。）`;
  }
  if (/image OCR|image text|in image|图片|图像/i.test(text)) {
    return "这张图片需要 OCR 才能识别文字。请安装 requirements-ocr.txt 和 Tesseract，然后点击 OCR 重试。";
  }
  if (/scanned|image-only|OCR|扫描/.test(text)) {
    return "这个 PDF 像是扫描版，当前只能读取可复制文字的 PDF。请先转成可复制文本，或接入 OCR。";
  }
  if (/PDF parsing is not available|PDF parsing requires|pypdf|PyPDF2/.test(text)) {
    return "当前环境缺少 PDF 解析库，无法读取 PDF。请安装 pypdf/PyPDF2，或先转成 txt、md、docx。";
  }
  if (/empty|空文件|0 B/i.test(text)) {
    return "空文件或浏览器无法读取，请换一个文件重试。";
  }
  if (/too large|413|超大/i.test(text)) {
    return `文件太大，当前单文件最大支持 ${formatBytes(state.uploadLimits.fileMaxBytes)}。`;
  }
  return text;
}

function normalizeAttachment(value) {
  if (!value || typeof value !== "object") {
    throw new Error("文件识别结果无效");
  }
  return {
    id: createId(),
    name: String(value.name || "附件").slice(0, 180),
    type: String(value.type || ""),
    size: Number(value.size) || 0,
    kind: String(value.kind || "text"),
    text: String(value.text || ""),
    preview: String(value.preview || value.text || ""),
    fileId: typeof value.fileId === "string" ? value.fileId : "",
    projectId: typeof value.projectId === "string" ? value.projectId : "",
    charCount: Number(value.charCount) || 0,
    chunkCount: Number(value.chunkCount) || 0,
    chunked: Boolean(value.chunked),
    truncated: Boolean(value.truncated),
  };
}

function renderAttachmentList() {
  attachmentList.replaceChildren();
  attachmentList.hidden = state.pendingAttachments.length === 0 && state.uploadingAttachments.length === 0;

  for (const attachment of state.uploadingAttachments) {
    const item = document.createElement("div");
    item.className = `attachment-item ${attachment.status === "error" ? "error" : "processing"}`;

    const info = document.createElement("div");
    info.className = "attachment-info";
    const thumb = renderAttachmentThumbnail(attachment);

    const name = document.createElement("span");
    name.className = "attachment-name";
    name.textContent = attachment.name;

    const meta = document.createElement("span");
    meta.className = "attachment-meta";
    if (attachment.status === "error") {
      meta.textContent = `${String(attachment.kind || "FILE").toUpperCase()} · ${formatBytes(attachment.size)} · ${
        attachment.error || "识别失败"
      }`;
    } else if (attachment.status === "uploading") {
      meta.textContent = `${String(attachment.kind || "FILE").toUpperCase()} · ${formatBytes(attachment.size)} · 上传 ${
        attachment.progress || 0
      }%`;
    } else {
      meta.textContent = `${String(attachment.kind || "FILE").toUpperCase()} · ${formatBytes(attachment.size)} · 正在识别...`;
    }

    info.append(name, meta);
    if (attachment.status === "uploading") {
      const progress = document.createElement("span");
      progress.className = "attachment-progress";
      const bar = document.createElement("span");
      bar.style.width = `${Math.max(0, Math.min(100, Number(attachment.progress) || 0))}%`;
      progress.append(bar);
      info.append(progress);
    }

    const actions = document.createElement("div");
    actions.className = "attachment-actions";
    if (isOcrRetryError(attachment)) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "attachment-remove";
      retry.dataset.retryOcrAttachment = attachment.id;
      retry.setAttribute("aria-label", `OCR ${attachment.name}`);
      retry.textContent = "OCR";
      actions.append(retry);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-remove";
    remove.dataset.removeAttachment = attachment.id;
    remove.setAttribute("aria-label", `移除 ${attachment.name}`);
    remove.textContent = "×";

    actions.append(remove);
    if (thumb) item.append(thumb);
    item.append(info, actions);
    attachmentList.append(item);
  }

  for (const attachment of state.pendingAttachments) {
    const item = document.createElement("div");
    item.className = "attachment-item";

    const info = document.createElement("div");
    info.className = "attachment-info";
    const thumb = renderAttachmentThumbnail(attachment);

    const name = document.createElement("span");
    name.className = "attachment-name";
    name.textContent = attachment.name;

    const meta = document.createElement("span");
    meta.className = "attachment-meta";
    const chunkLabel = attachment.chunked || attachment.chunkCount > 1 ? ` · 已分块 ${attachment.chunkCount} 段` : "";
    meta.textContent = `${attachment.kind.toUpperCase()} · ${formatBytes(attachment.size)}${chunkLabel}${attachment.truncated ? " · 已截断" : ""}${
      attachment.previewNote ? ` · ${attachment.previewNote}` : ""
    }`;

    info.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "attachment-actions";
    if (attachment.preview || attachment.text) {
      const preview = document.createElement("button");
      preview.type = "button";
      preview.className = "attachment-preview";
      preview.dataset.previewAttachment = attachment.id;
      preview.textContent = "预览";
      actions.append(preview);
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-remove";
    remove.dataset.removeAttachment = attachment.id;
    remove.setAttribute("aria-label", `移除 ${attachment.name}`);
    remove.textContent = "×";
    actions.append(remove);

    if (thumb) item.append(thumb);
    item.append(info, actions);
    attachmentList.append(item);
  }
}

function renderAttachmentThumbnail(attachment) {
  if (!attachment?.thumbnail) return null;
  const img = document.createElement("img");
  img.className = "attachment-thumb";
  img.src = attachment.thumbnail;
  img.alt = "";
  img.loading = "lazy";
  return img;
}

function renderQuotePreview() {
  if (!quotePreview) return;
  const quote = state.quoteDraft?.isFragment ? state.quoteDraft.fragment || state.quoteDraft.text || "" : state.quoteDraft?.text || "";
  quotePreview.replaceChildren();
  quotePreview.hidden = !quote;
  if (!quote) return;

  const text = document.createElement("span");
  const label = state.quoteDraft?.isFragment ? "引用片段" : "引用";
  text.textContent = `${label}：${quote.length > 120 ? `${quote.slice(0, 120)}...` : quote}`;

  const actions = document.createElement("div");
  actions.className = "quote-preview-actions";
  if (state.quoteDraft?.isFragment && state.quoteDraft.messageId) {
    const origin = document.createElement("button");
    origin.type = "button";
    origin.dataset.quoteOrigin = state.quoteDraft.messageId;
    origin.textContent = "原消息";
    actions.append(origin);
  }

  const clear = document.createElement("button");
  clear.type = "button";
  clear.dataset.clearQuote = "1";
  clear.setAttribute("aria-label", "取消引用");
  clear.textContent = "×";
  actions.append(clear);

  quotePreview.append(text, actions);
}

function isOcrRetryError(attachment) {
  return (
    attachment?.status === "error" &&
    attachment?.file instanceof File &&
    /ocr|scanned|image-only|扫描/i.test(String(attachment.error || ""))
  );
}

async function retryAttachmentWithOcr(uploadId) {
  if (state.uploadActive) return;
  const item = state.uploadingAttachments.find((attachment) => attachment.id === uploadId);
  if (!isOcrRetryError(item)) return;

  item.status = "uploading";
  item.progress = 0;
  item.error = "";
  state.uploadActive = true;
  attachmentButton.setAttribute("aria-disabled", "true");
  updateSeekReferenceControls();
  renderAttachmentList();
  resizeComposer();

  try {
    const result = await uploadFilesWithProgress(
      [item.file],
      (progress) => {
        updateUploadItems([item], { status: "uploading", progress });
      },
      () => {
        updateUploadItems([item], { status: "processing", progress: 100 });
      },
      { ocrEnabled: true }
    );
    applyBatchUploadResult([item], result);
  } catch (error) {
    markUploadFailed(item.id, friendlyUploadError(error.message || "OCR 失败"));
  } finally {
    state.uploadActive = false;
    attachmentButton.setAttribute("aria-disabled", String(state.uploadActive));
    updateSeekReferenceControls();
  }
}

function onAttachmentListClick(event) {
  const retryButton = event.target.closest("button[data-retry-ocr-attachment]");
  if (retryButton) {
    retryAttachmentWithOcr(retryButton.dataset.retryOcrAttachment || "");
    return;
  }

  const previewButton = event.target.closest("button[data-preview-attachment]");
  if (previewButton) {
    const attachment = state.pendingAttachments.find((item) => item.id === previewButton.dataset.previewAttachment);
    if (attachment) {
      openFilePreview(attachment);
    }
    return;
  }

  const removeButton = event.target.closest("button[data-remove-attachment]");
  if (!removeButton) return;
  state.pendingAttachments = state.pendingAttachments.filter((item) => item.id !== removeButton.dataset.removeAttachment);
  state.uploadingAttachments = state.uploadingAttachments.filter((item) => item.id !== removeButton.dataset.removeAttachment);
  renderAttachmentList();
  resizeComposer();
  saveDraft();
}

function renderMessageAttachments(attachments) {
  const list = document.createElement("div");
  list.className = "message-attachments";
  const images = imageAttachments(attachments);

  for (const [index, attachment] of attachments.entries()) {
    const item = attachment.thumbnail ? document.createElement("button") : document.createElement("span");
    item.className = attachment.thumbnail ? "message-attachment image" : "message-attachment";
    const chunkLabel = attachment.chunked || attachment.chunkCount > 1 ? ` · ${attachment.chunkCount} 段` : "";
    if (attachment.thumbnail) {
      item.type = "button";
      item.dataset.messageImage = String(images.findIndex((image) => image === attachment));
      item.innerHTML = `<img alt="" loading="lazy"><span></span>`;
      item.querySelector("img").src = attachment.thumbnail;
      item.querySelector("span").textContent = `${attachment.name} · ${formatBytes(attachment.size)}${chunkLabel}`;
    } else {
      item.textContent = `${attachment.name} · ${formatBytes(attachment.size)}${chunkLabel}`;
    }
    list.append(item);
  }

  return list;
}

function imageAttachments(attachments) {
  return attachments.filter((attachment) => attachment.thumbnail && attachment.imagePreview);
}

function openFilePicker() {
  if (state.uploadActive) return;
  fileInput.value = "";
  if (typeof fileInput.showPicker === "function") {
    try {
      fileInput.showPicker();
      return;
    } catch {
      // Some mobile browsers expose showPicker but reject it for hidden inputs.
    }
  }
  fileInput.click();
}

function setBusy(isBusy) {
  state.busy = isBusy;
  sendButton.disabled = isBusy || state.offlineMode;
  sendButton.hidden = isBusy;
  if (stopButton) {
    stopButton.hidden = !isBusy;
  }
  renderVoiceInputButton();
  renderSelectionQuoteButton();
  updateSeekReferenceControls();
  if (!isBusy) {
    setOutputPaused(false);
  } else {
    state.outputPaused = false;
    renderPauseButton();
  }
  syncVisibleAssistantActions();
}

function syncVisibleAssistantActions() {
  for (const node of chatLog.querySelectorAll(".message.assistant[data-message-id]")) {
    const message = state.messages.find((item) => item.id === node.dataset.messageId);
    const bubble = node.querySelector(".bubble");
    if (message && bubble) {
      syncAssistantActions(bubble, message);
    }
  }
}

function setOutputPaused(isPaused) {
  state.outputPaused = state.busy && isPaused;
  if (!state.outputPaused && typeof state.resumeStreaming === "function") {
    const resume = state.resumeStreaming;
    state.resumeStreaming = null;
    resume();
  }
  renderPauseButton();
}

function renderPauseButton() {
  if (!pauseButton) return;
  pauseButton.hidden = !state.busy;
  pauseButton.classList.toggle("paused", state.outputPaused);
  pauseButton.setAttribute("aria-pressed", String(state.outputPaused));
  pauseButton.setAttribute("aria-label", state.outputPaused ? "继续输出" : "暂停输出");
  pauseButton.title = state.outputPaused ? "继续输出" : "暂停输出";
}

function waitUntilOutputResumed() {
  if (!state.outputPaused) return Promise.resolve();
  return new Promise((resolve) => {
    state.resumeStreaming = resolve;
  });
}

function handleStreamEvent(event, assistantMessage) {
  const eventIndex = Number(event?.index);
  if (Number.isFinite(eventIndex)) {
    const lastIndex = Number(assistantMessage.agentRunLastEventIndex);
    if (Number.isFinite(lastIndex) && eventIndex <= lastIndex) return;
    assistantMessage.agentRunLastEventIndex = eventIndex;
    if (event.runId) assistantMessage.agentRunId = String(event.runId);
  }

  if (event.type === "error") {
    assistantMessage.agentRunStatus = "failed";
    throw new Error(event.error || "流式响应失败");
  }

  if (event.type === "run_status") {
    assistantMessage.agentRunStatus = event.status || assistantMessage.agentRunStatus || "";
    if (event.status === "awaiting_plan" && !assistantMessage.content) {
      assistantMessage.content = "Agent 计划已生成，等待确认执行。";
    }
    updateStreamingMessage(assistantMessage);
    persistMessages();
    return;
  }

  if (event.type === "agent_plan") {
    assistantMessage.agentRunPlan = Array.isArray(event.plan) ? event.plan : [];
    assistantMessage.agentAutoPlanLabel = event.label || "";
    updateStreamingMessage(assistantMessage);
    persistMessages();
    return;
  }

  if (event.type === "final_reset") {
    if (event.scope === "final_answer") {
      assistantMessage.content = "";
      assistantMessage.diagnostics = null;
      delete assistantMessage.completedAt;
      updateStreamingMessage(assistantMessage, { immediate: true });
      persistMessages();
    }
    return;
  }

  if (event.type === "agent_reset") {
    resetTimelineAgentPhase(assistantMessage, event.phase);
    assistantMessage.diagnostics = null;
    updateStreamingMessage(assistantMessage, { immediate: true });
    persistMessages();
    return;
  }

  if (event.type === "agent_output") {
    return;
  }

  if (event.type === "reasoning") {
    const text = event.text || "";
    assistantMessage.reasoning += text;
    // 多 Agent 模式里 reasoning/content 会交错（Planner 输出 JSON → worker 又开始思考 → ...），
    // 第一次 content 就钉死的 reasoningEndedAt 不能反映"还在继续思考"。流式状态下收到新的
    // reasoning，恢复计时；最终的 reasoningEndedAt 会被最后一次 content 重新设置。
    if (assistantMessage.streaming && assistantMessage.reasoningEndedAt) {
      delete assistantMessage.reasoningEndedAt;
    }
    appendTimelineReasoning(assistantMessage, text);
    updateStreamingMessage(assistantMessage);
    return;
  }

  if (event.type === "system_note") {
    const text = String(event.text || "").trim();
    if (text) {
      if (!Array.isArray(assistantMessage.systemNotes)) {
        assistantMessage.systemNotes = [];
      }
      assistantMessage.systemNotes.push(text);
    }
    updateStreamingMessage(assistantMessage);
    return;
  }

  if (event.type === "content") {
    markReasoningEnded(assistantMessage);
    assistantMessage.content += event.text || "";
    updateStreamingMessage(assistantMessage);
    return;
  }

  if (event.type === "search") {
    assistantMessage.search = event.search || null;
    mergeSearchIntoTimeline(assistantMessage, assistantMessage.search);
    updateStreamingMessage(assistantMessage);
    return;
  }

  if (event.type === "agent") {
    appendTimelineAgent(assistantMessage, event);
    updateStreamingMessage(assistantMessage);
    return;
  }

  if (event.type === "agent_delta") {
    // v1.2.4：worker 的 content 走 agent_delta，按 phase 累积到对应 Agent 卡片的 output 字段，
    // 不再拼进主聊天正文。reasoning 计时器恢复逻辑也照抄一份，否则 worker 流式时计时会卡。
    if (assistantMessage.streaming && assistantMessage.reasoningEndedAt) {
      delete assistantMessage.reasoningEndedAt;
    }
    appendTimelineAgentDelta(assistantMessage, event);
    updateStreamingMessage(assistantMessage);
    return;
  }

  if (event.type === "agent_reasoning") {
    // v1.2.5：worker reasoning 留在各自 Agent 卡片里，避免 coder/reasoner 并行时挤进全局思考区。
    if (assistantMessage.streaming && assistantMessage.reasoningEndedAt) {
      delete assistantMessage.reasoningEndedAt;
    }
    appendTimelineAgentReasoning(assistantMessage, event);
    updateStreamingMessage(assistantMessage);
    return;
  }

  if (event.type === "agent_note") {
    appendTimelineAgentNote(assistantMessage, event);
    updateStreamingMessage(assistantMessage);
    return;
  }

  if (event.type === "agent_search") {
    // v1.2.4：worker 阶段的搜索带 phase 转成 agent_search，避免不同 Agent 的 round 1/2 互相覆盖
    mergeAgentSearchIntoTimeline(assistantMessage, event);
    updateStreamingMessage(assistantMessage);
    return;
  }

  if (event.type === "memory_suggestion") {
    handleMemorySuggestionEvent(event, assistantMessage);
    return;
  }

  if (event.type === "done") {
    assistantMessage.agentRunStatus = "done";
    assistantMessage.model = event.model || assistantMessage.model;
    const hadContentBeforeDone = Boolean(String(assistantMessage.content || "").trim());
    if (assistantMessage._continuing) {
      const contentStart = Number(assistantMessage._requestContentStart) || 0;
      const reasoningStart = Number(assistantMessage._requestReasoningStart) || 0;
      if (event.content && assistantMessage.content.length === contentStart) {
        assistantMessage.content += event.content;
      }
      if (event.reasoning && assistantMessage.reasoning.length === reasoningStart) {
        assistantMessage.reasoning += event.reasoning;
      }
    } else {
      assistantMessage.content = event.content ?? assistantMessage.content;
      assistantMessage.reasoning = event.reasoning ?? assistantMessage.reasoning;
    }
    if (!hadContentBeforeDone && String(assistantMessage.content || "").trim()) {
      markReasoningEnded(assistantMessage);
    }
    assistantMessage.usage = event.usage || {};
    assistantMessage.search = event.search ?? assistantMessage.search;
    mergeSearchIntoTimeline(assistantMessage, assistantMessage.search);
    settleStuckSearchSteps(assistantMessage);
    if (Array.isArray(event.memorySuggestions)) {
      assistantMessage.memorySuggestions = event.memorySuggestions.map(normalizeMemorySuggestion).filter(Boolean);
    }
    assistantMessage.diagnostics = event.diagnostics || null;
    updateStreamingMessage(assistantMessage);
  }
}

function markReasoningEnded(message) {
  if (message && !message.reasoningEndedAt) {
    message.reasoningEndedAt = Date.now();
  }
}

function updateStreamingMessage(message, { immediate = false } = {}) {
  if (!message?.id) return;
  if (immediate || !message.streaming) {
    pendingStreamingMessageIds.delete(message.id);
    renderStreamingMessage(message);
    return;
  }

  pendingStreamingMessageIds.add(message.id);
  if (streamingRenderFrame) return;
  streamingRenderFrame = requestAnimationFrame(flushStreamingMessageUpdates);
}

function flushStreamingMessageUpdates() {
  const messageIds = Array.from(pendingStreamingMessageIds);
  pendingStreamingMessageIds.clear();
  streamingRenderFrame = 0;
  for (const messageId of messageIds) {
    const message = state.messages.find((item) => item.id === messageId);
    if (message) renderStreamingMessage(message);
  }
}

function renderStreamingMessage(message) {
  const node = chatLog.querySelector(`[data-message-id="${message.id}"]`);
  if (!node) {
    render();
    renderPauseButton();
    return;
  }
  node.className = `message ${message.role}${message.error ? " error" : ""}`;
  const bubble = node.querySelector(".bubble");
  if (!bubble) {
    render();
    renderPauseButton();
    return;
  }
  syncActivityEntry(bubble, message);
  syncAgentPlanWorkbench(bubble, message);
  const content = bubble.querySelector(".answer-content");
  if (content) {
    const text = message.content || (message.streaming ? "正在生成回复..." : "");
    content.innerHTML = formatContent(text, { streaming: message.streaming });
    hydrateMermaidDiagrams(content);
  }
  syncVisibleAssistantActions();
  maybeAutoOpenActivityPanel(message);
  renderPauseButton();
}


function syncReasoningBody(body, message) {
  const timelineSteps = activityTimelineSteps(message);
  const usesTimeline = timelineSteps.length > 0;
  if (!usesTimeline) {
    body.querySelector(":scope > .system-note-list")?.remove();
    removeAllTimelineSteps(body);
    syncLegacyReasoning(body, message);
    return;
  }
  syncSystemNotesList(body, message);

  body.querySelector(":scope > .reasoning-legacy-text")?.remove();
  body.querySelector(":scope > .reasoning-legacy-placeholder")?.remove();
  body.querySelector(":scope > .search-sources")?.remove();

  syncAgentRunSummaryBar(body, message);

  const keys = timelineSteps.map((step, index) => activityTimelineStepKey(step, index));
  const keySet = new Set(keys);
  for (const existing of Array.from(body.querySelectorAll(":scope > [data-step-key]"))) {
    if (!keySet.has(existing.dataset.stepKey)) existing.remove();
  }

  let cursor = body.querySelector(":scope > .system-note-list")?.nextElementSibling || body.firstElementChild;
  if (cursor?.classList?.contains("system-note-list")) cursor = cursor.nextElementSibling;
  if (cursor?.classList?.contains("agent-run-summary")) cursor = cursor.nextElementSibling;

  for (let index = 0; index < timelineSteps.length; index += 1) {
    const step = timelineSteps[index];
    const key = keys[index];
    let node = body.querySelector(`:scope > [data-step-key="${cssEscape(key)}"]`);
    if (!node) {
      node = renderTimelineStep(step, message);
      if (!node) {
        console.warn("Skipping rendering for invalid timeline step:", step);
        continue;
      }
      node.dataset.stepKey = key;
      body.insertBefore(node, cursor);
    } else {
      if (step.kind === "reasoning") {
        node.dataset.text = step.text || "";
        node.innerHTML = formatContent(step.text || "", { streaming: message.streaming });
        hydrateMermaidDiagrams(node);
      } else if (step.kind === "search") {
        node.dataset.status = step.status || "";
        node.dataset.resultsCount = String(step.results?.length || 0);
        const status = ["searching", "done", "error"].includes(step.status) ? step.status : "done";
        node.className = `reasoning-search-round status-${status}`;
        const queryLabel = node.querySelector(".reasoning-search-query");
        if (queryLabel) {
          const prefix = status === "searching" ? "正在搜索" : status === "error" ? "搜索失败" : "已搜索";
          queryLabel.textContent = `${prefix}: ${step.query || "web"}`;
        }
        const errorDiv = node.querySelector(".reasoning-search-error");
        if (step.error) {
          if (!errorDiv) {
            const err = document.createElement("div");
            err.className = "reasoning-search-error";
            err.textContent = step.error;
            node.append(err);
          } else {
            errorDiv.textContent = step.error;
          }
        } else if (errorDiv) {
          errorDiv.remove();
        }
        let chips = node.querySelector(".reasoning-source-chips");
        if (Array.isArray(step.results) && step.results.length) {
          const urlsKey = step.results.map((r) => (r && r.url) || "").join("|");
          if (!chips || chips.dataset.urlsKey !== urlsKey) {
            const freshChips = renderSourceChips(step.results, message.id);
            freshChips.dataset.urlsKey = urlsKey;
            if (chips) {
              chips.replaceWith(freshChips);
            } else {
              node.append(freshChips);
            }
          }
        } else if (chips) {
          chips.remove();
        }
      } else if (step.kind === "agent") {
        const fresh = renderInlineAgentStep(step, message);
        node.className = fresh.className;
        node.replaceChildren(...Array.from(fresh.childNodes));
        node.dataset.status = step.status || "";
        node.dataset.text = step.text || "";
        node.dataset.reasoning = step.reasoning || "";
        node.dataset.notes = agentNotesSnapshot(step);
        node.dataset.collapsed = step.collapsed ? "1" : "0";
        node.dataset.output = step.output || "";
        node.dataset.duration = step.durationMs == null ? "" : String(step.durationMs);
      }
    }
    cursor = node.nextElementSibling;
  }
}

function removeAllTimelineSteps(body) {
  for (const node of Array.from(body.querySelectorAll(":scope > [data-step-key]"))) {
    node.remove();
  }
  body.querySelector(":scope > .agent-run-summary")?.remove();
}

function syncSystemNotesList(body, message) {
  const notes = systemNotesForMessage(message);
  let list = body.querySelector(":scope > .system-note-list");
  if (!notes.length) {
    list?.remove();
    return;
  }
  if (!list) {
    list = document.createElement("div");
    list.className = "system-note-list";
    body.prepend(list);
  }
  const existingNotes = list.querySelectorAll(":scope > .system-note");
  if (existingNotes.length === notes.length) {
    notes.forEach((note, idx) => {
      const el = existingNotes[idx];
      if (el.dataset.rawText !== note) {
        el.dataset.rawText = note;
        el.innerHTML = formatContent(note);
      }
    });
  } else {
    list.replaceChildren();
    notes.forEach((note) => {
      const el = document.createElement("div");
      el.className = "system-note";
      el.dataset.rawText = note;
      el.innerHTML = formatContent(note);
      list.append(el);
    });
  }
}

function syncLegacyReasoning(body, message) {
  if (message.search) {
    let searchBlock = body.querySelector(":scope > .search-sources");
    if (!searchBlock) {
      searchBlock = renderSearchBlock(message.search, message.streaming, message.id);
      body.prepend(searchBlock);
    } else {
      const freshBlock = renderSearchBlock(message.search, message.streaming, message.id);
      searchBlock.replaceWith(freshBlock);
    }
  } else {
    body.querySelector(":scope > .search-sources")?.remove();
  }

  if (message.reasoning) {
    let textNode = body.querySelector(":scope > .reasoning-legacy-text");
    if (!textNode) {
      textNode = document.createElement("div");
      textNode.className = "reasoning-legacy-text content";
      body.append(textNode);
    }
    if (textNode.dataset.text !== message.reasoning) {
      textNode.dataset.text = message.reasoning;
      textNode.innerHTML = formatContent(message.reasoning, { streaming: message.streaming });
      hydrateMermaidDiagrams(textNode);
    }
  } else {
    body.querySelector(":scope > .reasoning-legacy-text")?.remove();
    if (message.streaming) {
      let placeholder = body.querySelector(":scope > .reasoning-legacy-placeholder");
      if (!placeholder) {
        placeholder = document.createElement("div");
        placeholder.className = "reasoning-legacy-placeholder muted";
        placeholder.textContent = "等待模型返回推理内容...";
        body.append(placeholder);
      }
    } else {
      body.querySelector(":scope > .reasoning-legacy-placeholder")?.remove();
    }
  }
}

function syncAgentRunSummaryBar(body, message) {
  const summary = agentRunSummary(message);
  let bar = body.querySelector(":scope > .agent-run-summary");
  if (summary.count === 0) {
    bar?.remove();
    return;
  }
  const signature = agentRunSummarySignature(summary);
  if (!bar) {
    bar = renderAgentRunSummary(summary);
    bar.dataset.summary = signature;
    const list = body.querySelector(":scope > .system-note-list");
    if (list) {
      list.after(bar);
    } else {
      body.prepend(bar);
    }
  } else if (bar.dataset.summary !== signature) {
    const freshBar = renderAgentRunSummary(summary);
    freshBar.dataset.summary = signature;
    bar.replaceWith(freshBar);
  }
}

function renderAgentRunSummary(summary) {
  const container = document.createElement("div");
  container.className = "agent-run-summary";
  const label = document.createElement("span");
  label.className = "agent-run-summary-label";
  label.textContent = `${summary.count} 个 Agent`;
  container.append(label);
  summary.items.forEach((item) => {
    const sep = document.createElement("span");
    sep.className = "agent-run-summary-sep";
    sep.textContent = " · ";
    container.append(sep);
    const chip = document.createElement("span");
    chip.className = `agent-run-summary-item status-${item.status}`;
    let statusIcon = "";
    if (item.status === "running") statusIcon = " ⏳";
    else if (item.status === "error") statusIcon = " ✕";
    else statusIcon = " ✓";
    chip.textContent = `${item.label}${statusIcon}`;
    container.append(chip);
  });
  return container;
}

function renderTimelineStep(step, message) {
  if (!step) return null;
  if (step.kind === "search") return renderInlineSearchRound(step, message);
  if (step.kind === "agent") return renderInlineAgentStep(step, message);
  const node = document.createElement("div");
  node.className = "reasoning-text content";
  node.innerHTML = formatContent(step.text || "", { streaming: message.streaming });
  hydrateMermaidDiagrams(node);
  return node;
}

function renderInlineAgentStep(step, message) {
  const status = ["running", "done", "error"].includes(step.status) ? step.status : "done";
  const reasoning = step.reasoning || "";
  const notes = normalizeAgentNotes(step.notes);
  const output = step.output || "";
  const showLiveAgentInfo = status === "running";
  const showDetailedAgentInfo = state.agentDisplayMode === "detailed" || showLiveAgentInfo;
  const hasDetails = Boolean(output || (showDetailedAgentInfo && (reasoning || notes.length)));
  const collapsed = Boolean(step.collapsed && status !== "running" && hasDetails);
  const node = document.createElement("div");
  node.className = `reasoning-agent-step status-${status}`;
  if (collapsed) node.classList.add("is-collapsed");

  const title = document.createElement("div");
  title.className = "reasoning-agent-title";
  const name = document.createElement("strong");
  name.textContent = step.name || "Agent";
  const meta = document.createElement("div");
  meta.className = "reasoning-agent-meta";
  const stateText = document.createElement("span");
  stateText.textContent = status === "running" ? "工作中" : status === "error" ? "失败" : "已完成";
  meta.append(stateText);
  const durationLabel = status !== "running" ? formatAgentDuration(step.durationMs) : "";
  if (durationLabel) {
    const dot = document.createElement("span");
    dot.className = "reasoning-agent-meta-sep";
    dot.textContent = " · ";
    const duration = document.createElement("span");
    duration.className = "reasoning-agent-duration";
    duration.textContent = durationLabel;
    meta.append(dot, duration);
  }
  if (hasDetails && status !== "running") {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "reasoning-agent-toggle";
    toggle.dataset.agentToggle = message.id || "";
    toggle.dataset.agentStep = step.id || agentStepId(step.phase || "agent");
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.textContent = collapsed ? "展开" : "折叠";
    meta.append(toggle);
  }
  if (message.agentRunId && step.phase && step.phase !== "leader" && status !== "running") {
    const rerun = document.createElement("button");
    rerun.type = "button";
    rerun.className = "reasoning-agent-toggle";
    rerun.dataset.agentRerun = message.id || "";
    rerun.dataset.agentPhase = step.phase || "";
    rerun.textContent = status === "error" ? "重试" : "重跑";
    meta.append(rerun);
  }
  title.append(name, meta);
  node.append(title);

  const text = step.text || "";
  if (collapsed) return node;
  if (text && !output && !reasoning && !notes.length) {
    const note = document.createElement("div");
    note.className = "reasoning-agent-note";
    note.textContent = text;
    node.append(note);
  } else if (text) {
    const note = document.createElement("div");
    note.className = "reasoning-agent-note muted";
    note.textContent = text;
    node.append(note);
  } else if (status === "running") {
    const note = document.createElement("div");
    note.className = "reasoning-agent-note pending";
    note.textContent = "正在思考…";
    node.append(note);
  }
  if (showDetailedAgentInfo && notes.length) {
    const list = document.createElement("div");
    list.className = "reasoning-agent-notes";
    for (const item of notes) {
      const note = document.createElement("div");
      note.className = "reasoning-agent-tool-note";
      note.textContent = item;
      list.append(note);
    }
    node.append(list);
  }
  if (showDetailedAgentInfo && reasoning) {
    const thought = document.createElement("div");
    thought.className = "reasoning-agent-thought content";
    thought.innerHTML = formatContent(reasoning, { streaming: message.streaming });
    hydrateMermaidDiagrams(thought);
    node.append(thought);
  }
  if (output) {
    const content = document.createElement("div");
    content.className = "reasoning-agent-content content";
    content.innerHTML = formatContent(output, { streaming: message.streaming });
    hydrateMermaidDiagrams(content);
    node.append(content);
  }
  return node;
}


function appendTimelineReasoning(message, text) {
  if (!text) return;
  if (!Array.isArray(message.timeline)) message.timeline = [];
  const last = message.timeline[message.timeline.length - 1];
  if (last?.kind === "reasoning") {
    last.text = `${last.text || ""}${text}`;
  } else {
    message.timeline.push({ kind: "reasoning", text });
  }
}

function mergeSearchIntoTimeline(message, search) {
  const rounds = searchRounds(search);
  if (!rounds.length) return;
  if (!Array.isArray(message.timeline)) message.timeline = [];
  for (const round of rounds) {
    const roundNumber = Number(round.round) || 0;
    if (!roundNumber) continue;
    const snapshot = {
      kind: "search",
      round: roundNumber,
      query: String(round.query || ""),
      status: ["searching", "done", "error"].includes(round.status) ? round.status : "done",
      error: String(round.error || ""),
      results: Array.isArray(round.results) ? round.results : [],
    };
    const index = message.timeline.findIndex((step) => step.kind === "search" && Number(step.round) === roundNumber);
    if (index >= 0) {
      message.timeline[index] = snapshot;
    } else {
      message.timeline.push(snapshot);
    }
  }
}

function mergeAgentSearchIntoTimeline(message, event) {
  // worker 阶段的搜索：合并到 timeline，但 step.phase 标注是哪个 Agent 触发的，
  // 这样 timelineStepKey 不会让不同 Agent 的同一轮 search 互相覆盖。
  const search = event?.search;
  const rounds = searchRounds(search);
  if (!rounds.length) return;
  if (!Array.isArray(message.timeline)) message.timeline = [];
  const phase = String(event?.phase || "main").slice(0, 80);
  for (const round of rounds) {
    const roundNumber = Number(round.round) || 0;
    if (!roundNumber) continue;
    const snapshot = {
      kind: "search",
      phase,
      round: roundNumber,
      query: String(round.query || ""),
      status: ["searching", "done", "error"].includes(round.status) ? round.status : "done",
      error: String(round.error || ""),
      results: Array.isArray(round.results) ? round.results : [],
    };
    const index = message.timeline.findIndex(
      (step) =>
        step.kind === "search" &&
        Number(step.round) === roundNumber &&
        String(step.phase || "main") === phase,
    );
    if (index >= 0) {
      message.timeline[index] = snapshot;
    } else {
      message.timeline.push(snapshot);
    }
  }
}

function settleStuckSearchSteps(message, errorText = "搜索连接中断或超时") {
  if (!message) return false;
  let changed = settleStuckSearchData(message.search, errorText);
  if (Array.isArray(message.timeline)) {
    for (const step of message.timeline) {
      if (step?.kind !== "search" || step.status !== "searching") continue;
      step.status = "error";
      step.error = step.error || errorText;
      changed = true;
    }
  }
  return changed;
}

function settleStuckSearchData(search, errorText) {
  if (!search || typeof search !== "object") return false;
  let changed = false;
  if (Array.isArray(search.rounds)) {
    for (const round of search.rounds) {
      if (!round || typeof round !== "object" || round.status !== "searching") continue;
      round.status = "error";
      round.error = round.error || errorText;
      changed = true;
    }
  }
  if (search.status === "searching") {
    search.status = "error";
    search.error = search.error || errorText;
    changed = true;
  }
  return changed;
}


function renderInlineSearchRound(round, message) {
  const node = document.createElement("div");
  const status = ["searching", "done", "error"].includes(round.status) ? round.status : "done";
  node.className = `reasoning-search-round status-${status}`;

  const header = document.createElement("div");
  header.className = "reasoning-search-header";

  const icon = document.createElement("span");
  icon.className = "reasoning-search-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.append(createSearchStatusSvg(status));

  const label = document.createElement("span");
  label.className = "reasoning-search-query";
  const prefix = status === "searching" ? "正在搜索" : status === "error" ? "搜索失败" : "已搜索";
  label.textContent = `${prefix}: ${round.query || "web"}`;
  header.append(icon, label);
  node.append(header);

  if (round.error) {
    const error = document.createElement("div");
    error.className = "reasoning-search-error";
    error.textContent = round.error;
    node.append(error);
  }
  if (Array.isArray(round.results) && round.results.length) {
    node.append(renderSourceChips(round.results, message.id));
  }
  return node;
}

function createSearchStatusSvg(status) {
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");

  const make = (tag, attrs) => {
    const element = document.createElementNS(svgNS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      element.setAttribute(key, value);
    }
    return element;
  };

  if (status === "searching") {
    svg.append(make("circle", { cx: "12", cy: "12", r: "9", "stroke-dasharray": "42 14" }));
  } else if (status === "error") {
    svg.append(make("path", { d: "M6 6l12 12" }), make("path", { d: "M6 18 18 6" }));
  } else {
    svg.append(make("circle", { cx: "11", cy: "11", r: "7" }), make("path", { d: "m16.5 16.5 4 4" }));
  }
  return svg;
}

function renderSourceChips(results, messageId) {
  const chips = document.createElement("div");
  chips.className = "reasoning-source-chips";
  const visible = results.slice(0, 3);
  for (const result of visible) {
    const chip = document.createElement("a");
    chip.className = "reasoning-source-chip";
    chip.href = result.url || "#";
    chip.target = "_blank";
    chip.rel = "noopener noreferrer";
    chip.title = result.title || result.url || "";
    const favicon = document.createElement("img");
    favicon.className = "reasoning-source-favicon";
    favicon.alt = "";
    favicon.loading = "lazy";
    favicon.referrerPolicy = "no-referrer";
    favicon.src = isHttpUrl(result.favicon) ? result.favicon : FAVICON_FALLBACK_SRC;
    attachFaviconFallback(favicon);
    const label = document.createElement("span");
    label.textContent = domainFromUrl(result.url) || result.title || "source";
    chip.append(favicon, label);
    chips.append(chip);
  }
  if (results.length > visible.length) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "reasoning-source-chip reasoning-source-more";
    more.dataset.searchResults = messageId;
    more.textContent = `+${results.length - visible.length}`;
    chips.append(more);
  }
  return chips;
}

function domainFromUrl(url) {
  try {
    if (!url) return "";
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const FAVICON_FALLBACK_SRC = "data:image/svg+xml;utf8," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
  '<rect width="24" height="24" fill="#1e293b"/>' +
  '<circle cx="12" cy="12" r="6.5" fill="none" stroke="#94a3b8" stroke-width="1.4"/>' +
  '<path d="M5.5 12h13M12 5.5c2.4 2.6 2.4 10.4 0 13M12 5.5c-2.4 2.6-2.4 10.4 0 13" ' +
  'fill="none" stroke="#94a3b8" stroke-width="1.1" stroke-linecap="round"/>' +
  '</svg>'
);

function attachFaviconFallback(img) {
  img.addEventListener("error", () => {
    if (img.dataset.fallback === "1") return;
    img.dataset.fallback = "1";
    img.src = FAVICON_FALLBACK_SRC;
  });
}

function faviconUrlFor(_url) {
  return FAVICON_FALLBACK_SRC;
}

function cssEscape(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
}

function reasoningBodyHtml(message) {
  const notes = systemNotesForMessage(message);
  const noteHtml = notes.length
    ? `<div class="system-note-list">${notes.map((note) => `<div class="system-note">${formatContent(note)}</div>`).join("")}</div>`
    : "";
  if (message.reasoning) return `${noteHtml}${formatContent(message.reasoning, { streaming: message.streaming })}`;
  if (message.interrupted) return `${noteHtml}${formatContent("生成已中断。点击“继续生成”可以从当前位置接着完成回答。")}`;
  if (noteHtml) return `${noteHtml}${message.streaming ? formatContent("等待模型返回推理内容...") : ""}`;
  return formatContent("等待模型返回推理内容...");
}

function systemNotesForMessage(message) {
  return Array.isArray(message.systemNotes)
    ? message.systemNotes.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20)
    : [];
}

function reasoningSummaryText(message) {
  if (message.interrupted) return "已停止";
  const seconds = reasoningElapsedSeconds(message);
  if (message.streaming) {
    return seconds > 0 ? `思考中 ${formatReasoningDuration(seconds)}` : "思考中";
  }
  const searchCount = timelineSearchCount(message);
  const searchSuffix = searchCount ? ` · 搜索 ${searchCount} 次` : "";
  if (seconds) return `已思考 ${formatReasoningDuration(seconds)}${searchSuffix}`;
  return `已思考${searchSuffix}`;
}

function formatReasoningDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  if (value < 60) return `${value}s`;
  const m = Math.floor(value / 60);
  const s = value % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function reasoningElapsedSeconds(message) {
  const startedAt = Number(message.createdAt) || 0;
  const endedAt = Number(message.reasoningEndedAt) || Number(message.completedAt) || 0;
  if (startedAt && endedAt && endedAt >= startedAt) {
    return Math.max(1, Math.round((endedAt - startedAt) / 1000));
  }
  // 流式状态：返回从消息创建到现在的累计秒数
  if (message.streaming && startedAt) {
    return Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  }
  return 0;
}

function timelineSearchCount(message) {
  const rounds = new Set();
  for (const step of Array.isArray(message?.timeline) ? message.timeline : []) {
    if (step?.kind === "search" && step.round) rounds.add(Number(step.round));
  }
  return rounds.size || searchRounds(message?.search).length;
}

function renderSearchBlock(search, streaming, messageId) {
  const block = document.createElement("section");
  block.className = "search-sources";

  const results = searchResults(search);
  const rounds = searchRounds(search);
  const status = document.createElement("div");
  status.className = "search-status-line";

  const icon = document.createElement("span");
  icon.className = "search-status-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m16.5 16.5 4 4" />
    </svg>
  `;

  const title = document.createElement("strong");
  if (search.status === "searching") {
    const activeRound = rounds.find((round) => round.status === "searching")?.round || rounds.length || 1;
    title.textContent = `正在进行第 ${activeRound} 轮搜索`;
  } else if (search.status === "error") {
    title.textContent = "搜索失败，继续回答";
  } else {
    title.textContent = `搜索到 ${results.length} 个网页`;
  }
  status.append(icon, title);
  if (rounds.length) {
    const count = document.createElement("span");
    count.className = "search-round-count";
    count.textContent = `已搜索 ${rounds.length} 次`;
    status.append(count);
  }
  block.append(status);

  const body = document.createElement("div");
  body.className = "search-body";

  if (search.reason) {
    const reason = document.createElement("p");
    reason.className = "search-answer";
    reason.textContent = `${search.cached ? "已使用缓存 · " : ""}触发原因：${search.reason}`;
    body.append(reason);
  }

  if (rounds.length > 1 || rounds.some((round) => round.status === "searching" || round.status === "error")) {
    body.append(renderSearchRounds(rounds));
  } else if (search.query && (streaming || search.status !== "done")) {
    const query = document.createElement("p");
    query.className = "search-query";
    query.textContent = `搜索：${search.query}`;
    body.append(query);
  }

  if (search.error) {
    const error = document.createElement("p");
    error.className = "search-error";
    error.textContent = search.error;
    body.append(error);
  }

  if (search.status === "searching" && results.length === 0 && !search.answer) {
    const pending = document.createElement("p");
    pending.className = "search-answer";
    pending.textContent = "正在获取网页来源，拿到结果后会继续整理回答。";
    body.append(pending);
  }

  if (results.length) {
    body.append(renderSearchInlineResults(search, messageId));
  }

  if (search.answer) {
    const answer = document.createElement("p");
    answer.className = "search-answer";
    answer.textContent = search.answer;
    body.append(answer);
  }

  block.append(body);
  return block;
}

function renderSearchRounds(rounds) {
  const list = document.createElement("div");
  list.className = "search-rounds";

  for (const [index, round] of rounds.entries()) {
    const item = document.createElement("div");
    item.className = `search-round ${round.status || "done"}`;

    const label = document.createElement("span");
    label.className = "search-round-label";
    label.textContent = `第 ${round.round || index + 1} 轮`;

    const query = document.createElement("span");
    query.className = "search-round-query";
    query.textContent = round.query || "搜索网页";

    const status = document.createElement("span");
    status.className = "search-round-state";
    status.textContent = searchRoundStatusText(round);

    item.append(label, query, status);

    if (round.error) {
      const error = document.createElement("p");
      error.className = "search-error";
      error.textContent = round.error;
      item.append(error);
    }

    list.append(item);
  }

  return list;
}

function searchRoundStatusText(round) {
  if (round.status === "searching") return "搜索中";
  if (round.status === "error") return "失败";
  const count = Array.isArray(round.results) ? round.results.length : 0;
  return count ? `${count} 个网页` : "完成";
}

function renderSearchInlineResults(search, messageId) {
  const results = searchResults(search);
  const row = document.createElement("div");
  row.className = "search-browse-line";

  const prefix = document.createElement("span");
  prefix.className = "search-browse-prefix";
  prefix.textContent = `浏览 ${results.length} 个页面`;
  row.append(prefix);

  const links = document.createElement("span");
  links.className = "search-inline-links";
  for (const result of results.slice(0, 4)) {
    const link = document.createElement("a");
    link.href = result.url || "#";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = result.title || result.url || "网页结果";
    links.append(link);
  }
  row.append(links);

  if (messageId) {
    const viewAll = document.createElement("button");
    viewAll.type = "button";
    viewAll.className = "search-view-all";
    viewAll.dataset.searchResults = messageId;
    viewAll.textContent = "查看全部";
    viewAll.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openSearchPanel(search);
    });
    row.append(viewAll);
  }

  return row;
}

function searchRounds(search) {
  const rounds = Array.isArray(search?.rounds) ? search.rounds.filter((round) => round && typeof round === "object") : [];
  if (rounds.length) return rounds;
  if (!search || typeof search !== "object") return [];
  return [
    {
      round: 1,
      status: search.status || "done",
      query: search.query || "",
      answer: search.answer || "",
      error: search.error || "",
      results: Array.isArray(search.results) ? search.results : [],
    },
  ];
}

function searchResults(search) {
  if (Array.isArray(search?.results) && search.results.length) return search.results;
  const results = [];
  const seen = new Set();
  for (const round of searchRounds(search)) {
    for (const result of Array.isArray(round.results) ? round.results : []) {
      const key = result.url || result.title || JSON.stringify(result);
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ ...result, round: round.round });
    }
  }
  return results;
}

function shouldShowReasoning(message) {
  return Boolean(message.reasoning) || Boolean(message.timeline?.length) || Boolean(systemNotesForMessage(message).length) || Boolean(message.search) || Boolean(message.interrupted) || Boolean(message.agentMode && message.streaming) || (message.streaming && (message.thinking || message.model === "deepseek-v4-pro"));
}

function activityTimelineSteps(message) {
  const timeline = Array.isArray(message?.timeline) ? message.timeline : [];
  const hasReasoningStep = timeline.some((step) => step?.kind === "reasoning" && String(step.text || "").trim());
  const fallbackReasoning = String(message?.reasoning || "").trim();
  // 多 Agent 会从 Leader reasoning 切到 worker timeline；如果 Leader 文本只落在
  // message.reasoning，仍补回 Activity，避免切到 worker 后面板变成空壳。
  if (fallbackReasoning && !hasReasoningStep) {
    return [{ kind: "reasoning", text: fallbackReasoning, fallback: true }, ...timeline];
  }
  return timeline;
}

function activityTimelineStepKey(step, index) {
  if (step?.fallback && step.kind === "reasoning") return fallbackReasoningStepKey;
  return timelineStepKey(step, index);
}

function messageHasActivity(message) {
  return shouldShowReasoning(message) || Boolean(message?.search);
}

function startNewConversation() {
  // 流式生成期间切换/新建会让在途请求写进错误的对话且 busy 卡死，必须先停止（与其它变更动作一致）。
  if (state.busy) {
    showToast("正在生成回复，请先停止再新建对话");
    return;
  }
  state.currentConversationId = null;
  state.editingConversationId = null;
  state.editingMessageId = null;
  state.messages = [];
  resetMotionState();
  state.pendingAttachments = [];
  state.uploadingAttachments = [];
  state.quoteDraft = null;
  clearSelectionQuoteState({ render: false });
  localStorage.removeItem(storageKeys.currentConversation);
  clearDraft();
  promptInput.value = "";
  renderAttachmentList();
  renderQuotePreview();
  render();
  renderHistoryList();
  promptInput.focus();
}

function openConversation(id) {
  const conversation = state.conversations.find((item) => item.id === id);
  if (!conversation) return;
  // 切换对话会用目标对话覆盖 state.messages；流式生成中这么做会破坏在途请求并卡住 busy。
  if (state.busy) {
    showToast("正在生成回复，请先停止再切换对话");
    return;
  }
  state.currentConversationId = conversation.id;
  state.editingMessageId = null;
  state.pendingAttachments = [];
  state.uploadingAttachments = [];
  state.quoteDraft = null;
  state.activeActivityMessageId = "";
  clearSelectionQuoteState({ render: false });
  closeActivityPanel();
  closeSearchPanel();
  closeFilePreview();
  closeMemoryPanel();
  closeDiagnosticsPanel();
  state.messages = conversation.messages.map((message) => ({ ...message, streaming: false }));
  resetMotionState();
  state.model = normalizeModel(conversation.model);
  state.thinkingEnabled = Boolean(conversation.thinkingEnabled ?? (state.model === modelRoutes.expert));
  const restoredSeek = findSeekById(conversation.seekId);
  state.activeSeekId = restoredSeek ? restoredSeek.id : "";
  if (!restoredSeek && conversation.seekId) {
    conversation.seekId = "";
    saveConversations();
  }
  if (state.activeSeekId) {
    localStorage.setItem(storageKeys.activeSeek, state.activeSeekId);
  } else {
    localStorage.removeItem(storageKeys.activeSeek);
  }
  localStorage.setItem(storageKeys.currentConversation, conversation.id);
  localStorage.setItem(storageKeys.model, state.model);
  localStorage.setItem(storageKeys.thinkingEnabled, state.thinkingEnabled ? "1" : "0");
  renderModelTabs();
  renderSeekPanel();
  renderAttachmentList();
  renderQuotePreview();
  render();
  renderHistoryList();
  closeHistory();
}

function clearCurrentConversation() {
  if (state.currentConversationId) {
    state.conversations = state.conversations.filter((item) => item.id !== state.currentConversationId);
  }
  state.currentConversationId = null;
  state.editingMessageId = null;
  state.messages = [];
  state.activeActivityMessageId = "";
  resetMotionState();
  state.pendingAttachments = [];
  state.uploadingAttachments = [];
  state.quoteDraft = null;
  clearSelectionQuoteState();
  closeActivityPanel();
  clearDraft();
  renderAttachmentList();
  renderQuotePreview();
  saveConversations();
  renderHistoryList();
}

function forkConversationFromMessage(messageId) {
  if (state.busy) return;
  const index = state.messages.findIndex((message) => message.id === messageId && message.role === "assistant");
  if (index < 0) return;
  const sourceConversation = currentConversation();
  const branchMessages = state.messages.slice(0, index + 1).map((message) => ({
    ...message,
    streaming: false,
    branchSourceId: message.id,
  }));
  const sourceMessage = state.messages[index];
  const branch = createConversation(branchMessages);
  branch.title = normalizeTitle(`分支：${sourceConversation?.title || titleFromMessages(branchMessages)}`);
  branch.customTitle = true;
  branch.branchParentId = sourceConversation?.id || "";
  branch.branchFromMessageId = sourceMessage.id;
  branch.branchLabel = messagePreview(sourceMessage);
  branch.favorite = Boolean(sourceConversation?.favorite);
  branch.tags = normalizeTags(sourceConversation?.tags || []);
  branch.updatedAt = Date.now();
  state.conversations.unshift(branch);
  state.currentConversationId = branch.id;
  state.messages = branch.messages.map((message) => ({ ...message, streaming: false }));
  resetMotionState();
  state.quoteDraft = null;
  clearSelectionQuoteState({ render: false });
  clearContextSummary();
  saveConversations();
  render();
  renderHistoryList();
  showToast("已从这条回复创建分支");
}

function quoteMessageForReply(messageId) {
  const message = state.messages.find((item) => item.id === messageId);
  if (!message) return;
  const quote = messagePreviewForQuote(message);
  state.quoteDraft = {
    messageId: message.id,
    role: message.role,
    text: quote,
  };
  clearSelectionQuoteState();
  renderQuotePreview();
  promptInput.focus();
  saveDraft();
}

function setMessageFeedback(messageId, value) {
  const message = state.messages.find((item) => item.id === messageId && item.role === "assistant");
  if (!message || !["up", "down"].includes(value)) return;
  message.feedback = message.feedback === value ? "" : value;
  persistMessages();
  updateStreamingMessage(message);
  haptic("light");
  showToast(message.feedback ? "已记录反馈" : "已取消反馈");
}

async function openCitationForMessage(messageId, citationId) {
  const id = String(citationId || "").trim();
  const webMatch = id.match(/^W(\d+)$/i);
  if (webMatch) {
    const assistantMessage = state.messages.find((message) => message.id === messageId && message.role === "assistant");
    const results = webCitationResults(assistantMessage?.search);
    const target = results.find((result) => String(result.citation_id || "").toLowerCase() === id.toLowerCase()) || results[Number(webMatch[1]) - 1];
    if (target?.url) {
      window.open(target.url, "_blank", "noopener,noreferrer");
    } else {
      showToast("没有找到这个来源对应的链接");
    }
    return;
  }

  const match = id.match(/^F(\d+)-(\d+)$/i);
  if (!match) return;
  const assistantIndex = state.messages.findIndex((message) => message.id === messageId);
  const userMessage = state.messages.slice(0, assistantIndex).reverse().find((message) => message.role === "user");
  const fileIndex = Number(match[1]) - 1;
  const chunkIndex = Number(match[2]);
  const attachment = combinedAttachmentsForMessage(userMessage || {})[fileIndex];
  if (!attachment?.fileId) {
    showToast("没有找到这个引用对应的文件");
    return;
  }
  try {
    const response = await apiFetch("/api/file-chunk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId: attachment.fileId, projectId: attachment.projectId || "", chunkIndex }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "读取引用片段失败");
    const chunk = data.chunk || {};
    openFilePreview({
      ...attachment,
      preview: chunk.text || attachment.preview,
      text: chunk.text || attachment.text,
      name: `${attachment.name} · ${citationId}`,
    });
  } catch (error) {
    showToast(error.message || "读取引用片段失败");
  }
}

function webCitationResults(search) {
  const results = [];
  const seen = new Set();
  const appendResult = (result) => {
    if (!result || typeof result !== "object" || !result.url) return;
    const key = String(result.url || "").trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    results.push(result);
  };
  for (const result of searchResults(search)) {
    appendResult(result);
  }
  for (const round of searchRounds(search)) {
    for (const result of Array.isArray(round.results) ? round.results : []) {
      appendResult(result);
    }
  }
  return results;
}

function messagePreviewForQuote(message) {
  const text = String(message.content || "").replace(/\s+/g, " ").trim();
  if (!text) return "这条消息暂无正文。";
  return text.length > 600 ? `${text.slice(0, 600)}...` : text;
}

async function clearLocalBrowserData() {
  if (
    !(await confirmAction({
      title: "清空本地数据？",
      message: "清空本机浏览器保存的所有 DeepSeek Mobile 数据并退出登录？",
      okText: "清空并退出",
      danger: true,
    }))
  ) {
    return;
  }
  try {
    await apiFetch("/api/auth/logout", { method: "POST" });
  } catch {
    // Best effort: local cleanup should still proceed when the server is already unreachable.
  }
  for (const key of Object.values(storageKeys)) {
    localStorage.removeItem(key);
  }
  sessionStorage.removeItem(storageKeys.authToken);
  showToast("本地数据已清空，正在刷新。");
  window.location.replace("/");
}

async function clearConversationHistory() {
  if (!state.conversations.length) return;
  if (
    !(await confirmAction({
      title: "清空历史对话？",
      message: "清空所有历史对话？这个操作不会删除项目文档库。",
      okText: "清空",
      danger: true,
    }))
  ) {
    return;
  }
  state.conversations = [];
  state.currentConversationId = null;
  state.editingConversationId = null;
  state.editingMessageId = null;
  state.messages = [];
  resetMotionState();
  state.pendingAttachments = [];
  state.uploadingAttachments = [];
  state.quoteDraft = null;
  clearSelectionQuoteState({ render: false });
  clearDraft();
  saveConversations();
  localStorage.removeItem(storageKeys.messages);
  render();
  renderHistoryList();
  closeHistory();
}

function onHistoryListClick(event) {
  const saveButton = event.target.closest("button[data-save-conversation-title]");
  if (saveButton) {
    commitConversationTitle(saveButton.dataset.saveConversationTitle);
    return;
  }

  // 编辑/删除/收藏/标签已移到行内弹出菜单（handleHistoryMenuAction），历史列表里不再有这些 data 属性的按钮。

  const item = event.target.closest("button[data-conversation-id]");
  if (item) {
    if (item.dataset.suppressClick === "1") {
      delete item.dataset.suppressClick;
      return;
    }
    openConversation(item.dataset.conversationId);
  }
}

function onHistoryTitleSubmit(event) {
  const form = event.target.closest("form[data-title-editor]");
  if (!form) return;
  event.preventDefault();
  commitConversationTitle(form.dataset.titleEditor);
}

function onHistoryTitleKeydown(event) {
  if (event.key !== "Escape") return;
  const input = event.target.closest("input[data-title-input]");
  if (!input) return;
  state.editingConversationId = null;
  renderHistoryList();
}

function startEditConversationTitle(id) {
  const conversation = state.conversations.find((item) => item.id === id);
  if (!conversation) return;
  state.editingConversationId = id;
  renderHistoryList();

  const input = Array.from(historyList.querySelectorAll("input[data-title-input]")).find(
    (item) => item.dataset.titleInput === id
  );
  if (input) {
    input.focus();
    input.select();
  }
}

function commitConversationTitle(id) {
  const conversation = state.conversations.find((item) => item.id === id);
  if (!conversation) return;

  const input = Array.from(historyList.querySelectorAll("input[data-title-input]")).find(
    (item) => item.dataset.titleInput === id
  );
  const title = normalizeTitle(input?.value);
  if (!title) {
    showToast("标题不能为空");
    input?.focus();
    return;
  }

  conversation.title = title;
  conversation.customTitle = true;
  state.editingConversationId = null;
  saveConversations();
  renderHistoryList();
  showToast("标题已更新");
}

function deleteConversation(id) {
  state.conversations = state.conversations.filter((conversation) => conversation.id !== id);
  if (state.editingConversationId === id) {
    state.editingConversationId = null;
  }
  if (state.currentConversationId === id) {
    state.currentConversationId = null;
    state.messages = [];
    resetMotionState();
    state.quoteDraft = null;
    clearSelectionQuoteState({ render: false });
    render();
  }
  saveConversations();
  renderHistoryList();
}

function toggleConversationFavorite(id) {
  const conversation = state.conversations.find((item) => item.id === id);
  if (!conversation) return;
  conversation.favorite = !conversation.favorite;
  conversation.updatedAt = Date.now();
  saveConversations();
  renderHistoryList();
  maybeAutoGenerateTitle(conversation, conversation.messages || []);
}

function editConversationTags(id) {
  const conversation = state.conversations.find((item) => item.id === id);
  if (!conversation) return;
  const current = (conversation.tags || []).join("，");
  const next = window.prompt("输入标签，用逗号或空格分隔", current);
  if (next === null) return;
  conversation.tags = normalizeTags(next);
  conversation.updatedAt = Date.now();
  saveConversations();
  renderHistoryList();
}

function getHistoryMenuRoot() {
  if (historyMenuRoot) return historyMenuRoot;
  const root = document.createElement("div");
  root.className = "history-menu";
  root.setAttribute("role", "menu");
  root.hidden = true;
  root.innerHTML = `
    <button type="button" class="history-menu-item" data-action="favorite" role="menuitem">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 4 2.5 5.5 6 .6-4.5 4.1 1.3 5.9L12 17l-5.3 3.1 1.3-5.9L3.5 10.1l6-.6L12 4Z"/></svg>
      <span data-role="favorite-label">收藏</span>
    </button>
    <button type="button" class="history-menu-item" data-action="tag" role="menuitem">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h7l9 9-7 7-9-9V4Z"/><circle cx="9" cy="9" r="1.5"/></svg>
      <span>添加标签</span>
    </button>
    <button type="button" class="history-menu-item" data-action="rename" role="menuitem">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4-1 11-11-3-3L5 16l-1 4Z"/></svg>
      <span>重命名</span>
    </button>
    <button type="button" class="history-menu-item" data-action="regenerate-title" role="menuitem">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 14.5 9.5 21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/></svg>
      <span>重新生成标题</span>
    </button>
    <div class="history-menu-divider" role="separator"></div>
    <button type="button" class="history-menu-item history-menu-item--danger" data-action="delete" role="menuitem">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
      <span>删除</span>
    </button>
  `;
  document.body.append(root);
  root.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const item = target?.closest(".history-menu-item");
    if (!item || !activeHistoryMenu) return;
    const conversationId = activeHistoryMenu.conversationId;
    closeHistoryMenu();
    handleHistoryMenuAction(conversationId, item.dataset.action);
  });
  historyMenuRoot = root;
  return root;
}

function openHistoryMenu(anchorButton, positionAnchor = anchorButton) {
  if (activeHistoryMenu?.anchor && activeHistoryMenu.anchor !== anchorButton) {
    closeHistoryMenu();
  }
  const conversationId = anchorButton.dataset.conversationId;
  if (!conversationId) return;
  const conversation = state.conversations.find((item) => item.id === conversationId);
  const root = getHistoryMenuRoot();

  const favLabel = root.querySelector('[data-role="favorite-label"]');
  if (favLabel) favLabel.textContent = conversation?.favorite ? "取消收藏" : "收藏";

  const regenerateTitleItem = root.querySelector('[data-action="regenerate-title"]');
  if (regenerateTitleItem) regenerateTitleItem.hidden = Boolean(conversation?.customTitle);
  root.hidden = false;
  const rect = positionAnchor.getBoundingClientRect();
  const menuWidth = root.offsetWidth;
  const menuHeight = root.offsetHeight;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  let left = rect.right - menuWidth;
  let top = rect.bottom + 6;
  if (left < 8) left = Math.min(rect.left, viewportW - menuWidth - 8);
  if (top + menuHeight > viewportH - 8) top = rect.top - menuHeight - 6;

  root.style.left = `${Math.max(8, left)}px`;
  root.style.top = `${Math.max(8, top)}px`;
  anchorButton.setAttribute("aria-expanded", "true");
  anchorButton.classList.add("is-open");
  activeHistoryMenu = { conversationId, anchor: anchorButton, root };
}

function closeHistoryMenu() {
  if (!activeHistoryMenu) return;
  activeHistoryMenu.root.hidden = true;
  activeHistoryMenu.anchor.setAttribute("aria-expanded", "false");
  activeHistoryMenu.anchor.classList.remove("is-open");
  activeHistoryMenu = null;
}

function handleHistoryMenuAction(conversationId, action) {
  switch (action) {
    case "favorite":
      toggleConversationFavorite(conversationId);
      break;
    case "tag":
      editConversationTags(conversationId);
      break;
    case "rename":
      startEditConversationTitle(conversationId);
      break;
    case "regenerate-title":
      regenerateTitle(conversationId);
      break;
    case "delete":
      deleteConversation(conversationId);
      break;
  }
}

function conversationsForHistory() {
  const query = state.historySearch.trim().toLowerCase();
  return state.conversations
    .filter((conversation) => !query || conversationMatchesSearch(conversation, query))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.updatedAt - a.updatedAt);
}

function conversationMatchesSearch(conversation, query) {
  const text = [
    conversation.title,
    conversation.branchLabel,
    ...(conversation.tags || []),
    ...(conversation.messages || []).map((message) => `${message.role} ${message.content || ""} ${message.reasoning || ""}`),
  ]
    .join("\n")
    .toLowerCase();
  return text.includes(query);
}

async function searchConversations() {
  renderHistoryList();
  const query = state.historySearch.trim();
  if (!query) return;
  try {
    await apiFetch("/api/conversations/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, conversations: state.conversations }),
    });
  } catch {
    // Local filtering already provides the interactive result; the API call keeps the backend route warm.
  }
}

function renderHistoryList() {
  closeHistoryMenu();
  historyList.replaceChildren();
  const visibleConversations = conversationsForHistory();
  historyEmpty.hidden = visibleConversations.length > 0;
  historyEmpty.textContent = state.historySearch ? "没有匹配的历史对话" : "暂无历史对话";

  const fragment = document.createDocumentFragment();
  for (const conversation of visibleConversations) {
    const row = document.createElement("div");
    row.className = "history-item";
    row.classList.toggle("active", conversation.id === state.currentConversationId);
    const isEditing = conversation.id === state.editingConversationId;

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.dataset.conversationId = conversation.id;
    openButton.className = "history-open-button";

    const title = document.createElement("span");
    title.className = "history-title";
    title.classList.toggle("is-pending-title", Boolean(conversation.autoTitlePending));
    title.textContent = conversation.title || "新对话";

    const seekName = seekNameForConversation(conversation);
    const seekLabel = document.createElement("span");
    seekLabel.className = "history-seek";
    seekLabel.textContent = seekName ? `Seek · ${seekName}` : "";
    seekLabel.hidden = !seekName;

    const branchLabel = document.createElement("span");
    branchLabel.className = "history-branch";
    branchLabel.textContent = conversation.branchParentId ? `分支 · ${conversation.branchLabel || "从旧回复分叉"}` : "";
    branchLabel.hidden = !conversation.branchParentId;

    const tags = document.createElement("span");
    tags.className = "history-tags";
    tags.textContent = conversation.tags?.length ? conversation.tags.map((tag) => `#${tag}`).join(" ") : "";
    tags.hidden = !conversation.tags?.length;

    const meta = document.createElement("span");
    meta.className = "history-meta";
    meta.textContent = `${conversation.favorite ? "⭐ · " : ""}${formatHistoryTime(conversation.updatedAt)}`;

    openButton.append(title, seekLabel, branchLabel, tags, meta);

    const editForm = document.createElement("form");
    editForm.className = "history-title-form";
    editForm.dataset.titleEditor = conversation.id;

    const titleInput = document.createElement("input");
    titleInput.className = "history-title-input";
    titleInput.dataset.titleInput = conversation.id;
    titleInput.value = conversation.title || "新对话";
    titleInput.maxLength = titleMaxLength;
    titleInput.setAttribute("aria-label", "修改对话标题");
    editForm.append(titleInput);

    let longPressTimer = null;
    const cancelLongPress = () => {
      if (!longPressTimer) return;
      clearTimeout(longPressTimer);
      longPressTimer = null;
    };

    const menuButton = document.createElement("button");
    menuButton.type = "button";
    menuButton.className = "history-menu-button";
    menuButton.setAttribute("aria-label", "对话操作");
    menuButton.setAttribute("aria-haspopup", "menu");
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.dataset.conversationId = conversation.id;
    menuButton.hidden = isEditing;
    menuButton.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="5" cy="12" r="1.6"/>
        <circle cx="12" cy="12" r="1.6"/>
        <circle cx="19" cy="12" r="1.6"/>
      </svg>
    `;
    menuButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (activeHistoryMenu?.anchor === menuButton) {
        closeHistoryMenu();
      } else {
        closeHistoryMenu();
        openHistoryMenu(menuButton);
      }
    });

    openButton.addEventListener(
      "touchstart",
      () => {
        cancelLongPress();
        longPressTimer = window.setTimeout(() => {
          longPressTimer = null;
          openButton.dataset.suppressClick = "1";
          closeHistoryMenu();
          openHistoryMenu(menuButton, openButton);
        }, 500);
      },
      { passive: true }
    );
    openButton.addEventListener("touchend", cancelLongPress);
    openButton.addEventListener("touchmove", cancelLongPress);
    openButton.addEventListener("touchcancel", cancelLongPress);

    if (isEditing) {
      const saveButton = document.createElement("button");
      saveButton.type = "button";
      saveButton.className = "history-save-title-button";
      saveButton.dataset.saveConversationTitle = conversation.id;
      saveButton.setAttribute("aria-label", "保存标题");
      saveButton.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m5 12 4 4L19 6" />
        </svg>
      `;
      row.append(editForm, saveButton, menuButton);
    } else {
      row.append(openButton, menuButton);
    }
    fragment.append(row);
  }

  historyList.append(fragment);
}

function formatHistoryTime(value) {
  const date = new Date(Number(value) || Date.now());
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function openHistory() {
  if (shouldUseSideHistory()) {
    // 桌面常驻侧栏：保持其它右侧面板不动
    document.body.classList.add("history-side-open");
    historyPanel.classList.add("open");
    historyPanel.setAttribute("aria-hidden", "false");
    historySideClosed = false;
    if (historySearchInput) historySearchInput.value = state.historySearch;
    renderHistoryList();
    syncBackdrop();
    return;
  }
  closeSettings();
  closeSeekPanel();
  closeProjectPanel();
  closeSearchPanel();
  closeFilePreview();
  closeMemoryPanel();
  closeDiagnosticsPanel();
  closeActivityPanel();
  if (historySearchInput) historySearchInput.value = state.historySearch;
  renderHistoryList();
  historyPanel.classList.add("open");
  historyPanel.setAttribute("aria-hidden", "false");
  setBackdropVisible(true);
  activateFocusTrap(historyPanel);
}

function closeHistory() {
  // 桌面常驻侧栏：不响应其它面板"顺手关闭你"，只通过 toggleHistory 显式关
  if (shouldUseSideHistory() && document.body.classList.contains("history-side-open")) {
    return;
  }
  state.editingConversationId = null;
  historyPanel.classList.remove("open");
  document.body.classList.remove("history-side-open");
  historyPanel.setAttribute("aria-hidden", "true");
  deactivateFocusTrap(historyPanel);
  syncBackdrop();
}

function openSettings() {
  closeHistory();
  closeProjectPanel();
  closeSeekPanel();
  closeSearchPanel();
  closeFilePreview();
  closeMemoryPanel();
  closeDiagnosticsPanel();
  closeActivityPanel();
  settingsPanel.classList.add("open");
  settingsPanel.setAttribute("aria-hidden", "false");
  setBackdropVisible(true);
  activateFocusTrap(settingsPanel);
}

function closeSettings() {
  settingsPanel.classList.remove("open");
  settingsPanel.setAttribute("aria-hidden", "true");
  deactivateFocusTrap(settingsPanel);
  syncBackdrop();
}

function openSeekPanel() {
  if (!seekPanel) return;
  closeHistory();
  closeSettings();
  closeProjectPanel();
  closeSearchPanel();
  closeFilePreview();
  closeMemoryPanel();
  closeDiagnosticsPanel();
  closeActivityPanel();
  renderSeekPanel();
  seekPanel.classList.add("open");
  seekPanel.setAttribute("aria-hidden", "false");
  setBackdropVisible(true);
  activateFocusTrap(seekPanel);
}

function closeSeekPanel() {
  if (!seekPanel) return;
  seekPanel.classList.remove("open");
  seekPanel.setAttribute("aria-hidden", "true");
  deactivateFocusTrap(seekPanel);
  syncBackdrop();
}

function openProjectPanel() {
  if (!projectPanel) return;
  closeHistory();
  closeSettings();
  closeSeekPanel();
  closeSearchPanel();
  closeFilePreview();
  closeMemoryPanel();
  closeDiagnosticsPanel();
  closeActivityPanel();
  renderProjectPanel();
  projectPanel.classList.add("open");
  projectPanel.setAttribute("aria-hidden", "false");
  setBackdropVisible(true);
  activateFocusTrap(projectPanel);
}

function closeProjectPanel() {
  if (!projectPanel) return;
  projectPanel.classList.remove("open");
  projectPanel.setAttribute("aria-hidden", "true");
  deactivateFocusTrap(projectPanel);
  syncBackdrop();
}

function closePanels() {
  closeHistory();
  closeSettings();
  closeSeekPanel();
  closeProjectPanel();
  closeSearchPanel();
  closeFilePreview();
  closeMemoryPanel();
  closeDiagnosticsPanel();
  closeActivityPanel();
}

function openFilePreview(attachment) {
  if (!filePreviewPanel) return;
  closeHistory();
  closeSettings();
  closeSeekPanel();
  closeProjectPanel();
  closeSearchPanel();
  closeMemoryPanel();
  closeDiagnosticsPanel();
  closeActivityPanel();
  filePreviewTitle.textContent = attachment.name || "文件预览";
  const chunkLabel = attachment.chunked || attachment.chunkCount > 1 ? ` · ${attachment.chunkCount} 段` : "";
  filePreviewMeta.textContent = `${String(attachment.kind || "FILE").toUpperCase()} · ${formatBytes(attachment.size)}${chunkLabel}`;
  filePreviewText.textContent = attachment.preview || attachment.text || "没有可预览内容";
  filePreviewPanel.classList.add("open");
  filePreviewPanel.setAttribute("aria-hidden", "false");
  setBackdropVisible(true);
  activateFocusTrap(filePreviewPanel);
}

function closeFilePreview() {
  if (!filePreviewPanel) return;
  filePreviewPanel.classList.remove("open");
  filePreviewPanel.setAttribute("aria-hidden", "true");
  deactivateFocusTrap(filePreviewPanel);
  syncBackdrop();
}

function openImageLightbox(items, index = 0) {
  if (!imageLightbox || !imageLightboxImage || !items.length) return;
  closePanels();
  state.imageLightboxItems = items;
  state.imageLightboxIndex = Math.max(0, Math.min(items.length - 1, index));
  imageLightbox.hidden = false;
  imageLightbox.setAttribute("aria-hidden", "false");
  renderImageLightbox();
  setBackdropVisible(true);
  activateFocusTrap(imageLightbox);
}

function renderImageLightbox() {
  const item = state.imageLightboxItems[state.imageLightboxIndex];
  if (!item || !imageLightboxImage) return;
  imageLightboxImage.src = item.imagePreview || item.thumbnail || "";
  imageLightboxImage.alt = item.name || "图片附件";
  if (imageLightboxCaption) {
    imageLightboxCaption.textContent = `${item.name || "图片附件"} · ${state.imageLightboxIndex + 1}/${state.imageLightboxItems.length}`;
  }
  if (imageLightboxPrev) imageLightboxPrev.hidden = state.imageLightboxItems.length <= 1;
  if (imageLightboxNext) imageLightboxNext.hidden = state.imageLightboxItems.length <= 1;
}

function stepImageLightbox(delta) {
  if (!state.imageLightboxItems.length) return;
  const count = state.imageLightboxItems.length;
  state.imageLightboxIndex = (state.imageLightboxIndex + delta + count) % count;
  renderImageLightbox();
}

function closeImageLightbox() {
  if (!imageLightbox) return;
  imageLightbox.hidden = true;
  imageLightbox.setAttribute("aria-hidden", "true");
  state.imageLightboxItems = [];
  if (imageLightboxImage) imageLightboxImage.removeAttribute("src");
  deactivateFocusTrap(imageLightbox);
  syncBackdrop();
}

function isImageLightboxOpen() {
  return Boolean(imageLightbox && !imageLightbox.hidden);
}

let historySideClosed = localStorage.getItem(storageKeys.historySideClosed) === "1";
let reasoningTickInterval = 0;

function startReasoningTick() {
  if (reasoningTickInterval) return;
  reasoningTickInterval = window.setInterval(() => {
    const streamingMessages = state.messages.filter((m) => m && m.streaming);
    if (!streamingMessages.length) {
      window.clearInterval(reasoningTickInterval);
      reasoningTickInterval = 0;
      return;
    }
    for (const message of streamingMessages) {
      if (!shouldShowReasoning(message)) continue;
      const text = reasoningSummaryText(message);
      const node = chatLog?.querySelector(`[data-message-id="${message.id}"]`);
      if (node) {
        const summary = node.querySelector(".reasoning summary");
        if (summary) summary.textContent = text;
        const triggerLabel = node.querySelector(".activity-trigger span");
        if (triggerLabel) triggerLabel.textContent = text;
      }
      if (state.activeActivityMessageId === message.id && activityPanelTitle) {
        activityPanelTitle.textContent = text;
      }
    }
  }, 1000);
}

function shouldUseSideHistory() {
  return Boolean(window.matchMedia?.("(min-width: 1100px)")?.matches);
}

function syncHistoryMode() {
  if (shouldUseSideHistory()) {
    if (!historySideClosed) {
      document.body.classList.add("history-side-open");
      historyPanel.classList.add("open");
      historyPanel.setAttribute("aria-hidden", "false");
    }
  } else {
    document.body.classList.remove("history-side-open");
    if (historyPanel.classList.contains("open") && !historySideClosed) {
      // 从桌面切到移动：桌面打开过 → 自动收起为移动 modal 状态
      historyPanel.classList.remove("open");
      historyPanel.setAttribute("aria-hidden", "true");
    }
  }
  syncBackdrop();
}

function toggleHistory() {
  if (shouldUseSideHistory()) {
    if (document.body.classList.contains("history-side-open")) {
      document.body.classList.remove("history-side-open");
      historyPanel.classList.remove("open");
      historyPanel.setAttribute("aria-hidden", "true");
      historySideClosed = true;
      localStorage.setItem(storageKeys.historySideClosed, "1");
    } else {
      document.body.classList.add("history-side-open");
      historyPanel.classList.add("open");
      historyPanel.setAttribute("aria-hidden", "false");
      historySideClosed = false;
      localStorage.removeItem(storageKeys.historySideClosed);
      if (historySearchInput) historySearchInput.value = state.historySearch;
      renderHistoryList();
    }
    syncBackdrop();
    return;
  }
  if (historyPanel.classList.contains("open")) {
    closeHistory();
  } else {
    openHistory();
  }
}

function shouldUseSideActivityPanel() {
  return Boolean(activityPanel && window.matchMedia?.("(min-width: 960px)")?.matches);
}

function isActivityPanelOpen() {
  return Boolean(activityPanel?.classList.contains("open"));
}

function renderActivityEntry(message) {
  return shouldUseSideActivityPanel()
    ? renderActivityTrigger(message)
    : renderReasoningBlock(message);
}

function renderReasoningBlock(message) {
  const block = document.createElement("details");
  block.className = "reasoning";
  block.dataset.state = message.streaming ? "streaming" : "done";

  const summary = document.createElement("summary");
  summary.textContent = reasoningSummaryText(message);

  const body = document.createElement("div");
  body.className = "reasoning-body content";
  // 内联思考区和右侧 Activity 面板共用一套渲染路径，避免流式更新时两边状态不一致。
  syncReasoningBody(body, message);

  block.append(summary, body);
  return block;
}

function syncActivityEntry(bubble, message) {
  if (!bubble) return;
  const answerContent = bubble.querySelector(".answer-content");
  const existingReasoning = bubble.querySelector(":scope > .reasoning");
  const existingTrigger = bubble.querySelector(":scope > .activity-trigger");
  const show = messageHasActivity(message);
  if (!show) {
    existingReasoning?.remove();
    existingTrigger?.remove();
    return;
  }
  if (shouldUseSideActivityPanel()) {
    existingReasoning?.remove();
    if (existingTrigger) {
      updateActivityTrigger(existingTrigger, message);
    } else {
      const trigger = renderActivityTrigger(message);
      if (answerContent) bubble.insertBefore(trigger, answerContent);
      else bubble.append(trigger);
    }
    if (state.activeActivityMessageId === message.id && isActivityPanelOpen()) {
      renderActivityPanel();
    }
    return;
  }
  existingTrigger?.remove();
  if (!existingReasoning) {
    const block = renderReasoningBlock(message);
    if (answerContent) bubble.insertBefore(block, answerContent);
    else bubble.append(block);
  } else {
    existingReasoning.dataset.state = message.streaming ? "streaming" : "done";
    const summary = existingReasoning.querySelector("summary");
    if (summary) summary.textContent = reasoningSummaryText(message);
    const body = existingReasoning.querySelector(".reasoning-body");
    if (body) syncReasoningBody(body, message);
  }
}

function renderActivityTrigger(message) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "activity-trigger";
  button.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9"></circle>
      <path d="M12 7v5l3 2"></path>
    </svg>
    <span></span>
  `;
  updateActivityTrigger(button, message);
  return button;
}

function updateActivityTrigger(button, message) {
  button.dataset.activityMessage = message.id;
  button.title = "在右侧查看思考、搜索和 Agent 过程";
  button.setAttribute("aria-label", button.title);
  const label = button.querySelector("span");
  if (label) label.textContent = reasoningSummaryText(message);
}

function maybeAutoOpenActivityPanel(message) {
  if (!message?.streaming || !shouldUseSideActivityPanel()) return;
  if (activityAutoDismissedMessageIds.has(message.id)) return;
  if (!messageHasActivity(message)) return;
  // history sidebar 常驻（桌面 side mode）不算阻塞；只有真正的 modal 弹层才阻止自动打开
  const historyBlocking = historyPanel?.classList.contains("open") && !document.body.classList.contains("history-side-open");
  if (historyBlocking || settingsPanel?.classList.contains("open")) return;
  if (isActivityPanelOpen() && state.activeActivityMessageId === message.id) return;
  openActivityPanel(message.id, { auto: true });
}

function openActivityPanel(messageId, { auto = false } = {}) {
  if (!activityPanel || !activityPanelBody) return;
  const message = state.messages.find((item) => item.id === messageId);
  if (!message || !messageHasActivity(message)) return;
  const sidePanel = shouldUseSideActivityPanel();
  if (!auto) {
    activityAutoDismissedMessageIds.delete(message.id);
    closeHistory();
    closeSettings();
  }
  closeSeekPanel();
  closeProjectPanel();
  closeSearchPanel();
  closeFilePreview();
  closeMemoryPanel();
  closeDiagnosticsPanel();
  state.activeActivityMessageId = message.id;
  renderActivityPanel();
  activityPanel.classList.add("open");
  activityPanel.setAttribute("aria-hidden", "false");
  if (sidePanel) {
    document.body.classList.add("activity-side-open");
    setBackdropVisible(false);
    deactivateFocusTrap(activityPanel);
    syncBackdrop();
  } else {
    document.body.classList.remove("activity-side-open");
    setBackdropVisible(true);
    activateFocusTrap(activityPanel);
  }
}

function closeActivityPanel({ keepState = false, suppressAutoOpen = true } = {}) {
  if (!activityPanel) return;
  const activeMessageId = state.activeActivityMessageId;
  if (suppressAutoOpen && activeMessageId) {
    activityAutoDismissedMessageIds.add(activeMessageId);
  }
  activityPanel.classList.remove("open");
  activityPanel.setAttribute("aria-hidden", "true");
  document.body.classList.remove("activity-side-open");
  deactivateFocusTrap(activityPanel);
  if (!keepState) {
    state.activeActivityMessageId = "";
  }
  syncBackdrop();
}

function renderActivityPanel() {
  if (!activityPanelBody) return;
  const message = state.messages.find((item) => item.id === state.activeActivityMessageId);
  if (!message) {
    activityPanelBody.innerHTML = "";
    if (activityPanelTitle) activityPanelTitle.textContent = "思考与活动";
    return;
  }
  if (activityPanelTitle) activityPanelTitle.textContent = reasoningSummaryText(message);
  activityPanelBody.innerHTML = "";
  const report = agentExecutionReport(message);
  if (report) {
    const tools = document.createElement("div");
    tools.className = "activity-panel-tools";
    const copyReport = document.createElement("button");
    copyReport.type = "button";
    copyReport.className = "secondary-button activity-report-copy";
    copyReport.dataset.copyAgentReport = message.id;
    copyReport.textContent = "复制 Agent 过程";
    tools.append(copyReport);
    activityPanelBody.append(tools);
  }
  const body = document.createElement("div");
  body.className = "reasoning-body content activity-reasoning-body";
  // 首次打开侧栏时也走增量同步函数；空 body 会被完整构建，后续流式更新可复用。
  syncReasoningBody(body, message);
  activityPanelBody.append(body);
}

function onActivityViewportChange() {
  if (!isActivityPanelOpen()) return;
  const sidePanel = shouldUseSideActivityPanel();
  if (sidePanel) {
    document.body.classList.add("activity-side-open");
    setBackdropVisible(false);
    deactivateFocusTrap(activityPanel);
  } else {
    document.body.classList.remove("activity-side-open");
    setBackdropVisible(true);
    activateFocusTrap(activityPanel);
  }
  syncBackdrop();
}

function setBackdropVisible(visible) {
  if (!backdrop) return;
  window.clearTimeout(backdropHideTimer);
  if (visible) {
    backdrop.hidden = false;
    requestAnimationFrame(() => backdrop.classList.add("open"));
    return;
  }
  backdrop.classList.remove("open");
  const hideDelay = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? 1 : 210;
  backdropHideTimer = window.setTimeout(() => {
    if (!backdrop.classList.contains("open")) {
      backdrop.hidden = true;
    }
  }, hideDelay);
}

function syncBackdrop() {
  const hasHistoryModal = historyPanel.classList.contains("open") && !document.body.classList.contains("history-side-open");
  const hasSettings = settingsPanel.classList.contains("open");
  const hasSeek = seekPanel?.classList.contains("open");
  const hasProject = projectPanel?.classList.contains("open");
  const hasPreview = filePreviewPanel?.classList.contains("open");
  const hasMemory = memoryPanel?.classList.contains("open");
  const hasDiagnostics = diagnosticsPanel?.classList.contains("open");
  const hasSearch = searchPanel?.classList.contains("open");
  const hasActivity = activityPanel?.classList.contains("open") && !shouldUseSideActivityPanel();
  const hasLightbox = isImageLightboxOpen();
  setBackdropVisible(Boolean(hasHistoryModal || hasSettings || hasSeek || hasProject || hasPreview || hasMemory || hasDiagnostics || hasSearch || hasActivity || hasLightbox));
}

function ensureSearchPanel() {
  searchPanel = searchPanel || document.querySelector("#searchPanel");
  searchPanelList = searchPanelList || document.querySelector("#searchPanelList");
  closeSearchPanelButton = closeSearchPanelButton || document.querySelector("#closeSearchPanelButton");

  if (!searchPanel) {
    searchPanel = document.createElement("aside");
    searchPanel.className = "search-panel";
    searchPanel.id = "searchPanel";
    searchPanel.setAttribute("aria-label", "搜索结果");
    searchPanel.setAttribute("aria-hidden", "true");
    searchPanel.innerHTML = `
      <div class="search-panel-header">
        <h2>搜索结果</h2>
        <button class="icon-button panel-close-button" id="closeSearchPanelButton" type="button" aria-label="关闭搜索结果">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div class="search-panel-list" id="searchPanelList"></div>
    `;
    document.body.append(searchPanel);
    searchPanelList = searchPanel.querySelector("#searchPanelList");
    closeSearchPanelButton = searchPanel.querySelector("#closeSearchPanelButton");
  }

  if (!searchPanelList) {
    searchPanelList = document.createElement("div");
    searchPanelList.className = "search-panel-list";
    searchPanelList.id = "searchPanelList";
    searchPanel.append(searchPanelList);
  }

  if (closeSearchPanelButton && closeSearchPanelButton.dataset.bound !== "1") {
    closeSearchPanelButton.addEventListener("click", closeSearchPanel);
    closeSearchPanelButton.dataset.bound = "1";
  }

  return Boolean(searchPanel && searchPanelList);
}

function openSearchPanel(search) {
  if (!search || !ensureSearchPanel()) return;
  closeSeekPanel();
  closeProjectPanel();
  closeFilePreview();
  closeMemoryPanel();
  closeDiagnosticsPanel();
  closeActivityPanel();
  renderSearchPanel(search);
  searchPanel.classList.add("open");
  searchPanel.setAttribute("aria-hidden", "false");
  setBackdropVisible(true);
  activateFocusTrap(searchPanel);
}

function openSearchPanelForMessage(messageId) {
  const message = state.messages.find((item) => item.id === messageId);
  const search = searchPanelDataForMessage(message);
  if (!search) return;
  openSearchPanel(search);
}

function searchPanelDataForMessage(message) {
  if (!message) return null;
  if (message.search) return message.search;
  const rounds = timelineSearchRoundsForPanel(message);
  if (!rounds.length) return null;
  const results = searchResults({ rounds });
  const status = rounds.some((round) => round.status === "searching")
    ? "searching"
    : rounds.some((round) => round.status === "error")
      ? "error"
      : "done";
  return {
    query: rounds.map((round) => round.query).filter(Boolean).join(" / "),
    status,
    rounds,
    results,
  };
}

function timelineSearchRoundsForPanel(message) {
  const rounds = [];
  for (const step of Array.isArray(message?.timeline) ? message.timeline : []) {
    if (step?.kind !== "search") continue;
    // Agent 搜索只落在 timeline 时，搜索面板需要能从这些公开事件重建“全部来源”。
    rounds.push({
      round: Number(step.round) || rounds.length + 1,
      status: ["searching", "done", "error"].includes(step.status) ? step.status : "done",
      query: String(step.query || ""),
      error: String(step.error || ""),
      results: Array.isArray(step.results) ? step.results : [],
    });
  }
  return rounds;
}

function closeSearchPanel() {
  ensureSearchPanel();
  if (!searchPanel) return;
  searchPanel.classList.remove("open");
  searchPanel.setAttribute("aria-hidden", "true");
  deactivateFocusTrap(searchPanel);
  syncBackdrop();
}

function renderSearchPanel(search) {
  if (!ensureSearchPanel()) return;
  searchPanelList.replaceChildren();
  const rounds = searchRounds(search);
  const results = searchResults(search);

  if (search.reason || search.cached) {
    const meta = document.createElement("p");
    meta.className = "search-panel-empty";
    meta.textContent = `${search.cached ? "已使用缓存 · " : ""}${search.reason ? `触发原因：${search.reason}` : ""}`;
    searchPanelList.append(meta);
  }

  if (!results.length) {
    const empty = document.createElement("p");
    empty.className = "search-panel-empty";
    empty.textContent = search.status === "searching" ? "正在获取搜索结果..." : "暂无可展示的网页结果";
    searchPanelList.append(empty);
    return;
  }

  if (rounds.length > 1) {
    const seen = new Set();
    for (const [index, round] of rounds.entries()) {
      const roundResults = Array.isArray(round.results) ? round.results : [];
      const visibleResults = roundResults.filter((result) => {
        const key = result.url || result.title || JSON.stringify(result);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (!visibleResults.length && round.status !== "error") continue;

      const heading = document.createElement("h3");
      heading.className = "search-panel-round-title";
      heading.textContent = `第 ${round.round || index + 1} 轮：${round.query || "搜索网页"}`;
      searchPanelList.append(heading);

      if (round.error) {
        const error = document.createElement("p");
        error.className = "search-panel-empty";
        error.textContent = round.error;
        searchPanelList.append(error);
      }

      for (const result of visibleResults) {
        searchPanelList.append(renderSearchPanelResult(result));
      }
    }
    return;
  }

  for (const result of results) {
    searchPanelList.append(renderSearchPanelResult(result));
  }
}

function renderSearchPanelResult(result) {
  const item = document.createElement("article");
  item.className = "search-panel-result";

  const source = document.createElement("div");
  source.className = "search-panel-source";

  const icon = document.createElement("img");
  icon.src = isHttpUrl(result.favicon) ? result.favicon : FAVICON_FALLBACK_SRC;
  icon.alt = "";
  icon.loading = "lazy";
  icon.referrerPolicy = "no-referrer";
  attachFaviconFallback(icon);
  source.append(icon);

  const domain = document.createElement("span");
  domain.textContent = resultDomain(result.url);
  source.append(domain);

  const title = document.createElement("a");
  title.className = "search-panel-title";
  title.href = result.url || "#";
  title.target = "_blank";
  title.rel = "noopener noreferrer";
  title.textContent = result.title || result.url || "网页结果";

  item.append(source, title);

  if (result.content) {
    const snippet = document.createElement("p");
    snippet.textContent = result.content;
    item.append(snippet);
  }

  return item;
}

function resizeComposer() {
  promptInput.style.height = "auto";
  const viewportHeight = window.visualViewport?.height || window.innerHeight || 720;
  const isMobile = window.matchMedia?.("(max-width: 720px)")?.matches;
  const maxHeight = isMobile ? Math.min(viewportHeight * 0.4, 260) : Math.min(viewportHeight * 0.5, 360);
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, Math.max(150, maxHeight))}px`;
  updateJumpLatestOffset();
}

function updateVisualViewportInsets() {
  const viewport = window.visualViewport;
  const bottomInset = viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
  appShell.style.setProperty("--keyboard-inset", `${Math.round(bottomInset)}px`);
  updateJumpLatestOffset();
}

function scrollToLatest({ behavior = "smooth" } = {}) {
  const metrics = getScrollMetrics();
  if (metrics.target === window) {
    window.scrollTo({ top: metrics.scrollHeight, behavior });
  } else {
    metrics.target.scrollTo({ top: metrics.scrollHeight, behavior });
  }
  updateJumpLatestButton();
}

function isChatNearBottom() {
  if (!state.messages.length) return true;
  const { scrollHeight, scrollTop, clientHeight } = getScrollMetrics();
  const distance = scrollHeight - scrollTop - clientHeight;
  return distance <= 120;
}

function getScrollMetrics() {
  const page = document.scrollingElement || document.documentElement;
  const pageScrollTop = window.scrollY || page.scrollTop;
  const pageClientHeight = window.innerHeight;
  const pageScrollableDistance = page.scrollHeight - pageClientHeight;
  const chatScrollTop = chatLog.scrollTop;
  const chatScrollableDistance = chatLog.scrollHeight - chatLog.clientHeight;

  if (pageScrollableDistance > 1 && (pageScrollTop > 1 || chatScrollableDistance <= 1)) {
    return {
      target: window,
      scrollHeight: page.scrollHeight,
      scrollTop: pageScrollTop,
      clientHeight: pageClientHeight,
    };
  }

  if (chatScrollableDistance > 1) {
    return {
      target: chatLog,
      scrollHeight: chatLog.scrollHeight,
      scrollTop: chatScrollTop,
      clientHeight: chatLog.clientHeight,
    };
  }

  return {
    target: window,
    scrollHeight: page.scrollHeight,
    scrollTop: pageScrollTop,
    clientHeight: pageClientHeight,
  };
}

function updateJumpLatestButton() {
  if (!jumpLatestButton) return;
  if (!state.messages.length || isChatNearBottom()) {
    jumpLatestButton.hidden = true;
    return;
  }
  jumpLatestButton.hidden = false;
}

function updateJumpLatestOffset() {
  const composerStyle = window.getComputedStyle(chatForm);
  const marginBottom = Number.parseFloat(composerStyle.marginBottom) || 0;
  const offset = chatForm.offsetHeight + marginBottom + 14;
  appShell.style.setProperty("--jump-latest-bottom", `${offset}px`);
}

function onConversationPeekClick(event) {
  const target = event.target instanceof Element ? event.target : event.target?.parentElement;
  const button = target?.closest("button[data-peek-message]");
  if (!button) return;
  const messageId = button.dataset.peekMessage || "";
  setConversationPeekActive(messageId);
  state.peekClickLockUntil = Date.now() + 800;
  scrollMessageIntoView(messageId, { block: "start", behavior: "smooth" });
}

function onSuggestionCardClick(event) {
  const card = event.target instanceof Element ? event.target.closest("button[data-prompt]") : null;
  if (!card || !promptInput) return;
  const prompt = card.dataset.prompt || "";
  const current = promptInput.value.trim();
  promptInput.value = current ? `${current}\n\n${prompt}` : prompt;
  resizeComposer();
  saveDraft();
  promptInput.focus();
  const length = promptInput.value.length;
  try {
    promptInput.setSelectionRange(length, length);
  } catch {
    // textarea may not support setSelectionRange in all browsers; safe to ignore
  }
}

function toggleAgentTimelineStep(messageId, stepId) {
  const message = state.messages.find((item) => item.id === messageId);
  if (!message || !Array.isArray(message.timeline) || !stepId) return;
  const step = message.timeline.find((item) => item?.kind === "agent" && (item.id || agentStepId(item.phase)) === stepId);
  if (!step || !agentStepHasDetails(step)) return;
  step.collapsed = !step.collapsed;
  updateStreamingMessage(message);
  if (state.activeActivityMessageId === message.id && isActivityPanelOpen()) {
    renderActivityPanel();
  }
  persistMessages();
}

async function copyAgentExecutionReport(messageId) {
  const message = state.messages.find((item) => item.id === messageId);
  const report = agentExecutionReport(message);
  if (!report) {
    showToast("这条回复没有可复制的 Agent 过程", { tone: "error" });
    return;
  }
  const copied = await copyText(report);
  showToast(copied ? "已复制 Agent 过程" : "复制失败，请长按文本手动复制", { tone: copied ? "success" : "error" });
}

async function runtimePayloadForAgentMessage(message) {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey && !state.hasServerKey) {
    showToast("请先在设置里填写 DeepSeek API Key");
    openSettings();
    return null;
  }
  const requestMessages = messagesBeforeAssistant(message);
  const compressedParts = await buildCompressedRequestParts(apiKey, requestMessages, message);
  return requestPayloadFromParts(apiKey, message, compressedParts, {
    model: message.model || state.model,
    thinkingEnabled: Boolean(message.thinking ?? state.thinkingEnabled),
    reasoningEffort: message.reasoningEffort || state.reasoningEffort,
  });
}

async function confirmAgentRunPlan(messageId) {
  if (state.busy || state.offlineMode) return;
  const message = state.messages.find((item) => item.id === messageId && item.agentRunId);
  if (!message) return;
  setBusy(true);
  message.streaming = true;
  message.error = false;
  prepareAssistantRequest(message, false);
  updateStreamingMessage(message);
  try {
    const payload = await runtimePayloadForAgentMessage(message);
    if (!payload) {
      message.streaming = false;
      updateStreamingMessage(message);
      persistMessages();
      return;
    }
    message.agentRunPlan = normalizedEditableAgentPlan(message.agentRunPlan);
    const response = await apiFetch(`/api/agent-runs/${encodeURIComponent(message.agentRunId)}/plan`, {
      method: "POST",
      signal: state.abortController?.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload, plan: message.agentRunPlan }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(apiErrorMessage(response, data, `确认计划失败：${response.status}`));
    await attachAgentRunStream(message);
    completeAgentRunMessage(message);
  } catch (error) {
    if (isAbortError(error)) {
      markAssistantInterrupted(message);
      return;
    }
    message.streaming = false;
    message.error = true;
    message.content = `调用失败：${error.message}`;
    updateStreamingMessage(message);
    persistMessages();
  } finally {
    finishAssistantRequest(message);
    setBusy(false);
  }
}

async function rerunAgentPhase(messageId, phase) {
  if (state.busy || state.offlineMode) return;
  const message = state.messages.find((item) => item.id === messageId && item.agentRunId);
  if (!message || !phase) return;
  if (phase !== "synthesizer") {
    showToast("单 Agent 重跑不会自动级联其它 Agent，将重新综合最终回答。");
  }
  setBusy(true);
  message.streaming = true;
  message.error = false;
  message.agentRunStatus = "running";
  prepareAssistantRequest(message, false);
  updateStreamingMessage(message);
  try {
    const payload = await runtimePayloadForAgentMessage(message);
    if (!payload) {
      message.streaming = false;
      updateStreamingMessage(message);
      persistMessages();
      return;
    }
    const response = await apiFetch(`/api/agent-runs/${encodeURIComponent(message.agentRunId)}/rerun`, {
      method: "POST",
      signal: state.abortController?.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload, agentId: phase, resynthesize: true }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(apiErrorMessage(response, data, `重跑 Agent 失败：${response.status}`));
    await attachAgentRunStream(message);
    completeAgentRunMessage(message);
  } catch (error) {
    if (isAbortError(error)) {
      markAssistantInterrupted(message);
      return;
    }
    message.streaming = false;
    message.error = true;
    message.content = `调用失败：${error.message}`;
    updateStreamingMessage(message);
    persistMessages();
  } finally {
    finishAssistantRequest(message);
    setBusy(false);
  }
}

function completeAgentRunMessage(message) {
  message.completedAt = Date.now();
  message.streaming = false;
  settleStuckSearchSteps(message);
  ensureAssistantHasVisibleContent(message);
  clearAssistantRequestMarkers(message);
  updateStreamingMessage(message);
  persistMessages();
}

function ensureAssistantHasVisibleContent(message) {
  if (String(message?.content || "").trim()) return;
  if (message?.agentRunStatus === "awaiting_plan") {
    message.content = "Agent 计划已生成，等待确认执行。";
    return;
  }
  message.content = message?.agentRunId || message?.agentMode ? emptyAgentRunAnswerText : "没有返回内容。";
}

function onChatLogPlanEdit(event) {
  const target = event.target instanceof Element ? event.target : null;
  const control = target?.closest("[data-agent-plan-task], [data-agent-plan-phase]");
  if (!control) return;
  const message = state.messages.find((item) => item.id === control.dataset.agentPlanMessage && item.agentRunId);
  if (!message) return;
  const plan = normalizedEditableAgentPlan(message.agentRunPlan);
  const taskIndex = Number(control.dataset.agentPlanTask);
  const phaseIndex = Number(control.dataset.agentPlanPhase);
  const index = Number.isInteger(taskIndex) ? taskIndex : phaseIndex;
  if (!Number.isInteger(index) || index < 0 || index >= plan.length) return;
  if (control.matches("[data-agent-plan-phase]")) {
    plan[index].id = editableAgentPhases.some((item) => item.id === control.value) ? control.value : "critic";
  } else {
    plan[index].task = String(control.value || "").trim().slice(0, 500);
  }
  message.agentRunPlan = plan;
  persistMessages();
}

function rerenderAgentPlanWorkbench(message) {
  const bubble = chatLog.querySelector(`[data-message-id="${message.id}"] .bubble`);
  if (bubble) syncAgentPlanWorkbench(bubble, message);
  syncVisibleAssistantActions();
  persistMessages();
}

async function onChatLogClick(event) {
  const clickTarget = event.target instanceof Element ? event.target : event.target?.parentElement;
  const activityButton = clickTarget?.closest("button[data-activity-message]");
  if (activityButton) {
    openActivityPanel(activityButton.dataset.activityMessage || "");
    return;
  }
  const imageButton = clickTarget?.closest("button[data-message-image]");
  if (imageButton) {
    const node = imageButton.closest(".message[data-message-id]");
    const message = state.messages.find((item) => item.id === node?.dataset.messageId);
    openImageLightbox(imageAttachments(message?.attachments || []), Number(imageButton.dataset.messageImage) || 0);
    return;
  }

  const searchButton = clickTarget?.closest("button[data-search-results]");
  if (searchButton) {
    openSearchPanelForMessage(searchButton.dataset.searchResults);
    return;
  }

  const agentToggleButton = clickTarget?.closest("button[data-agent-toggle]");
  if (agentToggleButton) {
    toggleAgentTimelineStep(agentToggleButton.dataset.agentToggle || "", agentToggleButton.dataset.agentStep || "");
    return;
  }

  const agentPresetButton = clickTarget?.closest("button[data-agent-plan-preset]");
  if (agentPresetButton) {
    const message = state.messages.find((item) => item.id === agentPresetButton.dataset.agentPlanMessage && item.agentRunId);
    if (message) {
      message.agentRunPlan = agentPlanForPreset(agentPresetButton.dataset.agentPlanPreset || "full");
      rerenderAgentPlanWorkbench(message);
    }
    return;
  }

  const agentPlanAddButton = clickTarget?.closest("button[data-agent-plan-add]");
  if (agentPlanAddButton) {
    const message = state.messages.find((item) => item.id === agentPlanAddButton.dataset.agentPlanAdd && item.agentRunId);
    if (message) {
      message.agentRunPlan = [...normalizedEditableAgentPlan(message.agentRunPlan), { id: "critic", task: "审查风险、遗漏和反例" }];
      rerenderAgentPlanWorkbench(message);
    }
    return;
  }

  const agentPlanRemoveButton = clickTarget?.closest("button[data-agent-plan-remove]");
  if (agentPlanRemoveButton) {
    const message = state.messages.find((item) => item.id === agentPlanRemoveButton.dataset.agentPlanMessage && item.agentRunId);
    const index = Number(agentPlanRemoveButton.dataset.agentPlanRemove);
    if (message && Number.isInteger(index)) {
      const plan = normalizedEditableAgentPlan(message.agentRunPlan);
      if (plan.length > 1) {
        message.agentRunPlan = plan.filter((_, itemIndex) => itemIndex !== index);
        rerenderAgentPlanWorkbench(message);
      }
    }
    return;
  }

  const confirmAgentPlanButton = clickTarget?.closest("button[data-confirm-agent-plan]");
  if (confirmAgentPlanButton) {
    await confirmAgentRunPlan(confirmAgentPlanButton.dataset.confirmAgentPlan || "");
    return;
  }

  const agentRerunButton = clickTarget?.closest("button[data-agent-rerun]");
  if (agentRerunButton) {
    await rerunAgentPhase(agentRerunButton.dataset.agentRerun || "", agentRerunButton.dataset.agentPhase || "");
    return;
  }

  const continueButton = clickTarget?.closest("button[data-continue-generation]");
  if (continueButton) {
    continueGeneration(continueButton.dataset.continueGeneration);
    return;
  }

  const editButton = clickTarget?.closest("button[data-edit-message]");
  if (editButton) {
    startMessageEdit(editButton.dataset.editMessage);
    return;
  }

  const cancelEditButton = clickTarget?.closest("button[data-cancel-message-edit]");
  if (cancelEditButton) {
    cancelMessageEdit();
    return;
  }

  const regenerateButton = clickTarget?.closest("button[data-regenerate-message]");
  if (regenerateButton) {
    regenerateMessage(regenerateButton.dataset.regenerateMessage);
    return;
  }

  const speakButton = clickTarget?.closest("button[data-speak-message]");
  if (speakButton) {
    toggleSpeakMessage(speakButton.dataset.speakMessage || "");
    return;
  }

  const branchButton = clickTarget?.closest("button[data-branch-from-message]");
  if (branchButton) {
    forkConversationFromMessage(branchButton.dataset.branchFromMessage);
    return;
  }

  const feedbackButton = clickTarget?.closest("button[data-feedback-message]");
  if (feedbackButton) {
    setMessageFeedback(feedbackButton.dataset.feedbackMessage || "", feedbackButton.dataset.feedbackValue || "");
    return;
  }

  const exportMessageButton = clickTarget?.closest("button[data-export-message]");
  if (exportMessageButton) {
    exportSingleAssistantMessage(exportMessageButton.dataset.exportMessage || "");
    return;
  }

  const agentReportButton = clickTarget?.closest("button[data-copy-agent-report]");
  if (agentReportButton) {
    await copyAgentExecutionReport(agentReportButton.dataset.copyAgentReport || "");
    return;
  }

  const citationButton = clickTarget?.closest("button[data-citation]");
  if (citationButton) {
    const node = citationButton.closest(".message.assistant[data-message-id]");
    openCitationForMessage(node?.dataset.messageId || "", citationButton.dataset.citation || "");
    return;
  }

  const diagnosticsButton = clickTarget?.closest("button[data-diagnostics-message]");
  if (diagnosticsButton) {
    openDiagnosticsPanelForMessage(diagnosticsButton.dataset.diagnosticsMessage);
    return;
  }

  if (await handleContentBlockClick(clickTarget)) return;
}

// 公式 / 表格图表 / 代码块这些"内容块级"按钮，主聊天区（onChatLogClick）和右侧
// Activity 面板（onActivityPanelClick）都会出现。抽成共享处理，避免 Activity 面板
// 漏接导致点"复制 LaTeX""复制代码"完全静默无反应。返回 true 表示已消费该点击。
async function handleContentBlockClick(clickTarget) {
  const mathButton = clickTarget?.closest("button[data-math-action]");
  if (mathButton) {
    const source = mathButton.closest(".math-block-wrap")?.querySelector(".math-source")?.value || "";
    const copied = await copyText(source);
    showToast(copied ? "已复制 LaTeX" : "复制失败，请长按公式手动复制");
    return true;
  }

  const chartButton = clickTarget?.closest("button[data-chart-action]");
  if (chartButton) {
    renderTableChart(chartButton.closest(".table-wrap"), chartButton.dataset.chartAction || "bar");
    return true;
  }

  const actionButton = clickTarget?.closest("button[data-code-action]");
  if (!actionButton) return false;

  const card = actionButton.closest(".code-card, .mermaid-card");
  const code = card?.querySelector(".code-source")?.value || card?.querySelector("code")?.textContent || "";
  if (!code) return true;

  if (actionButton.dataset.codeAction === "toggle-collapse") {
    card.classList.toggle("expanded");
    const label = actionButton.querySelector("span");
    if (label) label.textContent = card.classList.contains("expanded") ? "折叠" : "展开";
    return true;
  }

  if (actionButton.dataset.codeAction === "vscode") {
    const path = actionButton.dataset.codePath || "";
    if (!path) {
      showToast("没有检测到可打开的本地文件路径");
      return true;
    }
    window.location.href = vscodeUriForPath(path);
    return true;
  }

  if (actionButton.dataset.codeAction === "copy") {
    const copied = await copyText(code);
    if (copied) {
      actionButton.classList.add("copied");
      window.setTimeout(() => actionButton.classList.remove("copied"), 800);
      showToast("已复制代码", { tone: "success" });
    } else {
      showToast("复制失败，请长按代码手动复制", { tone: "error" });
    }
    return true;
  }

  if (actionButton.dataset.codeAction === "download") {
    const lang = card.dataset.codeLang || "txt";
    downloadTextFile(code, `deepseek-code.${extensionForLanguage(lang)}`);
  }
  return true;
}

async function onActivityPanelClick(event) {
  const clickTarget = event.target instanceof Element ? event.target : event.target?.parentElement;

  const searchButton = clickTarget?.closest("button[data-search-results]");
  if (searchButton) {
    openSearchPanelForMessage(searchButton.dataset.searchResults || state.activeActivityMessageId);
    return;
  }

  const agentToggleButton = clickTarget?.closest("button[data-agent-toggle]");
  if (agentToggleButton) {
    toggleAgentTimelineStep(agentToggleButton.dataset.agentToggle || state.activeActivityMessageId, agentToggleButton.dataset.agentStep || "");
    return;
  }

  const agentRerunButton = clickTarget?.closest("button[data-agent-rerun]");
  if (agentRerunButton) {
    await rerunAgentPhase(agentRerunButton.dataset.agentRerun || state.activeActivityMessageId, agentRerunButton.dataset.agentPhase || "");
    return;
  }

  const agentReportButton = clickTarget?.closest("button[data-copy-agent-report]");
  if (agentReportButton) {
    await copyAgentExecutionReport(agentReportButton.dataset.copyAgentReport || state.activeActivityMessageId);
    return;
  }

  const citationButton = clickTarget?.closest("button[data-citation]");
  if (citationButton) {
    await openCitationForMessage(state.activeActivityMessageId, citationButton.dataset.citation || "");
    return;
  }

  // Activity 面板里同样会渲染公式 / 代码块 / 表格图表，共用主聊天区的块级按钮处理。
  await handleContentBlockClick(clickTarget);
}

function renderTableChart(tableWrap, type) {
  if (!tableWrap) return;
  const chart = tableWrap.querySelector(".table-chart");
  const rows = Array.from(tableWrap.querySelectorAll("tbody tr"));
  const data = rows
    .map((row) => {
      const cells = Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent.trim());
      return { label: cells[0] || "", value: parseChartCell(cells.find((cell, index) => index > 0 && Number.isFinite(parseChartCell(cell)))) };
    })
    .filter((item) => item.label && Number.isFinite(item.value));
  if (!chart || !data.length) {
    showToast("表格里没有可渲染的数值列");
    return;
  }
  chart.hidden = false;
  chart.innerHTML = chartSvg(data.slice(0, 12), type);
}

async function copyText(value) {
  const text = String(value || "");
  if (!text) return false;

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall back for mobile browsers that expose the API but reject it.
    }
  }

  return copyTextWithTextarea(text);
}

function copyTextWithTextarea(text) {
  const activeElement = document.activeElement;
  const selection = document.getSelection();
  const ranges = [];
  if (selection) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      ranges.push(selection.getRangeAt(index));
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  textarea.style.fontSize = "16px";
  textarea.style.zIndex = "-1";
  document.body.append(textarea);

  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }

  textarea.remove();

  if (selection) {
    selection.removeAllRanges();
    for (const range of ranges) selection.addRange(range);
  }

  if (activeElement instanceof HTMLElement) {
    activeElement.focus({ preventScroll: true });
  }

  return copied;
}

function downloadTextFile(text, filename, type = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function loadConversations() {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKeys.conversations) || "[]");
    if (Array.isArray(parsed)) {
      const conversations = parsed
        .map(normalizeConversation)
        .filter(Boolean)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 60);
      if (conversations.length) return conversations;
    }
  } catch {
    // Fall through to legacy migration.
  }

  const legacyMessages = loadLegacyMessages();
  if (!legacyMessages.length) return [];

  const conversation = createConversation(legacyMessages);
  localStorage.setItem(storageKeys.conversations, JSON.stringify([conversation]));
  localStorage.setItem(storageKeys.currentConversation, conversation.id);
  return [conversation];
}

function loadLegacyMessages() {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKeys.messages) || "[]");
    return Array.isArray(parsed) ? parsed.map(normalizeMessage).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function normalizeConversation(value) {
  if (!value || typeof value !== "object") return null;
  const messages = Array.isArray(value.messages)
    ? value.messages.map(normalizeMessage).filter(Boolean)
    : [];
  if (!messages.length) return null;

  const id = typeof value.id === "string" && value.id ? value.id : createId();
  const createdAt = Number(value.createdAt) || messages[0]?.createdAt || Date.now();
  const updatedAt = Number(value.updatedAt) || messages[messages.length - 1]?.createdAt || createdAt;
  return {
    id,
    title: normalizeTitle(value.title) || titleFromMessages(messages),
    customTitle: Boolean(value.customTitle),
    autoTitleDone: Boolean(value.autoTitleDone),
    messages,
    model: normalizeModel(value.model),
    thinkingEnabled: Boolean(value.thinkingEnabled ?? normalizeModel(value.model) === modelRoutes.expert),
    seekId: normalizeSeekId(value.seekId),
    favorite: Boolean(value.favorite),
    tags: normalizeTags(value.tags),
    branchParentId: typeof value.branchParentId === "string" ? value.branchParentId : "",
    branchFromMessageId: typeof value.branchFromMessageId === "string" ? value.branchFromMessageId : "",
    branchLabel: normalizeTitle(value.branchLabel || ""),
    contextSummary: String(value.contextSummary || ""),
    contextSummaryFingerprint: String(value.contextSummaryFingerprint || ""),
    contextSummaryMessageCount: Number(value.contextSummaryMessageCount) || 0,
    contextSummaryGeneration: Number(value.contextSummaryGeneration) || 0,
    contextPins: Array.isArray(value.contextPins)
      ? value.contextPins.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20)
      : [],
    createdAt,
    updatedAt,
  };
}

function cloneJsonSafe(value) {
  if (!value || typeof value !== "object") return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function normalizeMessage(value) {
  if (!value || typeof value !== "object") return null;
  if (!["user", "assistant"].includes(value.role)) return null;
  const content = typeof value.content === "string" ? value.content : "";
  const reasoning = typeof value.reasoning === "string" ? value.reasoning : "";
  const systemNotes = Array.isArray(value.systemNotes)
    ? value.systemNotes.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20)
    : [];
  const memorySuggestions = Array.isArray(value.memorySuggestions)
    ? value.memorySuggestions.map(normalizeMemorySuggestion).filter(Boolean).slice(0, 10)
    : [];
  const attachments = Array.isArray(value.attachments)
    ? value.attachments.map(normalizeStoredAttachment).filter(Boolean)
    : [];
  const timeline = normalizeTimeline(value.timeline);
  const search = value.search && typeof value.search === "object" ? cloneJsonSafe(value.search) : null;
  const message = {
    ...value,
    role: value.role,
    content,
    reasoning,
    search,
    timeline,
    systemNotes,
    memorySuggestions,
    attachments,
    thinking: Boolean(value.thinking),
    agentMode: Boolean(value.agentMode),
    agentRunId: typeof value.agentRunId === "string" ? value.agentRunId : "",
    agentRunStatus: typeof value.agentRunStatus === "string" ? value.agentRunStatus : "",
    agentRunLastEventIndex: Number.isFinite(Number(value.agentRunLastEventIndex)) ? Number(value.agentRunLastEventIndex) : -1,
    agentRunPlan: Array.isArray(value.agentRunPlan) ? value.agentRunPlan : [],
    agentAutoPlanLabel: typeof value.agentAutoPlanLabel === "string" ? value.agentAutoPlanLabel : "",
    agentPreset: normalizeAgentPreset(value.agentPreset),
    reasoningEffort: normalizeReasoningEffort(value.reasoningEffort),
    seekId: normalizeSeekId(value.seekId),
    seekName: normalizeSeekText(value.seekName, 32),
    seekDescription: normalizeSeekText(value.seekDescription, 140),
    seekInstructions: normalizeSeekInstructions(value.seekInstructions, 5000),
    seekReferenceAttachments: normalizeSeekReferenceAttachments(value.seekReferenceAttachments || []),
    projectId: typeof value.projectId === "string" ? value.projectId : "",
    projectName: typeof value.projectName === "string" ? value.projectName : "",
    projectAttachments: normalizeProjectAttachments(value.projectAttachments || []),
    interrupted: Boolean(value.interrupted),
    diagnostics: value.diagnostics && typeof value.diagnostics === "object" ? value.diagnostics : null,
    feedback: ["up", "down"].includes(value.feedback) ? value.feedback : "",
    completedAt: Number(value.completedAt) || undefined,
    reasoningEndedAt: Number(value.reasoningEndedAt) || undefined,
    createdAt: Number(value.createdAt) || Date.now(),
    streaming: false,
  };
  if (!message.id) message.id = createId();
  settleStuckSearchSteps(message, "搜索未完成（页面已刷新或请求已中断）");
  return message;
}

function messageForStorage(message) {
  const stored = { ...message, search: cloneJsonSafe(message.search), streaming: false, timeline: normalizeTimeline(message.timeline) };
  settleStuckSearchSteps(stored, "搜索未完成（页面刷新或请求中断）");
  return stored;
}

function normalizeProjectAttachments(value) {
  return Array.isArray(value) ? value.map(normalizeStoredAttachment).filter(Boolean).slice(0, 120) : [];
}

function createConversation(messages = []) {
  const safeMessages = messages.map(normalizeMessage).filter(Boolean);
  const now = Date.now();
  const seek = findSeekById(localStorage.getItem(storageKeys.activeSeek));
  return {
    id: createId(),
    title: titleFromMessages(safeMessages),
    customTitle: false,
    autoTitleDone: false,
    messages: safeMessages,
    model: normalizeModel(localStorage.getItem(storageKeys.model)),
    thinkingEnabled: loadThinkingEnabled(),
    seekId: seek?.id || "",
    favorite: false,
    tags: [],
    branchParentId: "",
    branchFromMessageId: "",
    branchLabel: "",
    contextSummary: "",
    contextSummaryFingerprint: "",
    contextSummaryMessageCount: 0,
    contextSummaryGeneration: 0,
    contextPins: [],
    createdAt: safeMessages[0]?.createdAt || now,
    updatedAt: safeMessages[safeMessages.length - 1]?.createdAt || now,
  };
}

function normalizeConversationId(id, conversations) {
  return conversations.some((conversation) => conversation.id === id) ? id : conversations[0]?.id || null;
}

function messagesForConversation(conversations, id) {
  const conversation = conversations.find((item) => item.id === id);
  return conversation ? conversation.messages.map((message) => ({ ...message, streaming: false })) : [];
}

function ensureCurrentConversation() {
  if (state.currentConversationId) return;
  const conversation = createConversation();
  state.currentConversationId = conversation.id;
  state.conversations.unshift(conversation);
  localStorage.setItem(storageKeys.currentConversation, conversation.id);
}

function persistMessages() {
  if (!state.messages.length) {
    saveConversations();
    return;
  }

  ensureCurrentConversation();
  const conversation = state.conversations.find((item) => item.id === state.currentConversationId);
  if (!conversation) return;

  const messages = state.messages.slice(-80).map(messageForStorage);
  conversation.messages = messages;
  if (!conversation.customTitle && !conversation.autoTitleDone) {
    conversation.title = titleFromMessages(messages);
  }
  conversation.model = state.model;
  conversation.thinkingEnabled = state.thinkingEnabled;
  conversation.seekId = latestSeekId(messages) || state.activeSeekId;
  conversation.updatedAt = Date.now();
  saveConversations();
  renderHistoryList();
  maybeAutoGenerateTitle(conversation, messages);
}

async function maybeAutoGenerateTitle(conversation, messages) {
  if (!conversation || conversation.customTitle || conversation.autoTitleDone || conversation.autoTitlePending) return;
  const userMessages = messages.filter((message) => message.role === "user" && String(message.content || "").trim());
  const assistantMessages = messages.filter((message) => message.role === "assistant" && !message.streaming && !message.error && String(message.content || "").trim());
  if (userMessages.length !== 1 || !assistantMessages.length) return;
  if (state.offlineMode) return;
  const apiKey = apiKeyInput?.value.trim() || "";
  if (!apiKey && !state.hasServerKey) return;
  const userText = String(userMessages[0].content || "").trim();
  if (userText.length < 4) return;

  conversation.autoTitlePending = true;
  renderHistoryList();
  try {
    const response = await apiFetch("/api/title", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey,
        titleModel: modelRoutes.fast,
        userMessage: userText,
        assistantMessage: String(assistantMessages[0].content || "").slice(0, 600),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return;
    const title = normalizeTitle(data.title || "");
    if (!title) return;
    const fresh = state.conversations.find((item) => item.id === conversation.id);
    if (!fresh || fresh.customTitle) return;
    fresh.title = title;
    fresh.autoTitleDone = true;
    saveConversations();
  } catch {
    // Best effort: keep the local fallback title.
  } finally {
    const fresh = state.conversations.find((item) => item.id === conversation.id);
    if (fresh) {
      fresh.autoTitlePending = false;
      renderHistoryList();
    }
  }
}

async function regenerateTitle(conversationId) {
  const conversation = state.conversations.find((item) => item.id === conversationId);
  if (!conversation || conversation.customTitle) return;
  conversation.autoTitleDone = false;
  conversation.autoTitlePending = false;
  saveConversations();
  renderHistoryList();
  showToast("正在重新生成标题");
  await maybeAutoGenerateTitle(conversation, conversation.messages || []);
}

function latestSeekId(messages) {
  return seekCore.latestKnownSeekId(messages, allSeeks());
}

function saveConversations() {
  state.conversations = state.conversations
    .filter((conversation) => conversation.messages.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 60);
  const storedConversations = state.conversations.map((conversation) => {
    const { autoTitlePending, ...stored } = conversation;
    return stored;
  });
  localStorage.setItem(storageKeys.conversations, JSON.stringify(storedConversations));
  if (state.currentConversationId) {
    localStorage.setItem(storageKeys.currentConversation, state.currentConversationId);
  } else {
    localStorage.removeItem(storageKeys.currentConversation);
  }
}

function titleFromMessages(messages) {
  const firstUser = messages.find((message) => message.role === "user" && message.content.trim());
  return normalizeTitle(firstUser?.content) || "新对话";
}

function normalizeTitle(value) {
  const title = String(value || "").replace(/\s+/g, " ").trim();
  return title.length > titleMaxLength ? `${title.slice(0, titleMaxLength)}...` : title;
}

function normalizeTags(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[，,\s]+/);
  const seen = new Set();
  const tags = [];
  for (const item of raw) {
    const tag = String(item || "").replace(/\s+/g, " ").trim().slice(0, tagMaxLength);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags.slice(0, 8);
}

function exportMarkdown() {
  const lines = ["# DeepSeek 对话记录", ""];
  for (const message of state.messages) {
    lines.push(`## ${message.role === "user" ? "你" : "DeepSeek"}`, "");
    const seekName = seekNameForMessage(message);
    if (seekName) {
      lines.push(`_Seek：${seekName}_`, "");
    }
    const seekReferences = normalizeSeekReferenceAttachments(message.seekReferenceAttachments || []);
    if (message.role === "user" && seekReferences.length) {
      appendAttachmentMarkdown(lines, seekReferences, "Seek 参考文件");
    }
    if (message.reasoning) {
      lines.push("### 推理过程", "", message.reasoning, "");
    }
    lines.push(message.content || "", "");
  }

  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `deepseek-v4-chat-${new Date().toISOString().slice(0, 10)}.md`;
  link.click();
  URL.revokeObjectURL(url);
}

function exportCurrentConversation() {
  if (!state.messages.length) {
    showToast("当前没有可导出的对话");
    return;
  }

  const title = currentConversationTitle();
  const seekNames = uniqueSeekNamesForMessages(state.messages);
  const lines = [
    `# ${title}`,
    "",
    `- 导出时间：${formatExportTime(new Date())}`,
    `- 模型：${modelLabel(state.model)}${state.thinkingEnabled ? "（思考开启）" : "（思考关闭）"}`,
    `- Seek：${seekNames.length ? seekNames.join("、") : "未使用"}`,
    `- 消息数：${state.messages.length}`,
    "",
    "---",
    "",
  ];

  for (const message of state.messages) {
    lines.push(`## ${message.role === "user" ? "你" : responseLabel(message)}`, "");
    const seekName = seekNameForMessage(message);
    if (seekName) {
      lines.push(`_Seek：${seekName}_`, "");
    }

    const seekReferences = normalizeSeekReferenceAttachments(message.seekReferenceAttachments || []);
    if (message.role === "user" && seekReferences.length) {
      appendAttachmentMarkdown(lines, seekReferences, "Seek 参考文件");
    }

    if (message.attachments?.length) {
      appendAttachmentMarkdown(lines, message.attachments);
    }

    if (message.search) {
      appendSearchMarkdown(lines, message.search);
    }

    if (message.reasoning) {
      lines.push("### 推理过程", "", message.reasoning.trim(), "");
    }

    lines.push((message.content || "").trim() || "_空消息_", "");
  }

  downloadTextFile(lines.join("\n"), `${safeFilename(title)}-${new Date().toISOString().slice(0, 10)}.md`, "text/markdown;charset=utf-8");
  showToast("已导出当前对话");
}

function exportSingleAssistantMessage(messageId) {
  const message = state.messages.find((item) => item.id === messageId && item.role === "assistant");
  if (!message) return;
  const lines = [
    `# ${responseLabel(message)}`,
    "",
    `- 导出时间：${formatExportTime(new Date())}`,
    `- 模型：${modelLabel(message.model || state.model)}`,
  ];
  const seekName = seekNameForMessage(message);
  if (seekName) lines.push(`- Seek：${seekName}`);
  if (message.feedback) lines.push(`- 本地反馈：${message.feedback === "up" ? "有帮助" : "没帮助"}`);
  if (message.attachments?.length) {
    lines.push("");
    appendAttachmentMarkdown(lines, message.attachments);
  }
  if (message.search) {
    lines.push("");
    appendSearchMarkdown(lines, message.search);
  }
  if (message.reasoning) {
    lines.push("", "## 推理过程", "", message.reasoning.trim());
  }
  lines.push("", "## 回复", "", (message.content || "").trim() || "_空回复_", "");
  downloadTextFile(lines.join("\n"), `${safeFilename(messagePreview(message) || "assistant-reply")}-${new Date().toISOString().slice(0, 10)}.md`, "text/markdown;charset=utf-8");
  showToast("已导出单条回复");
}

function currentConversationTitle() {
  const conversation = state.conversations.find((item) => item.id === state.currentConversationId);
  return normalizeTitle(conversation?.title || titleFromMessages(state.messages) || "DeepSeek 对话记录");
}

function uniqueSeekNamesForMessages(messages) {
  return Array.from(new Set(messages.map(seekNameForMessage).filter(Boolean)));
}

function seekNameForConversation(conversation) {
  if (!conversation) return "";
  const knownSeek = findSeekById(conversation.seekId);
  if (knownSeek?.name) return knownSeek.name;
  return uniqueSeekNamesForMessages(conversation.messages || [])[0] || "";
}

function appendSearchMarkdown(lines, search) {
  const rounds = searchRounds(search);
  const results = searchResults(search);
  if (!search.query && !search.answer && !results.length && !search.error) return;

  lines.push("### 联网搜索", "");
  if (search.query) lines.push(`- 搜索词：${search.query}`);
  if (search.status) lines.push(`- 状态：${search.status}`);
  if (search.error) lines.push(`- 错误：${search.error}`);
  if (search.answer) lines.push("", search.answer.trim());

  if (rounds.length > 1) {
    lines.push("", "搜索轮次：");
    for (const round of rounds) {
      lines.push(`- 第 ${round.round || "?"} 轮：${round.query || ""}（${searchRoundStatusText(round)}）`);
      if (round.error) lines.push(`  错误：${round.error}`);
    }
  }

  if (results.length) {
    lines.push("", "来源：");
    for (const [index, result] of results.entries()) {
      const title = result.title || result.url || `来源 ${index + 1}`;
      const url = result.url || "";
      const content = result.content ? ` - ${result.content}` : "";
      lines.push(`${index + 1}. [${title}](${url})${content}`);
    }
  }
  lines.push("");
}

function appendAttachmentMarkdown(lines, attachments, title = "附件") {
  lines.push(`### ${title}`, "");
  for (const [index, attachment] of attachments.entries()) {
    const chunkLabel = attachment.chunked || attachment.chunkCount > 1 ? ` - 已分块 ${attachment.chunkCount} 段` : "";
    lines.push(`${index + 1}. ${attachment.name} (${formatBytes(attachment.size)})${chunkLabel}${attachment.truncated ? " - 已截断" : ""}`);
  }
  lines.push("");
}

function formatExportTime(value) {
  const pad = (number) => String(number).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function modelLabel(model) {
  if (model === "deepseek-v4-pro") return "DeepSeek V4 Pro";
  if (model === "deepseek-v4-flash") return "DeepSeek V4 Flash";
  return "DeepSeek";
}

function responseLabel(message) {
  const label = modelLabel(message.model || state.model);
  const seekName = seekNameForMessage(message);
  const prefix = seekName ? `${seekName} · ${label}` : label;
  return message.thinking ? `${prefix} · 思考` : prefix;
}

function loadThinkingEnabled() {
  const stored = localStorage.getItem(storageKeys.thinkingEnabled);
  if (stored === "1") return true;
  if (stored === "0") return false;
  return normalizeModel(localStorage.getItem(storageKeys.model)) === modelRoutes.expert;
}

function normalizeReasoningEffort(value) {
  return ["low", "high", "max"].includes(value) ? value : "high";
}

function normalizeAgentDisplayMode(value) {
  return value === "detailed" ? "detailed" : "concise";
}

function normalizeAgentPreset(value) {
  return ["full", "auto", "plan"].includes(value) ? value : "full";
}

function agentRunRequestOptions() {
  const preset = normalizeAgentPreset(state.agentPreset);
  return {
    confirmPlan: preset === "plan",
    agentPreset: preset === "auto" ? "auto" : "full",
  };
}

function normalizedEditableAgentPlan(plan) {
  const valid = new Set(editableAgentPhases.map((item) => item.id));
  const items = Array.isArray(plan) ? plan : [];
  const normalized = items
    .map((item) => ({
      id: valid.has(String(item?.id || "")) ? String(item.id) : "critic",
      task: String(item?.task || "").trim().slice(0, 500),
    }))
    .filter((item) => item.task || item.id);
  return normalized.length ? normalized : agentPlanForPreset("full");
}

function agentPlanForPreset(preset) {
  if (preset === "code") {
    return [
      { id: "coder", task: "检查代码、实现路径和工程风险" },
      { id: "reasoner", task: "分析边界条件和架构取舍" },
      { id: "critic", task: "复核漏洞、遗漏和反例" },
    ];
  }
  if (preset === "research") {
    return [
      { id: "researcher", task: "检索资料、事实和来源" },
      { id: "critic", task: "复核来源可靠性和不确定点" },
    ];
  }
  if (preset === "critic") {
    return [{ id: "critic", task: "审查现有想法的风险、漏洞和遗漏" }];
  }
  return [
    { id: "researcher", task: "检索外部资料、背景事实和可引用来源" },
    { id: "coder", task: "检查项目代码、实现路径和相关文件" },
    { id: "reasoner", task: "分析架构取舍、边界条件和方案权衡" },
    { id: "critic", task: "审查风险、遗漏、反例和不确定性" },
  ];
}

function showToast(message, options = {}) {
  const existing = document.querySelector(".toast");
  if (existing) removeWithMotion(existing);
  const tone = options.alert ? "error" : options.tone;
  const toast = document.createElement("div");
  toast.className = "toast";
  if (tone === "error") toast.classList.add("is-error");
  if (tone === "success") toast.classList.add("is-success");
  toast.setAttribute("role", tone === "error" ? "alert" : "status");
  const text = document.createElement("span");
  text.textContent = message;
  toast.append(text);
  if (options.actionText && typeof options.onAction === "function") {
    const action = document.createElement("button");
    action.type = "button";
    action.className = "toast-action";
    action.textContent = options.actionText;
    action.addEventListener("click", () => {
      removeWithMotion(toast);
      options.onAction();
    });
    toast.append(action);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", "关闭提示");
  close.textContent = "×";
  close.addEventListener("click", () => removeWithMotion(toast));
  toast.append(close);
  document.body.append(toast);
  announceStatus(message, { alert: tone === "error" });
  if (tone === "error") haptic("error");
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => removeWithMotion(toast), options.duration || 5000);
}

function announceStatus(message, { alert = false } = {}) {
  const region = alert ? alertLiveRegion : statusLiveRegion;
  if (!region) return;
  region.textContent = "";
  requestAnimationFrame(() => {
    region.textContent = String(message || "");
  });
}

function haptic(kind = "light") {
  if (!navigator.vibrate) return;
  const pattern = kind === "error" ? [20, 30, 20] : kind === "heavy" ? 30 : 12;
  navigator.vibrate(pattern);
}

function confirmAction({ title = "确认操作", message = "", okText = "确认", cancelText = "取消", danger = false } = {}) {
  if (!confirmDialog || !confirmOkButton || !confirmCancelButton) {
    return Promise.resolve(true);
  }
  confirmDialogTitle.textContent = title;
  confirmDialogMessage.textContent = message;
  confirmOkButton.textContent = okText;
  confirmCancelButton.textContent = cancelText;
  confirmOkButton.classList.toggle("danger-button", danger);
  confirmOkButton.classList.toggle("primary-button", !danger);
  confirmDialog.hidden = false;
  confirmDialog.setAttribute("aria-hidden", "false");
  activateFocusTrap(confirmDialog);
  requestAnimationFrame(() => confirmOkButton.focus());
  return new Promise((resolve) => {
    state.confirmResolve = resolve;
  });
}

function resolveConfirmDialog(value) {
  if (!state.confirmResolve) return;
  const resolve = state.confirmResolve;
  state.confirmResolve = null;
  confirmDialog.hidden = true;
  confirmDialog.setAttribute("aria-hidden", "true");
  deactivateFocusTrap(confirmDialog);
  if (value) haptic("heavy");
  resolve(Boolean(value));
}

function isConfirmDialogOpen() {
  return Boolean(confirmDialog && !confirmDialog.hidden);
}

function openShortcutPanel() {
  if (!shortcutPanel) return;
  shortcutPanel.hidden = false;
  shortcutPanel.setAttribute("aria-hidden", "false");
  activateFocusTrap(shortcutPanel);
  requestAnimationFrame(() => closeShortcutPanelButton?.focus());
}

function closeShortcutPanel() {
  if (!shortcutPanel) return;
  shortcutPanel.hidden = true;
  shortcutPanel.setAttribute("aria-hidden", "true");
  deactivateFocusTrap(shortcutPanel);
}

function isShortcutPanelOpen() {
  return Boolean(shortcutPanel && !shortcutPanel.hidden);
}

function activateFocusTrap(container) {
  if (!container) return;
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const current = state.focusTrapStack[state.focusTrapStack.length - 1];
  // Nested dialogs reuse the same tab trap machinery; keep a stack so closing
  // a confirmation dialog restores the panel trap underneath instead of
  // dropping focus control completely.
  if (current?.container === container) {
    current.previous = previous || current.previous;
  } else {
    state.focusTrapStack.push({ container, previous });
  }
  state.previousFocus = previous || state.previousFocus;
  state.focusTrap = container;
}

function deactivateFocusTrap(container) {
  const entryIndex = state.focusTrapStack.map((entry) => entry.container).lastIndexOf(container);
  if (entryIndex < 0) {
    if (state.focusTrap === container) {
      state.focusTrap = null;
      state.previousFocus = null;
    }
    return;
  }
  const [entry] = state.focusTrapStack.splice(entryIndex, 1);
  const removedTop = entryIndex === state.focusTrapStack.length;
  const current = state.focusTrapStack[state.focusTrapStack.length - 1] || null;
  state.focusTrap = current?.container || null;
  state.previousFocus = current?.previous || null;
  if (removedTop && entry.previous?.isConnected) {
    requestAnimationFrame(() => entry.previous.focus());
  }
}

function trapFocusWithin(event, container) {
  const focusables = focusableElements(container);
  if (!focusables.length) {
    event.preventDefault();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function focusableElements(container) {
  return Array.from(
    container.querySelectorAll("a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex='-1'])")
  ).filter((element) => element instanceof HTMLElement && !element.hidden && element.offsetParent !== null);
}

function removeWithMotion(node) {
  if (!node?.isConnected) return;
  node.classList.add("is-exiting");
  const removeDelay = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? 1 : 160;
  window.setTimeout(() => node.remove(), removeDelay);
}
