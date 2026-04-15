const MAX_FILES = 80;
const MAX_FILE_SIZE = 150 * 1024 * 1024;
const PREVIEW_LIMIT = 12000;

const elements = {
    fileInput: document.getElementById("fileInput"),
    dropZone: document.getElementById("dropZone"),
    includeMetadata: document.getElementById("includeMetadata"),
    includeChapterBreaks: document.getElementById("includeChapterBreaks"),
    normalizeWhitespace: document.getElementById("normalizeWhitespace"),
    totalCount: document.getElementById("totalCount"),
    successCount: document.getElementById("successCount"),
    errorCount: document.getElementById("errorCount"),
    progressLabel: document.getElementById("progressLabel"),
    progressCount: document.getElementById("progressCount"),
    progressFill: document.getElementById("progressFill"),
    emptyState: document.getElementById("emptyState"),
    fileList: document.getElementById("fileList"),
    metadataList: document.getElementById("metadataList"),
    previewContent: document.getElementById("previewContent"),
    previewSearch: document.getElementById("previewSearch"),
    searchResult: document.getElementById("searchResult"),
    copyBtn: document.getElementById("copyBtn"),
    openPreviewBtn: document.getElementById("openPreviewBtn"),
    clearBtn: document.getElementById("clearBtn"),
    resetBtn: document.getElementById("resetBtn"),
    downloadAllBtn: document.getElementById("downloadAllBtn"),
    exportSummary: document.getElementById("exportSummary"),
    logArea: document.getElementById("logArea"),
    previewDialog: document.getElementById("previewDialog"),
    dialogTitle: document.getElementById("dialogTitle"),
    dialogContent: document.getElementById("dialogContent"),
    closePreviewBtn: document.getElementById("closePreviewBtn")
};

const statusCopy = {
    pending: "대기",
    analyzing: "분석",
    processing: "추출",
    success: "완료",
    error: "실패",
    skipped: "제외"
};

let jobs = [];
let logs = [];
let selectedJobId = null;
let dragDepth = 0;
let isProcessing = false;
let lastPreviewTrigger = null;

const timeFormatter = new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
});

const getOptions = () => ({
    includeMetadata: elements.includeMetadata.checked,
    includeChapterBreaks: elements.includeChapterBreaks.checked,
    normalizeWhitespace: elements.normalizeWhitespace.checked
});

const yieldToBrowser = () => new Promise((resolve) => requestAnimationFrame(resolve));

const formatBytes = (bytes) => {
    if (bytes === 0) return "0 B";

    const units = ["B", "KB", "MB", "GB"];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / 1024 ** exponent;

    return `${new Intl.NumberFormat("ko-KR", { maximumFractionDigits: exponent === 0 ? 0 : 1 }).format(value)} ${units[exponent]}`;
};

const addLog = (message) => {
    const timestamp = timeFormatter.format(new Date());
    logs.push(`[${timestamp}] ${message}`);
    elements.logArea.textContent = logs.join("\n");
    elements.logArea.scrollTop = elements.logArea.scrollHeight;
};

const sanitizeText = (value, fallback = "정보 없음") => {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text || fallback;
};

const sanitizeFileBase = (name) => {
    const withoutExtension = name.replace(/\.epub$/i, "");
    const safe = withoutExtension
        .replace(/[\\/:*?"<>|]/g, "-")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 110);

    return safe || "converted-epub";
};

const makeUniqueTxtName = (fileName, registry) => {
    const base = sanitizeFileBase(fileName);
    let candidate = `${base}.txt`;
    let suffix = 2;

    while (registry.has(candidate.toLowerCase())) {
        candidate = `${base}-${suffix}.txt`;
        suffix += 1;
    }

    registry.add(candidate.toLowerCase());
    return candidate;
};

const setJobStatus = (job, status, message = "") => {
    job.status = status;
    job.message = message;
    render();
};

const getSelectedJob = () => jobs.find((job) => job.id === selectedJobId) || null;

const getSuccessfulJobs = () => jobs
    .filter((job) => job.status === "success" && job.content)
    .sort((a, b) => a.index - b.index);

const resetAll = () => {
    jobs = [];
    logs = [];
    selectedJobId = null;
    isProcessing = false;
    elements.fileInput.value = "";
    elements.previewSearch.value = "";
    elements.logArea.textContent = "";
    render();
};

const createTextElement = (tagName, className, text) => {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = text;
    return element;
};

const createButton = (label, className, onClick, options = {}) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.disabled = Boolean(options.disabled);
    if (options.ariaLabel) button.setAttribute("aria-label", options.ariaLabel);
    button.addEventListener("click", onClick);
    return button;
};

const createFileItem = (job) => {
    const item = document.createElement("article");
    item.className = "file-item";
    item.dataset.status = job.status;
    item.dataset.selected = String(job.id === selectedJobId);

    const main = document.createElement("div");
    main.className = "file-main";

    const name = createTextElement("span", "file-name", job.file.name);
    name.title = job.file.name;

    const metaPieces = [
        formatBytes(job.file.size),
        job.outputName,
        job.metadata?.title && job.metadata.title !== "정보 없음" ? job.metadata.title : ""
    ].filter(Boolean);
    const meta = createTextElement("p", "file-meta", metaPieces.join(" · "));

    main.append(name, meta);

    if (job.message) {
        main.appendChild(createTextElement("p", "file-error", job.message));
    }

    const actions = document.createElement("div");
    actions.className = "file-actions";

    const status = createTextElement("span", "status-pill", statusCopy[job.status] || job.status);
    status.dataset.status = job.status;
    actions.appendChild(status);

    actions.appendChild(createButton("보기", "row-button", () => selectJob(job.id), {
        disabled: job.status !== "success",
        ariaLabel: `${job.file.name} 결과 보기`
    }));

    actions.appendChild(createButton("TXT", "row-button", () => downloadJob(job), {
        disabled: job.status !== "success",
        ariaLabel: `${job.file.name} TXT 다운로드`
    }));

    actions.appendChild(createButton("재시도", "row-button", () => retryJob(job.id), {
        disabled: isProcessing || !["error", "skipped"].includes(job.status),
        ariaLabel: `${job.file.name} 다시 변환`
    }));

    item.append(main, actions);
    return item;
};

const renderMetadata = (job) => {
    elements.metadataList.replaceChildren();

    const rows = job?.status === "success"
        ? [
            ["제목", job.metadata.title],
            ["저자", job.metadata.creator],
            ["언어", job.metadata.language],
            ["분량", `${job.chapterCount}개 챕터 · ${new Intl.NumberFormat("ko-KR").format(job.charCount)}자`]
        ]
        : [
            ["상태", job ? statusCopy[job.status] : "대기"],
            ["파일", job ? job.file.name : "선택 없음"]
        ];

    rows.forEach(([term, detail]) => {
        elements.metadataList.append(
            createTextElement("dt", "", term),
            createTextElement("dd", "", sanitizeText(detail))
        );
    });
};

const updateSearch = () => {
    const job = getSelectedJob();
    const query = elements.previewSearch.value.trim().toLocaleLowerCase();

    if (!job || job.status !== "success") {
        elements.searchResult.textContent = "변환된 파일을 선택하세요.";
        return;
    }

    if (!query) {
        elements.searchResult.textContent = "검색어를 입력하면 포함 횟수를 계산합니다.";
        return;
    }

    const count = job.content.toLocaleLowerCase().split(query).length - 1;
    elements.searchResult.textContent = `${new Intl.NumberFormat("ko-KR").format(count)}회 발견`;
};

const renderPreview = () => {
    const job = getSelectedJob();
    renderMetadata(job);

    const isSuccess = job?.status === "success";
    elements.copyBtn.disabled = !isSuccess;
    elements.openPreviewBtn.disabled = !isSuccess;
    elements.previewSearch.disabled = !isSuccess;

    if (!job) {
        elements.previewContent.textContent = "변환 결과가 여기에 표시됩니다.";
        updateSearch();
        return;
    }

    if (!isSuccess) {
        elements.previewContent.textContent = job.message || `${statusCopy[job.status]} 상태입니다.`;
        updateSearch();
        return;
    }

    const clipped = job.content.length > PREVIEW_LIMIT;
    const preview = clipped
        ? `${job.content.slice(0, PREVIEW_LIMIT)}\n\n[미리보기는 ${new Intl.NumberFormat("ko-KR").format(PREVIEW_LIMIT)}자까지만 표시합니다. 전체 보기를 사용하세요.]`
        : job.content;

    elements.previewContent.textContent = preview;
    updateSearch();
};

const renderDashboard = () => {
    const total = jobs.length;
    const success = jobs.filter((job) => job.status === "success").length;
    const failed = jobs.filter((job) => ["error", "skipped"].includes(job.status)).length;
    const completed = success + failed;
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
    const successfulJobs = getSuccessfulJobs();

    elements.totalCount.textContent = String(total);
    elements.successCount.textContent = String(success);
    elements.errorCount.textContent = String(failed);
    elements.progressCount.textContent = `${completed}/${total}`;
    elements.progressFill.style.width = `${progress}%`;
    elements.progressLabel.textContent = isProcessing ? "변환 중" : total > 0 ? "처리 완료" : "대기 중";

    elements.clearBtn.disabled = isProcessing || total === 0;
    elements.resetBtn.disabled = isProcessing || total === 0;
    elements.downloadAllBtn.disabled = successfulJobs.length === 0 || isProcessing;
    elements.downloadAllBtn.textContent = successfulJobs.length > 1 ? "ZIP 다운로드" : "TXT 다운로드";

    if (isProcessing) {
        elements.exportSummary.textContent = "파일을 순서대로 분석하고 TXT를 생성하는 중입니다.";
    } else if (successfulJobs.length > 0 && failed > 0) {
        elements.exportSummary.textContent = `${success}개 성공, ${failed}개 실패. 성공한 파일만 내려받을 수 있습니다.`;
    } else if (successfulJobs.length > 0) {
        elements.exportSummary.textContent = `${success}개 TXT 파일을 다운로드할 수 있습니다.`;
    } else if (failed > 0) {
        elements.exportSummary.textContent = "성공한 파일이 없습니다. 오류 메시지를 확인하고 재시도하세요.";
    } else {
        elements.exportSummary.textContent = "성공한 TXT 파일이 있으면 다운로드할 수 있습니다.";
    }
};

const render = () => {
    elements.emptyState.classList.toggle("hidden", jobs.length > 0);
    elements.fileList.replaceChildren(...jobs.map(createFileItem));
    renderDashboard();
    renderPreview();
};

const selectJob = (jobId) => {
    selectedJobId = jobId;
    elements.previewSearch.value = "";
    render();
};

const parseXml = (source, label) => {
    const doc = new DOMParser().parseFromString(source, "application/xml");
    const parserError = doc.getElementsByTagName("parsererror")[0];

    if (parserError) {
        throw new Error(`${label} XML을 읽을 수 없습니다.`);
    }

    return doc;
};

const getElementsByLocalName = (root, localName) => Array
    .from(root.getElementsByTagName("*"))
    .filter((element) => element.localName === localName);

const getFirstByLocalName = (root, localName) => getElementsByLocalName(root, localName)[0] || null;

const decodeZipPath = (value) => {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
};

const normalizeEntryName = (value) => value.replace(/\\/g, "/").replace(/^\/+/, "");

const resolveZipPath = (baseDir, href) => {
    const cleanHref = decodeZipPath(String(href || "").split("#")[0].split("?")[0]);
    const combined = normalizeEntryName(baseDir ? `${baseDir}/${cleanHref}` : cleanHref);
    const parts = [];

    combined.split("/").forEach((part) => {
        if (!part || part === ".") return;
        if (part === "..") {
            parts.pop();
            return;
        }
        parts.push(part);
    });

    return parts.join("/");
};

const findZipEntry = (zip, requestedPath) => {
    const normalized = normalizeEntryName(requestedPath);
    const direct = zip.file(normalized);
    if (direct) return direct;

    const lowerPath = normalized.toLocaleLowerCase();
    return Object.values(zip.files).find((entry) => (
        !entry.dir && normalizeEntryName(entry.name).toLocaleLowerCase() === lowerPath
    )) || null;
};

const assertZipSignature = async (file) => {
    const bytes = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;

    if (!isZip) {
        throw new Error("EPUB ZIP 구조가 아닙니다. 파일이 손상되었거나 형식이 다릅니다.");
    }
};

const extractMetadata = (opfDoc) => {
    const metadataRoot = getFirstByLocalName(opfDoc, "metadata") || opfDoc;
    const read = (localName) => {
        const element = getFirstByLocalName(metadataRoot, localName);
        return sanitizeText(element?.textContent);
    };

    return {
        title: read("title"),
        creator: read("creator"),
        language: read("language")
    };
};

const normalizeExtractedText = (text, shouldNormalize) => {
    const normalizedLines = text
        .replace(/\u00a0/g, " ")
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => shouldNormalize ? line.replace(/[ \t\f\v]+/g, " ").trim() : line)
        .join("\n");

    return shouldNormalize
        ? normalizedLines.replace(/\n{3,}/g, "\n\n").trim()
        : normalizedLines.trim();
};

const getChapterTitle = (htmlDoc, fallback) => {
    const heading = htmlDoc.querySelector("h1, h2, h3, title");
    return sanitizeText(heading?.textContent, fallback);
};

const extractChapter = async (entry, chapterNumber, options) => {
    const htmlSource = await entry.async("string");
    const htmlDoc = new DOMParser().parseFromString(htmlSource, "text/html");

    htmlDoc.querySelectorAll("script, style").forEach((element) => element.remove());

    const body = htmlDoc.body;
    if (!body) {
        return null;
    }

    const title = getChapterTitle(htmlDoc, `Chapter ${chapterNumber}`);
    const text = normalizeExtractedText(body.innerText || body.textContent || "", options.normalizeWhitespace);

    if (!text) {
        return null;
    }

    return { title, text };
};

const buildMetadataBlock = (metadata, sourceName) => [
    `파일: ${sourceName}`,
    `제목: ${metadata.title}`,
    `저자: ${metadata.creator}`,
    `언어: ${metadata.language}`
].join("\n");

const buildTextOutput = (chapters, metadata, sourceName, options) => {
    const parts = [];

    if (options.includeMetadata) {
        parts.push(buildMetadataBlock(metadata, sourceName));
    }

    chapters.forEach((chapter, index) => {
        if (options.includeChapterBreaks) {
            parts.push(`[Chapter ${index + 1}] ${chapter.title}`);
        }
        parts.push(chapter.text);
    });

    return parts.join("\n\n").trim();
};

const convertEpubToText = async (file, options) => {
    if (!window.JSZip) {
        throw new Error("JSZip 라이브러리를 불러오지 못했습니다. 네트워크 연결을 확인하세요.");
    }

    await assertZipSignature(file);

    const zip = await window.JSZip.loadAsync(file);
    const containerEntry = findZipEntry(zip, "META-INF/container.xml");
    if (!containerEntry) {
        throw new Error("META-INF/container.xml을 찾을 수 없습니다.");
    }

    const containerDoc = parseXml(await containerEntry.async("string"), "container.xml");
    const rootfile = getElementsByLocalName(containerDoc, "rootfile")
        .find((element) => element.getAttribute("full-path"));

    if (!rootfile) {
        throw new Error("OPF 경로가 container.xml에 없습니다.");
    }

    const rootfilePath = normalizeEntryName(decodeZipPath(rootfile.getAttribute("full-path")));
    const opfEntry = findZipEntry(zip, rootfilePath);
    if (!opfEntry) {
        throw new Error(`OPF 파일을 찾을 수 없습니다: ${rootfilePath}`);
    }

    const opfDoc = parseXml(await opfEntry.async("string"), "OPF");
    const opfDir = rootfilePath.includes("/") ? rootfilePath.slice(0, rootfilePath.lastIndexOf("/")) : "";
    const metadata = extractMetadata(opfDoc);
    const manifestRoot = getFirstByLocalName(opfDoc, "manifest");
    const spineRoot = getFirstByLocalName(opfDoc, "spine");

    if (!manifestRoot || !spineRoot) {
        throw new Error("OPF manifest 또는 spine 정보를 찾을 수 없습니다.");
    }

    const manifest = new Map();
    Array.from(manifestRoot.children)
        .filter((element) => element.localName === "item")
        .forEach((item) => {
            const id = item.getAttribute("id");
            const href = item.getAttribute("href");
            if (!id || !href) return;

            manifest.set(id, {
                href,
                mediaType: item.getAttribute("media-type") || ""
            });
        });

    const spineRefs = Array.from(spineRoot.children).filter((element) => element.localName === "itemref");
    if (spineRefs.length === 0) {
        throw new Error("읽을 spine 항목이 없습니다.");
    }

    const chapters = [];

    for (const [index, spineRef] of spineRefs.entries()) {
        const idref = spineRef.getAttribute("idref");
        const manifestItem = manifest.get(idref);
        if (!manifestItem) continue;

        const mediaType = manifestItem.mediaType.toLocaleLowerCase();
        if (mediaType && !mediaType.includes("html") && !mediaType.includes("xml")) continue;

        const chapterPath = resolveZipPath(opfDir, manifestItem.href);
        const chapterEntry = findZipEntry(zip, chapterPath);
        if (!chapterEntry) continue;

        const chapter = await extractChapter(chapterEntry, index + 1, options);
        if (chapter) chapters.push(chapter);
    }

    if (chapters.length === 0) {
        throw new Error("본문 텍스트를 추출할 수 있는 챕터가 없습니다.");
    }

    const content = buildTextOutput(chapters, metadata, file.name, options);

    return {
        content,
        metadata,
        chapterCount: chapters.length,
        charCount: content.length,
        wordCount: content.split(/\s+/).filter(Boolean).length
    };
};

const prepareJobs = (files) => {
    const registry = new Set();
    const accepted = [];
    const limitedFiles = files.slice(0, MAX_FILES);

    if (files.length > MAX_FILES) {
        addLog(`${MAX_FILES}개를 초과한 파일은 이번 변환에서 제외했습니다.`);
    }

    limitedFiles.forEach((file, index) => {
        if (!file.name.toLocaleLowerCase().endsWith(".epub")) {
            addLog(`${file.name}: .epub 파일만 처리합니다.`);
            return;
        }

        if (file.size === 0) {
            addLog(`${file.name}: 빈 파일은 처리할 수 없습니다.`);
            return;
        }

        if (file.size > MAX_FILE_SIZE) {
            addLog(`${file.name}: ${formatBytes(MAX_FILE_SIZE)}보다 큰 파일은 제외했습니다.`);
            return;
        }

        accepted.push({
            id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`,
            index: accepted.length,
            file,
            outputName: makeUniqueTxtName(file.name, registry),
            status: "pending",
            message: "",
            content: "",
            metadata: null,
            chapterCount: 0,
            charCount: 0,
            wordCount: 0
        });
    });

    return accepted;
};

const processFiles = async (fileList) => {
    if (isProcessing) {
        addLog("이미 변환 중입니다. 현재 작업이 끝난 뒤 다시 시도하세요.");
        return;
    }

    logs = [];
    elements.logArea.textContent = "";

    const nextJobs = prepareJobs(Array.from(fileList));
    if (nextJobs.length === 0) {
        render();
        return;
    }

    jobs = nextJobs;
    selectedJobId = jobs[0].id;
    isProcessing = true;
    addLog(`${jobs.length}개 파일 처리를 시작합니다.`);
    render();

    const options = getOptions();

    for (const job of jobs) {
        setJobStatus(job, "analyzing", "EPUB 구조를 확인하는 중입니다.");
        await yieldToBrowser();

        try {
            setJobStatus(job, "processing", "본문을 추출하는 중입니다.");
            const result = await convertEpubToText(job.file, options);
            Object.assign(job, result);
            selectedJobId = job.id;
            setJobStatus(job, "success", "");
            addLog(`${job.file.name}: ${job.chapterCount}개 챕터, ${new Intl.NumberFormat("ko-KR").format(job.charCount)}자 추출 완료`);
        } catch (error) {
            setJobStatus(job, "error", error.message || "알 수 없는 오류가 발생했습니다.");
            addLog(`${job.file.name}: ${job.message}`);
        }

        await yieldToBrowser();
    }

    isProcessing = false;
    addLog("처리가 끝났습니다.");
    render();
};

const retryJob = async (jobId) => {
    const job = jobs.find((candidate) => candidate.id === jobId);
    if (!job || isProcessing) return;

    isProcessing = true;
    selectedJobId = job.id;
    setJobStatus(job, "processing", "재시도 중입니다.");
    addLog(`${job.file.name}: 재시도합니다.`);

    try {
        const result = await convertEpubToText(job.file, getOptions());
        Object.assign(job, result);
        setJobStatus(job, "success", "");
        addLog(`${job.file.name}: 재시도 성공`);
    } catch (error) {
        setJobStatus(job, "error", error.message || "재시도에 실패했습니다.");
        addLog(`${job.file.name}: ${job.message}`);
    }

    isProcessing = false;
    render();
};

const triggerDownload = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const downloadJob = (job) => {
    if (job.status !== "success" || !job.content) return;
    const blob = new Blob([job.content], { type: "text/plain;charset=utf-8" });
    triggerDownload(blob, job.outputName);
};

const downloadAll = async () => {
    const successfulJobs = getSuccessfulJobs();
    if (successfulJobs.length === 0 || isProcessing) return;

    if (successfulJobs.length === 1) {
        downloadJob(successfulJobs[0]);
        return;
    }

    if (!window.JSZip) {
        addLog("ZIP 다운로드에 필요한 JSZip을 불러오지 못했습니다.");
        return;
    }

    elements.downloadAllBtn.disabled = true;
    elements.downloadAllBtn.textContent = "압축 중";

    const zip = new window.JSZip();
    successfulJobs.forEach((job) => {
        zip.file(job.outputName, job.content);
    });

    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, `epub-txt-${Date.now()}.zip`);
    render();
};

const copySelected = async () => {
    const job = getSelectedJob();
    if (!job?.content) return;

    try {
        await navigator.clipboard.writeText(job.content);
        addLog(`${job.outputName}: 클립보드에 복사했습니다.`);
    } catch {
        addLog("브라우저가 클립보드 복사를 허용하지 않았습니다.");
    }
};

const openPreviewDialog = () => {
    const job = getSelectedJob();
    if (!job?.content || elements.previewDialog.open) return;

    lastPreviewTrigger = document.activeElement;
    elements.dialogTitle.textContent = job.outputName;
    elements.dialogContent.textContent = job.content;
    elements.previewDialog.showModal();
    elements.closePreviewBtn.focus();
};

const closePreviewDialog = () => {
    elements.previewDialog.close();
};

elements.dropZone.addEventListener("click", () => elements.fileInput.click());

elements.dropZone.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    elements.fileInput.click();
});

elements.dropZone.addEventListener("dragenter", (event) => {
    event.preventDefault();
    dragDepth += 1;
    elements.dropZone.classList.add("drag-over");
});

elements.dropZone.addEventListener("dragleave", (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
        elements.dropZone.classList.remove("drag-over");
    }
});

elements.dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
});

elements.dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    elements.dropZone.classList.remove("drag-over");
    processFiles(event.dataTransfer.files);
});

elements.fileInput.addEventListener("change", (event) => {
    processFiles(event.target.files);
});

elements.previewSearch.addEventListener("input", updateSearch);
elements.copyBtn.addEventListener("click", copySelected);
elements.openPreviewBtn.addEventListener("click", openPreviewDialog);
elements.closePreviewBtn.addEventListener("click", closePreviewDialog);
elements.previewDialog.addEventListener("close", () => {
    if (lastPreviewTrigger && typeof lastPreviewTrigger.focus === "function") {
        lastPreviewTrigger.focus();
    }
});

elements.clearBtn.addEventListener("click", resetAll);
elements.resetBtn.addEventListener("click", resetAll);
elements.downloadAllBtn.addEventListener("click", downloadAll);

[elements.includeMetadata, elements.includeChapterBreaks, elements.normalizeWhitespace].forEach((control) => {
    control.addEventListener("change", () => {
        if (jobs.length > 0 && !isProcessing) {
            addLog("옵션 변경은 다음 변환 또는 재시도부터 적용됩니다.");
        }
    });
});

render();
