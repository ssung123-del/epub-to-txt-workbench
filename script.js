/* ═══════════════════════════════════════════════════════════════════
   EPUB Workbench 2026 — 완전한 Vanilla JS 구현
   ═══════════════════════════════════════════════════════════════════
   서버 없이 브라우저에서 EPUB → TXT / Markdown / JSON / HTML 변환.
   JSZip은 CDN으로 로드됨 (index.html에서 script 태그로 포함).
   ═══════════════════════════════════════════════════════════════════ */

// ─── 상수 정의 ───
const MAX_FILES = 80;
const MAX_FILE_SIZE = 150 * 1024 * 1024; // 150MB
const PREVIEW_LIMIT = 12000; // 미리보기 글자 제한
const HISTORY_DB = 'epub-workbench-history';
const HISTORY_STORE = 'records';
const HISTORY_MAX = 100;
const THEME_KEY = 'epub-wb-theme';

// 한국어 조사/기능어 필터 — 단어 빈도에서 의미 없는 토큰 제거 목적
const KOREAN_STOP_WORDS = new Set([
  '은', '는', '이', '가', '을', '를', '의', '에', '와', '과',
  '도', '로', '으로', '에서', '까지', '부터', '한', '된', '할',
  '하는', '있는', '없는', '것', '수', '등', '및', '또는'
]);

// 상태 라벨 매핑 — UI에 한국어 상태 표시
const statusCopy = {
  pending: '대기', analyzing: '분석', processing: '추출',
  success: '완료', error: '실패', skipped: '제외'
};

// ─── 전역 상태 ───
let jobs = [];
let logs = [];
let selectedJobId = null;
let dragDepth = 0;         // 중첩 드래그 이벤트 카운트용
let isProcessing = false;  // 다중 파일 동시 처리 방지
let lastPreviewTrigger = null;
let currentTheme = 'auto';

// ─── 유틸리티: DOM 헬퍼 ───
/** getElementById 축약 */
const $ = (id) => document.getElementById(id);

/** 브라우저에 렌더링 기회를 주는 비동기 양보 — 대량 처리 시 UI 멈춤 방지 */
function yieldToBrowser() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

/** 바이트를 사람이 읽기 쉬운 형식으로 변환 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  // 1024 단위로 나눠서 적절한 단위 선택
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

/** 타임스탬프 포함 로그 추가 — 사용자에게 처리 과정 투명하게 보여줌 */
function addLog(message) {
  const ts = new Date().toLocaleTimeString('ko-KR');
  const entry = `[${ts}] ${message}`;
  logs.push(entry);
  const logArea = $('logArea');
  if (logArea) {
    const line = document.createElement('div');
    line.textContent = entry;
    logArea.appendChild(line);
    logArea.scrollTop = logArea.scrollHeight;
  }
}

/** 텍스트 정리 — null/undefined 안전 처리 */
function sanitizeText(value, fallback = '') {
  if (!value || typeof value !== 'string') return fallback;
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim() || fallback;
}

/** 파일명에서 안전한 베이스 이름 생성 — 특수문자 제거 */
function sanitizeFileBase(name) {
  return name
    .replace(/\.epub$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/_+/g, '_')
    .trim() || 'output';
}

/** 중복 방지 출력 파일명 생성 — 같은 이름 파일이 여러 개일 때 번호 부여 */
function makeUniqueTxtName(fileName, registry, ext = '.txt') {
  const base = sanitizeFileBase(fileName);
  let candidate = base + ext;
  let counter = 1;
  while (registry.has(candidate)) {
    candidate = `${base}_${counter}${ext}`;
    counter++;
  }
  registry.add(candidate);
  return candidate;
}

// ─── 유틸리티: XML 파싱 ───
/** XML 문자열을 DOM으로 파싱 — 에러 시 null 반환 */
function parseXml(source, label = 'XML') {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(source, 'application/xml');
    // parseFromString은 파싱 실패 시 parsererror 요소를 생성
    if (doc.querySelector('parsererror')) {
      addLog(`⚠ ${label} 파싱 오류 감지, HTML 모드로 재시도`);
      return parser.parseFromString(source, 'text/html');
    }
    return doc;
  } catch (e) {
    addLog(`✖ ${label} 파싱 실패: ${e.message}`);
    return null;
  }
}

/** 네임스페이스 무시하고 localName으로 요소 검색 — EPUB의 혼합 네임스페이스 대응 */
function getElementsByLocalName(root, name) {
  if (!root) return [];
  return Array.from(root.getElementsByTagName('*')).filter(
    (el) => el.localName === name
  );
}

function getFirstByLocalName(root, name) {
  return getElementsByLocalName(root, name)[0] || null;
}

// ─── 유틸리티: ZIP 경로 처리 ───
/** URL-인코딩된 ZIP 경로 디코딩 — 한글 파일명 등 처리 */
function decodeZipPath(value) {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

/** ZIP 엔트리 이름 정규화 — 선행 슬래시 제거, 디코딩 */
function normalizeEntryName(value) {
  return decodeZipPath(value).replace(/^\/+/, '');
}

/** 상대 경로를 기준 디렉토리 기반으로 절대 경로로 변환 */
function resolveZipPath(baseDir, href) {
  const decoded = decodeZipPath(href);
  // 프래그먼트(#) 제거
  const clean = decoded.split('#')[0];
  if (!baseDir) return clean;
  // 상대경로를 기준 디렉토리와 결합
  const parts = (baseDir + '/' + clean).split('/');
  const resolved = [];
  for (const p of parts) {
    if (p === '..') resolved.pop();
    else if (p && p !== '.') resolved.push(p);
  }
  return resolved.join('/');
}

/** 대소문자 무시 ZIP 엔트리 검색 — 일부 EPUB 도구의 비표준 대소문자 처리 */
function findZipEntry(zip, path) {
  const normalized = normalizeEntryName(path);
  // 정확한 매치 우선
  let entry = zip.file(normalized);
  if (entry) return entry;
  // 대소문자 무시 검색
  const lower = normalized.toLowerCase();
  const files = zip.file(/.*/);
  for (const f of files) {
    if (normalizeEntryName(f.name).toLowerCase() === lower) return f;
  }
  return null;
}

/** EPUB 파일의 ZIP 시그니처 검증 — PK 헤더 확인으로 손상 파일 조기 차단 */
async function assertZipSignature(file) {
  const header = await file.slice(0, 4).arrayBuffer();
  const view = new DataView(header);
  // ZIP 파일은 PK\x03\x04 (0x04034b50) 시그니처로 시작
  if (view.getUint32(0, true) !== 0x04034b50) {
    throw new Error('유효한 ZIP/EPUB 파일이 아닙니다 (PK 시그니처 없음)');
  }
}

// ─── EPUB 메타데이터 추출 ───
/** OPF 문서에서 책 메타데이터 추출 — dc:title, dc:creator, dc:language */
function extractMetadata(opfDoc) {
  const meta = { title: '(제목 없음)', creator: '(저자 미상)', language: '' };
  if (!opfDoc) return meta;
  const titleEl = getFirstByLocalName(opfDoc, 'title');
  if (titleEl) meta.title = sanitizeText(titleEl.textContent, meta.title);
  const creatorEl = getFirstByLocalName(opfDoc, 'creator');
  if (creatorEl) meta.creator = sanitizeText(creatorEl.textContent, meta.creator);
  const langEl = getFirstByLocalName(opfDoc, 'language');
  if (langEl) meta.language = sanitizeText(langEl.textContent, '');
  return meta;
}

// ─── 텍스트 정규화 ───
/** 추출된 텍스트의 공백/빈줄 정리 — 사용자 옵션에 따라 조건부 적용 */
function normalizeExtractedText(text, shouldNormalize) {
  if (!text) return '';
  // HTML 엔티티 기본 처리
  let result = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
  if (shouldNormalize) {
    // 연속 빈줄을 2줄로, 연속 공백을 1개로
    result = result
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .split('\n')
      .map((l) => l.trim())
      .join('\n')
      .trim();
  }
  return result;
}

// ─── 챕터 제목/내용 추출 ───
/** HTML 문서에서 챕터 제목 추출 — h1 → h2 → h3 → title 순서로 탐색 */
function getChapterTitle(htmlDoc, fallback) {
  if (!htmlDoc) return fallback;
  for (const tag of ['h1', 'h2', 'h3']) {
    const el = htmlDoc.querySelector(tag);
    if (el) {
      const text = sanitizeText(el.textContent);
      if (text) return text;
    }
  }
  const titleEl = htmlDoc.querySelector('title');
  if (titleEl) {
    const text = sanitizeText(titleEl.textContent);
    if (text) return text;
  }
  return fallback;
}

/** ZIP 엔트리에서 챕터 텍스트 추출 — HTML 태그 제거, 공백 정규화 */
async function extractChapter(entry, num, options) {
  const html = await entry.async('string');
  const doc = parseXml(html, `Chapter ${num}`);
  const fallback = `Chapter ${num}`;
  const title = getChapterTitle(doc, fallback);

  // body에서 텍스트 추출 (태그 제거)
  let text = '';
  if (doc) {
    const body = doc.querySelector('body') || doc.documentElement;
    text = body ? body.textContent : '';
  } else {
    // 파싱 실패 시 태그 수동 제거
    text = html.replace(/<[^>]*>/g, ' ');
  }
  text = normalizeExtractedText(text, options.normalizeWhitespace);
  return { title, text };
}

// ─── 포맷 관련 유틸리티 ───
/** 현재 선택된 출력 포맷 반환 */
function getSelectedFormat() {
  const radio = document.querySelector('input[name="outputFormat"]:checked');
  return radio ? radio.value : 'txt';
}

/** 포맷에 대응하는 파일 확장자 반환 */
function getFormatExtension(format) {
  const map = { txt: '.txt', markdown: '.md', json: '.json', html: '.html' };
  return map[format] || '.txt';
}

// ─── 출력 빌더: TXT ───
function buildTxtOutput(chapters, metadata, sourceName, options) {
  const lines = [];
  if (options.includeMetadata) {
    lines.push(`파일: ${sourceName}`);
    lines.push(`제목: ${metadata.title}`);
    lines.push(`저자: ${metadata.creator}`);
    if (metadata.language) lines.push(`언어: ${metadata.language}`);
    lines.push('', '');
  }
  chapters.forEach((ch, i) => {
    if (i > 0 && options.includeChapterBreaks) {
      lines.push('', '═'.repeat(60), '');
    }
    lines.push(`[Chapter ${i + 1}] ${ch.title}`);
    lines.push(ch.text);
    lines.push('');
  });
  return lines.join('\n').trim();
}

// ─── 출력 빌더: Markdown ───
function buildMarkdownOutput(chapters, metadata, sourceName, options) {
  const lines = [];
  // YAML frontmatter
  lines.push('---');
  lines.push(`title: "${metadata.title.replace(/"/g, '\\"')}"`);
  lines.push(`author: "${metadata.creator.replace(/"/g, '\\"')}"`);
  if (metadata.language) lines.push(`language: "${metadata.language}"`);
  lines.push(`source: "${sourceName}"`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${metadata.title}`);
  lines.push('');
  chapters.forEach((ch, i) => {
    if (i > 0) lines.push('', '---', '');
    lines.push(`## Chapter ${i + 1}: ${ch.title}`);
    lines.push('');
    lines.push(ch.text);
    lines.push('');
  });
  return lines.join('\n').trim();
}

// ─── 출력 빌더: JSON ───
function buildJsonOutput(chapters, metadata, sourceName) {
  const totalChars = chapters.reduce((sum, ch) => sum + ch.text.length, 0);
  const totalWords = chapters.reduce((sum, ch) => {
    return sum + ch.text.split(/\s+/).filter(Boolean).length;
  }, 0);
  const obj = {
    metadata: {
      title: metadata.title,
      author: metadata.creator,
      language: metadata.language,
      source: sourceName
    },
    chapters: chapters.map((ch, i) => ({
      number: i + 1,
      title: ch.title,
      content: ch.text
    })),
    stats: {
      totalChapters: chapters.length,
      totalChars,
      totalWords
    }
  };
  return JSON.stringify(obj, null, 2);
}

// ─── 출력 빌더: HTML ───
function buildHtmlOutput(chapters, metadata, sourceName) {
  // HTML 특수문자 이스케이프
  const esc = (s) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const lang = metadata.language || 'ko';
  const sections = chapters.map((ch, i) => {
    // 텍스트를 문단으로 분리
    const paragraphs = ch.text
      .split(/\n{2,}/)
      .filter(Boolean)
      .map((p) => `<p>${esc(p.trim())}</p>`)
      .join('\n');
    return `<section>\n<h2>Chapter ${i + 1}: ${esc(ch.title)}</h2>\n${paragraphs}\n</section>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="${esc(lang)}">
<head>
<meta charset="UTF-8">
<title>${esc(metadata.title)}</title>
</head>
<body>
<article>
<header>
<h1>${esc(metadata.title)}</h1>
<p>${esc(metadata.creator)}</p>
</header>
${sections}
</article>
</body>
</html>`;
}

// ─── 출력 빌더 라우터 ───
function buildOutput(chapters, metadata, sourceName, options, format) {
  switch (format) {
    case 'markdown': return buildMarkdownOutput(chapters, metadata, sourceName, options);
    case 'json': return buildJsonOutput(chapters, metadata, sourceName);
    case 'html': return buildHtmlOutput(chapters, metadata, sourceName);
    default: return buildTxtOutput(chapters, metadata, sourceName, options);
  }
}

// ─── TOC 파싱 ───
/** EPUB 2 toc.ncx에서 목차 트리 추출 */
function parseTocNcx(ncxDoc) {
  if (!ncxDoc) return [];
  const navPoints = getElementsByLocalName(ncxDoc, 'navPoint');
  const items = [];
  for (const np of navPoints) {
    // 직접 자식 navPoint가 아닌 경우 최상위만 처리
    const label = getFirstByLocalName(np, 'text');
    const content = getFirstByLocalName(np, 'content');
    const text = label ? sanitizeText(label.textContent, '(제목 없음)') : '(제목 없음)';
    const src = content ? content.getAttribute('src') || '' : '';
    // 자식 navPoint 재귀 처리
    const children = [];
    const childNavPoints = Array.from(np.children || []).filter(
      (c) => c.localName === 'navPoint'
    );
    for (const cnp of childNavPoints) {
      const cLabel = getFirstByLocalName(cnp, 'text');
      const cContent = getFirstByLocalName(cnp, 'content');
      children.push({
        title: cLabel ? sanitizeText(cLabel.textContent, '(제목 없음)') : '(제목 없음)',
        src: cContent ? cContent.getAttribute('src') || '' : '',
        children: []
      });
    }
    // 이미 자식으로 처리된 항목은 최상위에서 제거하기 위해 playOrder 활용
    items.push({ title: text, src, children });
  }
  // 최상위 항목만 반환 (중첩 navPoint가 이미 자식에 포함됨)
  // 간단한 접근: playOrder 없이 depth-1만 취급
  return deduplicateTocItems(items);
}

/** EPUB 3 nav.xhtml에서 목차 추출 */
function parseTocNav(navDoc) {
  if (!navDoc) return [];
  // nav[epub:type="toc"] 또는 첫 번째 nav 요소
  const navEl = navDoc.querySelector('nav[epub\\:type="toc"]')
    || navDoc.querySelector('nav')
    || navDoc;
  const ol = navEl.querySelector('ol');
  if (!ol) return [];
  return parseNavOl(ol);
}

/** ol 요소를 재귀적으로 파싱하여 TOC 트리 생성 */
function parseNavOl(ol) {
  const items = [];
  const lis = Array.from(ol.children).filter((c) => c.tagName === 'LI' || c.localName === 'li');
  for (const li of lis) {
    const a = li.querySelector('a');
    const span = li.querySelector('span');
    const title = a ? sanitizeText(a.textContent, '(제목 없음)')
      : span ? sanitizeText(span.textContent, '(제목 없음)')
      : '(제목 없음)';
    const src = a ? (a.getAttribute('href') || '') : '';
    const childOl = li.querySelector('ol');
    const children = childOl ? parseNavOl(childOl) : [];
    items.push({ title, src, children });
  }
  return items;
}

/** 중복 TOC 항목 제거 — navPoint 중첩으로 인한 중복 방지 */
function deduplicateTocItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = item.title + '|' + item.src;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

// ─── 핵심: EPUB 변환 ───
/**
 * EPUB 파일을 파싱하여 텍스트 및 부가 데이터를 추출하는 메인 함수.
 * 반환: { content, metadata, chapterCount, charCount, wordCount, chapters,
 *         tocData, structureData, imageData }
 */
async function convertEpubToText(file, options, format) {
  // 1) ZIP 시그니처 검증 — 비EPUB 파일 조기 차단
  await assertZipSignature(file);

  // 2) JSZip으로 압축 해제
  const zip = await JSZip.loadAsync(file);
  addLog(`📦 ZIP 열기 완료: ${Object.keys(zip.files).length}개 엔트리`);

  // 3) container.xml에서 OPF 경로 추출 — EPUB 표준 진입점
  const containerEntry = findZipEntry(zip, 'META-INF/container.xml');
  if (!containerEntry) throw new Error('META-INF/container.xml을 찾을 수 없습니다');
  const containerXml = await containerEntry.async('string');
  const containerDoc = parseXml(containerXml, 'container.xml');
  if (!containerDoc) throw new Error('container.xml 파싱 실패');

  const rootfileEl = getFirstByLocalName(containerDoc, 'rootfile');
  if (!rootfileEl) throw new Error('rootfile 요소를 찾을 수 없습니다');
  const opfPath = rootfileEl.getAttribute('full-path');
  if (!opfPath) throw new Error('OPF 경로가 비어있습니다');

  // 4) OPF 파싱 — manifest, spine, metadata
  const opfEntry = findZipEntry(zip, opfPath);
  if (!opfEntry) throw new Error(`OPF 파일 없음: ${opfPath}`);
  const opfXml = await opfEntry.async('string');
  const opfDoc = parseXml(opfXml, 'OPF');
  if (!opfDoc) throw new Error('OPF 파싱 실패');

  const metadata = extractMetadata(opfDoc);
  addLog(`📖 "${metadata.title}" — ${metadata.creator}`);

  const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/')) : '';

  // manifest: id → href 매핑
  const manifestItems = getElementsByLocalName(opfDoc, 'item');
  const manifest = {};
  let tocNcxHref = null;
  let tocNavHref = null;

  for (const item of manifestItems) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    const mediaType = (item.getAttribute('media-type') || '').toLowerCase();
    const properties = (item.getAttribute('properties') || '').toLowerCase();
    if (id && href) {
      manifest[id] = { href, mediaType, properties };
    }
    // toc.ncx 찾기
    if (mediaType === 'application/x-dtbncx+xml') {
      tocNcxHref = href;
    }
    // EPUB 3 nav 찾기
    if (properties.includes('nav')) {
      tocNavHref = href;
    }
  }

  // spine: 읽기 순서
  const spineEl = getFirstByLocalName(opfDoc, 'spine');
  const spineItems = spineEl ? getElementsByLocalName(spineEl, 'itemref') : [];
  // spine에 toc 속성이 있으면 ncx 참조
  if (spineEl && !tocNcxHref) {
    const tocAttr = spineEl.getAttribute('toc');
    if (tocAttr && manifest[tocAttr]) {
      tocNcxHref = manifest[tocAttr].href;
    }
  }

  // 5) spine 순서대로 챕터 추출
  const chapters = [];
  let processedCount = 0;
  for (const itemref of spineItems) {
    const idref = itemref.getAttribute('idref');
    if (!idref || !manifest[idref]) continue;
    const href = manifest[idref].href;
    const fullPath = resolveZipPath(opfDir, href);
    const entry = findZipEntry(zip, fullPath);
    if (!entry) {
      addLog(`⚠ 챕터 파일 없음: ${fullPath}`);
      continue;
    }
    // 제한: 최대 80개 파일까지만 처리
    if (processedCount >= MAX_FILES) {
      addLog(`⚠ 최대 파일 수(${MAX_FILES}) 도달, 나머지 스킵`);
      break;
    }
    const chapter = await extractChapter(entry, chapters.length + 1, options);
    // 빈 챕터 스킵
    if (chapter.text.trim().length > 0) {
      chapters.push(chapter);
    }
    processedCount++;

    // 10챕터마다 UI에 양보
    if (processedCount % 10 === 0) await yieldToBrowser();
  }

  if (chapters.length === 0) {
    throw new Error('추출된 챕터가 없습니다. 빈 EPUB이거나 지원되지 않는 형식입니다.');
  }

  addLog(`✅ ${chapters.length}개 챕터 추출 완료`);

  // 6) TOC 데이터 추출 — nav.xhtml (EPUB 3) 우선, 없으면 toc.ncx (EPUB 2)
  let tocData = [];
  try {
    if (tocNavHref) {
      const navPath = resolveZipPath(opfDir, tocNavHref);
      const navEntry = findZipEntry(zip, navPath);
      if (navEntry) {
        const navHtml = await navEntry.async('string');
        const navDoc = parseXml(navHtml, 'nav.xhtml');
        tocData = parseTocNav(navDoc);
        addLog(`📑 EPUB 3 목차 추출: ${tocData.length}개 항목`);
      }
    }
    if (tocData.length === 0 && tocNcxHref) {
      const ncxPath = resolveZipPath(opfDir, tocNcxHref);
      const ncxEntry = findZipEntry(zip, ncxPath);
      if (ncxEntry) {
        const ncxXml = await ncxEntry.async('string');
        const ncxDoc = parseXml(ncxXml, 'toc.ncx');
        tocData = parseTocNcx(ncxDoc);
        addLog(`📑 EPUB 2 목차 추출: ${tocData.length}개 항목`);
      }
    }
  } catch (e) {
    addLog(`⚠ TOC 추출 중 오류: ${e.message}`);
  }

  // 7) 구조 데이터 — ZIP 내 모든 파일을 디렉토리 트리로 구성
  const structureData = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const parts = normalizeEntryName(name).split('/');
    const fileName = parts.pop();
    const dirPath = parts.join('/') || '/';
    if (!structureData[dirPath]) structureData[dirPath] = [];
    structureData[dirPath].push({
      name: fileName,
      fullPath: normalizeEntryName(name),
      // _data 크기는 압축 전 크기 (비동기 로드 전이라 대략값)
      size: entry._data ? (entry._data.uncompressedSize || 0) : 0
    });
  }

  // 8) 이미지 데이터 — 이미지 파일 탐색 및 Blob URL 생성
  const imageExtensions = /\.(jpe?g|png|gif|svg|webp)$/i;
  const imageData = [];
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const normalized = normalizeEntryName(name);
    if (!imageExtensions.test(normalized)) continue;
    try {
      const blob = await entry.async('blob');
      const url = URL.createObjectURL(blob);
      const fileName = normalized.split('/').pop();
      imageData.push({
        name: fileName,
        fullPath: normalized,
        blobUrl: url,
        size: blob.size,
        // MIME 타입 추론
        type: blob.type || guessMimeType(fileName)
      });
    } catch (e) {
      addLog(`⚠ 이미지 로드 실패: ${normalizeEntryName(name)}`);
    }
  }
  if (imageData.length > 0) {
    addLog(`🖼 ${imageData.length}개 이미지 발견`);
  }

  // 9) 최종 출력 빌드
  const content = buildOutput(chapters, metadata, file.name, options, format);
  const charCount = chapters.reduce((s, c) => s + c.text.length, 0);
  const wordCount = chapters.reduce((s, c) => s + c.text.split(/\s+/).filter(Boolean).length, 0);

  return {
    content,
    metadata,
    chapterCount: chapters.length,
    charCount,
    wordCount,
    chapters,
    tocData,
    structureData,
    imageData
  };
}

/** 파일 확장자로 MIME 타입 추측 */
function guessMimeType(name) {
  const ext = name.split('.').pop().toLowerCase();
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp'
  };
  return map[ext] || 'application/octet-stream';
}

// ─── 작업(Job) 관리 ───
/** 파일 목록으로부터 Job 객체 배열 생성 */
function prepareJobs(files) {
  const newJobs = [];
  for (const file of files) {
    if (jobs.length + newJobs.length >= MAX_FILES) {
      addLog(`⚠ 최대 파일 수(${MAX_FILES})에 도달, "${file.name}" 스킵`);
      continue;
    }
    if (file.size > MAX_FILE_SIZE) {
      addLog(`⚠ 파일 크기 초과(${formatBytes(file.size)}): "${file.name}" 스킵`);
      continue;
    }
    if (!file.name.toLowerCase().endsWith('.epub')) {
      addLog(`⚠ EPUB 파일이 아님: "${file.name}" 스킵`);
      continue;
    }
    const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    newJobs.push({
      id,
      file,
      fileName: file.name,
      fileSize: file.size,
      status: 'pending',
      error: null,
      content: null,
      metadata: null,
      chapterCount: 0,
      charCount: 0,
      wordCount: 0,
      chapters: [],
      tocData: [],
      structureData: {},
      imageData: [],
      outputName: null,
      format: getSelectedFormat()
    });
  }
  return newJobs;
}

/** 메인 처리 루프 — 큐에 있는 pending 작업을 순차 처리 */
async function processFiles(fileList) {
  if (isProcessing) {
    addLog('⚠ 이미 처리 중입니다. 현재 작업 완료 후 재시도하세요.');
    return;
  }
  const files = Array.from(fileList).filter((f) => f.name.toLowerCase().endsWith('.epub'));
  if (files.length === 0) {
    addLog('⚠ EPUB 파일이 없습니다.');
    return;
  }

  const newJobs = prepareJobs(files);
  if (newJobs.length === 0) return;

  jobs.push(...newJobs);
  // 첫 작업 자동 선택
  if (!selectedJobId) selectedJobId = newJobs[0].id;

  isProcessing = true;
  const format = getSelectedFormat();
  const options = {
    includeMetadata: $('includeMetadata').checked,
    includeChapterBreaks: $('includeChapterBreaks').checked,
    normalizeWhitespace: $('normalizeWhitespace').checked
  };

  // 출력 파일명 중복 방지용 레지스트리
  const nameRegistry = new Set(jobs.filter((j) => j.outputName).map((j) => j.outputName));

  addLog(`🚀 ${newJobs.length}개 파일 처리 시작 (포맷: ${format.toUpperCase()})`);
  render();

  for (const job of newJobs) {
    job.status = 'processing';
    job.format = format;
    render();
    await yieldToBrowser();

    try {
      addLog(`📄 처리 중: "${job.fileName}"`);
      const result = await convertEpubToText(job.file, options, format);
      job.content = result.content;
      job.metadata = result.metadata;
      job.chapterCount = result.chapterCount;
      job.charCount = result.charCount;
      job.wordCount = result.wordCount;
      job.chapters = result.chapters;
      job.tocData = result.tocData;
      job.structureData = result.structureData;
      job.imageData = result.imageData;
      job.outputName = makeUniqueTxtName(job.fileName, nameRegistry, getFormatExtension(format));
      job.status = 'success';
      addLog(`✅ 완료: "${job.fileName}" → ${job.outputName}`);

      // 히스토리에 자동 저장
      saveToHistory(job);
    } catch (e) {
      job.status = 'error';
      job.error = e.message || '알 수 없는 오류';
      addLog(`✖ 실패: "${job.fileName}" — ${job.error}`);
    }

    render();
    await yieldToBrowser();
  }

  isProcessing = false;
  addLog(`🏁 처리 완료: ${newJobs.filter((j) => j.status === 'success').length}/${newJobs.length} 성공`);
  render();
}

/** 실패한 작업 재시도 */
async function retryJob(jobId) {
  const job = jobs.find((j) => j.id === jobId);
  if (!job || job.status !== 'error') return;
  if (isProcessing) {
    addLog('⚠ 다른 작업 처리 중입니다.');
    return;
  }

  isProcessing = true;
  job.status = 'processing';
  job.error = null;
  selectedJobId = jobId;
  render();

  const format = getSelectedFormat();
  const options = {
    includeMetadata: $('includeMetadata').checked,
    includeChapterBreaks: $('includeChapterBreaks').checked,
    normalizeWhitespace: $('normalizeWhitespace').checked
  };

  try {
    const result = await convertEpubToText(job.file, options, format);
    job.content = result.content;
    job.metadata = result.metadata;
    job.chapterCount = result.chapterCount;
    job.charCount = result.charCount;
    job.wordCount = result.wordCount;
    job.chapters = result.chapters;
    job.tocData = result.tocData;
    job.structureData = result.structureData;
    job.imageData = result.imageData;
    const nameRegistry = new Set(jobs.filter((j) => j.outputName && j.id !== jobId).map((j) => j.outputName));
    job.outputName = makeUniqueTxtName(job.fileName, nameRegistry, getFormatExtension(format));
    job.format = format;
    job.status = 'success';
    addLog(`✅ 재시도 완료: "${job.fileName}"`);
    saveToHistory(job);
  } catch (e) {
    job.status = 'error';
    job.error = e.message || '알 수 없는 오류';
    addLog(`✖ 재시도 실패: "${job.fileName}" — ${job.error}`);
  }

  isProcessing = false;
  render();
}

/** 작업 선택 — 미리보기/통계/TOC 등 우측 패널 업데이트 */
function selectJob(jobId) {
  selectedJobId = jobId;
  render();
}

// ─── 다운로드 ───
/** Blob을 파일로 다운로드 트리거 */
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  // 클릭 후 정리 — 메모리 누수 방지
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

/** 단일 작업 다운로드 */
function downloadJob(job) {
  if (!job || !job.content) return;
  const blob = new Blob([job.content], { type: 'text/plain;charset=utf-8' });
  triggerDownload(blob, job.outputName || 'output.txt');
}

/** 전체 다운로드 — 1개면 직접, 2개 이상이면 ZIP */
async function downloadAll() {
  const successJobs = jobs.filter((j) => j.status === 'success' && j.content);
  if (successJobs.length === 0) {
    addLog('⚠ 다운로드할 파일이 없습니다.');
    return;
  }
  if (successJobs.length === 1) {
    downloadJob(successJobs[0]);
    return;
  }
  // 다중 파일 → ZIP으로 묶어서 다운로드
  addLog(`📦 ${successJobs.length}개 파일을 ZIP으로 묶는 중...`);
  const zip = new JSZip();
  for (const job of successJobs) {
    zip.file(job.outputName, job.content);
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  triggerDownload(blob, 'epub-workbench-output.zip');
  addLog('✅ ZIP 다운로드 완료');
}

/** 단일 이미지 다운로드 */
function downloadImage(imageEntry) {
  if (!imageEntry || !imageEntry.blobUrl) return;
  const a = document.createElement('a');
  a.href = imageEntry.blobUrl;
  a.download = imageEntry.name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => document.body.removeChild(a), 100);
}

/** 선택된 작업의 모든 이미지를 ZIP으로 다운로드 */
async function downloadAllImages(job) {
  if (!job || !job.imageData || job.imageData.length === 0) {
    addLog('⚠ 다운로드할 이미지가 없습니다.');
    return;
  }
  addLog(`📦 ${job.imageData.length}개 이미지를 ZIP으로 묶는 중...`);
  const zip = new JSZip();
  for (const img of job.imageData) {
    try {
      const response = await fetch(img.blobUrl);
      const blob = await response.blob();
      zip.file(img.name, blob);
    } catch (e) {
      addLog(`⚠ 이미지 패킹 실패: ${img.name}`);
    }
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const baseName = sanitizeFileBase(job.fileName);
  triggerDownload(blob, `${baseName}-images.zip`);
  addLog('✅ 이미지 ZIP 다운로드 완료');
}

// ─── IndexedDB: 히스토리 ───
/** IndexedDB 열기 — 없으면 생성 */
function openHistoryDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HISTORY_DB, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(HISTORY_STORE)) {
        db.createObjectStore(HISTORY_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

/** 변환 성공 시 히스토리 레코드 저장 */
async function saveToHistory(job) {
  try {
    const db = await openHistoryDB();
    const tx = db.transaction(HISTORY_STORE, 'readwrite');
    const store = tx.objectStore(HISTORY_STORE);

    const record = {
      id: job.id,
      timestamp: Date.now(),
      fileName: job.fileName,
      fileSize: job.fileSize,
      outputFormat: job.format || 'txt',
      charCount: job.charCount,
      wordCount: job.wordCount,
      chapterCount: job.chapterCount,
      status: job.status
    };
    store.put(record);

    // 오래된 레코드 정리 — 최대 100개 유지
    const allReq = store.getAll();
    allReq.onsuccess = () => {
      const all = allReq.result;
      if (all.length > HISTORY_MAX) {
        // 타임스탬프 기준 오래된 순으로 정렬 후 초과분 삭제
        all.sort((a, b) => a.timestamp - b.timestamp);
        const toDelete = all.slice(0, all.length - HISTORY_MAX);
        for (const item of toDelete) {
          store.delete(item.id);
        }
      }
    };

    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    addLog(`⚠ 히스토리 저장 실패: ${e.message}`);
  }
}

/** 모든 히스토리 레코드 조회 — 최신순 정렬 */
async function loadHistory() {
  try {
    const db = await openHistoryDB();
    const tx = db.transaction(HISTORY_STORE, 'readonly');
    const store = tx.objectStore(HISTORY_STORE);
    return new Promise((resolve) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const items = req.result || [];
        items.sort((a, b) => b.timestamp - a.timestamp);
        resolve(items);
      };
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

/** 전체 히스토리 삭제 */
async function clearHistory() {
  try {
    const db = await openHistoryDB();
    const tx = db.transaction(HISTORY_STORE, 'readwrite');
    tx.objectStore(HISTORY_STORE).clear();
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    addLog('🗑 변환 기록 삭제 완료');
  } catch (e) {
    addLog(`⚠ 기록 삭제 실패: ${e.message}`);
  }
}

// ─── 탭 시스템 ───
const TAB_IDS = ['tabQueue', 'tabPreview', 'tabToc', 'tabStats', 'tabStructure', 'tabImages', 'tabHistory', 'tabRename'];
const PANEL_IDS = ['panelQueue', 'panelPreview', 'panelToc', 'panelStats', 'panelStructure', 'panelImages', 'panelHistory', 'panelRename'];

/** 탭 활성화 — 선택된 탭과 패널에 active 클래스 토글 */
function activateTab(tabId) {
  const tabIndex = TAB_IDS.indexOf(tabId);
  if (tabIndex < 0) return;

  TAB_IDS.forEach((id, i) => {
    const tab = $(id);
    const panel = $(PANEL_IDS[i]);
    if (tab) {
      tab.classList.toggle('active', i === tabIndex);
      tab.setAttribute('aria-selected', i === tabIndex ? 'true' : 'false');
    }
    if (panel) {
      panel.classList.toggle('active', i === tabIndex);
    }
  });

  // 히스토리 탭 진입 시 자동 로드
  if (tabId === 'tabHistory') renderHistory();
}

// ─── 다크 모드 ───
/** 테마 순환: auto → light → dark → auto */
function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const idx = order.indexOf(currentTheme);
  currentTheme = order[(idx + 1) % order.length];
  applyTheme();
}

/** 테마를 HTML 요소와 localStorage에 적용 */
function applyTheme() {
  document.documentElement.setAttribute('data-theme', currentTheme);
  try {
    localStorage.setItem(THEME_KEY, currentTheme);
  } catch { /* localStorage 접근 불가 시 무시 */ }
}

/** 저장된 테마 복원 */
function restoreTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved && ['auto', 'light', 'dark'].includes(saved)) {
      currentTheme = saved;
    }
  } catch { /* 무시 */ }
  applyTheme();
}

// ─── 렌더링: 파일 큐 아이템 ───
/** 개별 작업을 큐 목록의 article 요소로 생성 */
function createFileItem(job, index) {
  const article = document.createElement('article');
  article.className = `file-item file-item--${job.status}`;
  // CSS 진입 애니메이션을 위한 커스텀 속성
  article.style.setProperty('--i', index);
  article.dataset.jobId = job.id;

  const isSelected = job.id === selectedJobId;
  if (isSelected) article.classList.add('selected');

  // 클릭으로 선택
  article.addEventListener('click', () => selectJob(job.id));

  const statusText = statusCopy[job.status] || job.status;
  const sizeText = formatBytes(job.fileSize);

  let actionsHtml = '';
  if (job.status === 'success') {
    actionsHtml = `
      <button class="ghost-btn ghost-btn--sm" data-action="download" title="다운로드">⬇</button>
      <button class="ghost-btn ghost-btn--sm" data-action="preview" title="미리보기">👁</button>
    `;
  } else if (job.status === 'error') {
    actionsHtml = `
      <button class="ghost-btn ghost-btn--sm" data-action="retry" title="재시도">↺</button>
    `;
  }

  article.innerHTML = `
    <div class="file-item-info">
      <strong class="file-item-name" title="${job.fileName}">${job.fileName}</strong>
      <span class="file-item-meta">${sizeText} · ${statusText}${job.error ? ` — ${job.error}` : ''}</span>
    </div>
    <div class="file-item-actions">${actionsHtml}</div>
  `;

  // 액션 버튼 이벤트 위임
  article.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      if (action === 'download') downloadJob(job);
      else if (action === 'preview') {
        selectedJobId = job.id;
        activateTab('tabPreview');
        render();
      }
      else if (action === 'retry') retryJob(job.id);
    });
  });

  return article;
}

// ─── 렌더링: 대시보드 ───
function renderDashboard() {
  const total = jobs.length;
  const success = jobs.filter((j) => j.status === 'success').length;
  const error = jobs.filter((j) => j.status === 'error').length;
  const processed = success + error;

  $('totalCount').textContent = total;
  $('successCount').textContent = success;
  $('errorCount').textContent = error;

  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  $('progressFill').style.width = `${pct}%`;
  $('progressCount').textContent = `${processed}/${total}`;

  if (isProcessing) {
    $('progressLabel').textContent = '처리 중…';
  } else if (total === 0) {
    $('progressLabel').textContent = '대기 중';
  } else {
    $('progressLabel').textContent = pct === 100 ? '완료' : '일시 정지';
  }

  // 다운로드/초기화 버튼 상태
  $('downloadAllBtn').disabled = success === 0;
  $('resetBtn').disabled = total === 0;
  $('clearBtn').disabled = total === 0;

  // 내보내기 요약 텍스트
  if (success > 0) {
    const format = getSelectedFormat().toUpperCase();
    $('exportSummary').textContent = `${success}개 파일 변환 완료. 다운로드 가능합니다.`;
    $('downloadAllBtn').textContent = `⬇ ${format} 다운로드${success > 1 ? ` (${success})` : ''}`;
  } else {
    $('exportSummary').textContent = '성공한 파일이 있으면 다운로드할 수 있습니다.';
    $('downloadAllBtn').textContent = `⬇ ${getSelectedFormat().toUpperCase()} 다운로드`;
  }
}

// ─── 렌더링: 미리보기 ───
function renderPreview() {
  const job = jobs.find((j) => j.id === selectedJobId);
  const previewContent = $('previewContent');
  const metadataList = $('metadataList');
  const copyBtn = $('copyBtn');
  const openPreviewBtn = $('openPreviewBtn');
  const previewSearch = $('previewSearch');

  if (!job || job.status !== 'success' || !job.content) {
    previewContent.textContent = '변환 결과가 여기에 표시됩니다.';
    metadataList.innerHTML = '';
    copyBtn.disabled = true;
    openPreviewBtn.disabled = true;
    previewSearch.disabled = true;
    $('searchResult').textContent = '변환된 파일을 선택하세요.';
    return;
  }

  // 미리보기 — PREVIEW_LIMIT까지만 표시 (성능)
  const truncated = job.content.length > PREVIEW_LIMIT;
  previewContent.textContent = truncated
    ? job.content.slice(0, PREVIEW_LIMIT) + `\n\n… (${formatBytes(job.content.length)} 중 일부만 표시)`
    : job.content;

  copyBtn.disabled = false;
  openPreviewBtn.disabled = false;
  previewSearch.disabled = false;
  $('searchResult').textContent = '';

  renderMetadata(job);
}

/** 메타데이터를 dl 요소에 렌더링 */
function renderMetadata(job) {
  const dl = $('metadataList');
  dl.innerHTML = '';
  if (!job || !job.metadata) return;

  const items = [
    ['제목', job.metadata.title],
    ['저자', job.metadata.creator],
    ['언어', job.metadata.language || '(미지정)'],
    ['챕터', `${job.chapterCount}개`],
    ['글자수', job.charCount.toLocaleString()],
    ['단어수', job.wordCount.toLocaleString()],
    ['파일', job.fileName],
    ['크기', formatBytes(job.fileSize)],
    ['포맷', (job.format || 'txt').toUpperCase()]
  ];

  for (const [label, value] of items) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
}

/** 미리보기 내 검색 — 일치 횟수 표시 */
function updateSearch() {
  const job = jobs.find((j) => j.id === selectedJobId);
  const searchInput = $('previewSearch');
  const searchResult = $('searchResult');

  if (!job || !job.content || !searchInput.value.trim()) {
    searchResult.textContent = '';
    return;
  }

  const query = searchInput.value.trim();
  try {
    // 대소문자 무시로 검색
    const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const matches = job.content.match(regex);
    const count = matches ? matches.length : 0;
    searchResult.textContent = count > 0
      ? `"${query}" — ${count}건 발견`
      : `"${query}" — 결과 없음`;
  } catch {
    searchResult.textContent = '검색어 오류';
  }
}

// ─── 렌더링: TOC ───
function renderToc(job) {
  const tocEmpty = $('tocEmpty');
  const tocTree = $('tocTree');

  if (!job || !job.tocData || job.tocData.length === 0) {
    tocEmpty.style.display = '';
    tocTree.innerHTML = '';
    tocTree.style.display = 'none';
    return;
  }

  tocEmpty.style.display = 'none';
  tocTree.style.display = '';
  tocTree.innerHTML = '';

  /** TOC 항목을 재귀적으로 DOM에 렌더링 */
  function buildTocNode(items, depth = 0) {
    const ul = document.createElement('ul');
    ul.className = 'toc-list';
    ul.style.paddingLeft = depth > 0 ? '1.2em' : '0';
    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'toc-item';
      const span = document.createElement('span');
      span.className = 'toc-label';
      span.textContent = item.title;
      li.appendChild(span);
      if (item.children && item.children.length > 0) {
        li.appendChild(buildTocNode(item.children, depth + 1));
      }
      ul.appendChild(li);
    }
    return ul;
  }

  tocTree.appendChild(buildTocNode(job.tocData));
}

// ─── 렌더링: 통계 ───
function renderStats(job) {
  const statsEmpty = $('statsEmpty');
  const statsGrid = $('statsGrid');
  const chapterChart = $('chapterChart');
  const topWordsSection = $('topWordsSection');

  if (!job || job.status !== 'success' || !job.chapters || job.chapters.length === 0) {
    statsEmpty.style.display = '';
    statsGrid.style.display = 'none';
    chapterChart.style.display = 'none';
    topWordsSection.style.display = 'none';
    return;
  }

  statsEmpty.style.display = 'none';
  statsGrid.style.display = '';
  chapterChart.style.display = '';
  topWordsSection.style.display = '';

  // 기본 통계
  $('statChars').textContent = job.charCount.toLocaleString();
  $('statWords').textContent = job.wordCount.toLocaleString();
  // 읽기 시간: 분당 250단어 기준
  const readMin = Math.ceil(job.wordCount / 250);
  $('statReadTime').textContent = readMin > 60
    ? `${Math.floor(readMin / 60)}시간 ${readMin % 60}분`
    : `${readMin}분`;
  $('statChapters').textContent = job.chapterCount;

  // 챕터별 분량 바 차트
  const barChart = $('barChart');
  barChart.innerHTML = '';
  const chapterLengths = job.chapters.map((ch) => ch.text.length);
  const maxLen = Math.max(...chapterLengths, 1); // 0으로 나누기 방지

  job.chapters.forEach((ch, i) => {
    const len = chapterLengths[i];
    const pct = Math.round((len / maxLen) * 100);
    const item = document.createElement('div');
    item.className = 'bar-item';
    item.innerHTML = `
      <span class="bar-label" title="${ch.title}">${i + 1}. ${ch.title.slice(0, 20)}</span>
      <div class="bar-track">
        <div class="bar-fill" style="width: ${pct}%"></div>
      </div>
      <span class="bar-value">${len.toLocaleString()}</span>
    `;
    barChart.appendChild(item);
  });

  // TOP 10 단어 빈도
  const topWordsList = $('topWordsList');
  topWordsList.innerHTML = '';

  // 전체 텍스트에서 단어 카운트
  const allText = job.chapters.map((ch) => ch.text).join(' ');
  const wordFreq = {};
  // 한국어 + 영문 + 숫자 토큰 추출 (최소 2자 이상)
  const tokens = allText.match(/[\p{L}\p{N}]{2,}/gu) || [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (KOREAN_STOP_WORDS.has(lower)) continue;
    wordFreq[lower] = (wordFreq[lower] || 0) + 1;
  }
  const sorted = Object.entries(wordFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  for (const [word, count] of sorted) {
    const li = document.createElement('li');
    li.textContent = `${word} (${count.toLocaleString()})`;
    topWordsList.appendChild(li);
  }
}

// ─── 렌더링: EPUB 구조 ───
function renderStructure(job) {
  const structureEmpty = $('structureEmpty');
  const structureTree = $('structureTree');

  if (!job || !job.structureData || Object.keys(job.structureData).length === 0) {
    structureEmpty.style.display = '';
    structureTree.innerHTML = '';
    structureTree.style.display = 'none';
    return;
  }

  structureEmpty.style.display = 'none';
  structureTree.style.display = '';
  structureTree.innerHTML = '';

  // 디렉토리 키를 정렬하여 일관된 순서 보장
  const dirs = Object.keys(job.structureData).sort();
  for (const dir of dirs) {
    const files = job.structureData[dir];
    const dirNode = document.createElement('div');
    dirNode.className = 'structure-node structure-node--dir';

    const dirLabel = document.createElement('div');
    dirLabel.className = 'structure-dir-label';
    dirLabel.textContent = `📁 ${dir === '/' ? '(루트)' : dir}`;
    dirNode.appendChild(dirLabel);

    const fileList = document.createElement('div');
    fileList.className = 'structure-files';

    for (const file of files) {
      const fileDiv = document.createElement('div');
      fileDiv.className = 'structure-node structure-node--file';
      fileDiv.textContent = `📄 ${file.name}`;
      if (file.size > 0) {
        const sizeSpan = document.createElement('span');
        sizeSpan.className = 'structure-size';
        sizeSpan.textContent = ` (${formatBytes(file.size)})`;
        fileDiv.appendChild(sizeSpan);
      }
      fileList.appendChild(fileDiv);
    }

    dirNode.appendChild(fileList);
    structureTree.appendChild(dirNode);
  }
}

// ─── 렌더링: 이미지 그리드 ───
function renderImages(job) {
  const imagesEmpty = $('imagesEmpty');
  const imageGrid = $('imageGrid');
  const downloadAllImagesBtn = $('downloadAllImagesBtn');

  if (!job || !job.imageData || job.imageData.length === 0) {
    imagesEmpty.style.display = '';
    imageGrid.innerHTML = '';
    imageGrid.style.display = 'none';
    downloadAllImagesBtn.disabled = true;
    return;
  }

  imagesEmpty.style.display = 'none';
  imageGrid.style.display = '';
  imageGrid.innerHTML = '';
  downloadAllImagesBtn.disabled = false;

  for (const img of job.imageData) {
    const card = document.createElement('div');
    card.className = 'image-card';

    const thumb = document.createElement('img');
    thumb.src = img.blobUrl;
    thumb.alt = img.name;
    thumb.loading = 'lazy';
    thumb.className = 'image-thumb';
    // SVG의 경우 객체 맞춤 조정
    if (img.name.endsWith('.svg')) {
      thumb.style.objectFit = 'contain';
    }

    const info = document.createElement('div');
    info.className = 'image-info';
    info.innerHTML = `
      <span class="image-name" title="${img.fullPath}">${img.name}</span>
      <span class="image-size">${formatBytes(img.size)}</span>
    `;

    const dlBtn = document.createElement('button');
    dlBtn.className = 'ghost-btn ghost-btn--sm';
    dlBtn.textContent = '⬇';
    dlBtn.title = '다운로드';
    dlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadImage(img);
    });
    info.appendChild(dlBtn);

    card.appendChild(thumb);
    card.appendChild(info);
    imageGrid.appendChild(card);
  }
}

// ─── 렌더링: 히스토리 ───
async function renderHistory() {
  const historyEmpty = $('historyEmpty');
  const historyList = $('historyList');
  const items = await loadHistory();

  if (items.length === 0) {
    historyEmpty.style.display = '';
    historyList.innerHTML = '';
    historyList.style.display = 'none';
    return;
  }

  historyEmpty.style.display = 'none';
  historyList.style.display = '';
  historyList.innerHTML = '';

  for (const item of items) {
    const div = document.createElement('div');
    div.className = 'history-item glass';

    const date = new Date(item.timestamp);
    const dateStr = date.toLocaleDateString('ko-KR') + ' ' + date.toLocaleTimeString('ko-KR');

    div.innerHTML = `
      <div class="history-item-header">
        <strong>${item.fileName}</strong>
        <span class="history-date">${dateStr}</span>
      </div>
      <div class="history-item-meta">
        <span>포맷: ${(item.outputFormat || 'txt').toUpperCase()}</span>
        <span>챕터: ${item.chapterCount}개</span>
        <span>글자: ${(item.charCount || 0).toLocaleString()}</span>
        <span>단어: ${(item.wordCount || 0).toLocaleString()}</span>
        <span>크기: ${formatBytes(item.fileSize || 0)}</span>
      </div>
    `;
    historyList.appendChild(div);
  }
}

// ─── 메인 렌더 오케스트레이터 ───
function render() {
  const fileList = $('fileList');
  const emptyState = $('emptyState');

  // 파일 큐 렌더링
  fileList.innerHTML = '';
  if (jobs.length === 0) {
    emptyState.style.display = '';
  } else {
    emptyState.style.display = 'none';
    jobs.forEach((job, i) => {
      fileList.appendChild(createFileItem(job, i));
    });
  }

  renderDashboard();
  renderPreview();

  // 선택된 작업 기반 우측 패널 업데이트
  const selectedJob = jobs.find((j) => j.id === selectedJobId);
  renderToc(selectedJob);
  renderStats(selectedJob);
  renderStructure(selectedJob);
  renderImages(selectedJob);
}

// ─── 포맷 인디케이터 ───
/** 포맷 변경 시 UI 라벨과 다운로드 버튼 텍스트 업데이트 */
function updateFormatIndicator() {
  const format = getSelectedFormat();
  const indicator = $('formatIndicator');
  if (indicator) {
    const labels = { txt: 'TXT', markdown: 'MD', json: 'JSON', html: 'HTML' };
    indicator.textContent = labels[format] || 'TXT';
  }
  // 다운로드 버튼 텍스트도 반영
  const successCount = jobs.filter((j) => j.status === 'success').length;
  const btn = $('downloadAllBtn');
  if (btn) {
    btn.textContent = `⬇ ${format.toUpperCase()} 다운로드${successCount > 1 ? ` (${successCount})` : ''}`;
  }
}

// ─── 로그 토글 ───
function toggleLogArea() {
  const logArea = $('logArea');
  const btn = $('toggleLogBtn');
  if (logArea.hidden || logArea.style.display === 'none') {
    logArea.hidden = false;
    logArea.style.display = '';
    btn.textContent = '접기';
  } else {
    logArea.hidden = true;
    logArea.style.display = 'none';
    btn.textContent = '펼치기';
  }
}

// ═══════════════════════════════════════════════════════════════════
// 이벤트 바인딩 — DOMContentLoaded 시 초기화
// ═══════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  // ── 테마 복원 ──
  restoreTheme();

  // ── 초기 렌더 ──
  render();
  renderHistory();

  // ── 드롭 존 이벤트 ──
  const dropZone = $('dropZone');
  const fileInput = $('fileInput');

  // 클릭으로 파일 선택
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  // 드래그 앤 드롭 — dragDepth로 중첩 이벤트 정확히 추적
  dropZone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth--;
    if (dragDepth <= 0) {
      dragDepth = 0;
      dropZone.classList.remove('drag-over');
    }
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault(); // 드롭 허용을 위해 필수
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer && e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  });

  // 파일 input change
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length > 0) {
      processFiles(fileInput.files);
      // 같은 파일 재선택을 허용하기 위해 값 초기화
      fileInput.value = '';
    }
  });

  // ── 미리보기 검색 ──
  $('previewSearch').addEventListener('input', updateSearch);

  // ── 복사 버튼 ──
  $('copyBtn').addEventListener('click', async () => {
    const job = jobs.find((j) => j.id === selectedJobId);
    if (!job || !job.content) return;
    try {
      await navigator.clipboard.writeText(job.content);
      const btn = $('copyBtn');
      const original = btn.textContent;
      btn.textContent = '✓ 복사됨';
      setTimeout(() => { btn.textContent = original; }, 1500);
    } catch (e) {
      addLog(`⚠ 클립보드 복사 실패: ${e.message}`);
    }
  });

  // ── 전체 보기 다이얼로그 ──
  $('openPreviewBtn').addEventListener('click', () => {
    const job = jobs.find((j) => j.id === selectedJobId);
    if (!job || !job.content) return;
    $('dialogTitle').textContent = job.outputName || '미리보기';
    $('dialogContent').textContent = job.content;
    $('previewDialog').showModal();
  });

  $('closePreviewBtn').addEventListener('click', () => {
    $('previewDialog').close();
  });

  // 다이얼로그 backdrop 클릭으로 닫기
  $('previewDialog').addEventListener('click', (e) => {
    if (e.target === $('previewDialog')) $('previewDialog').close();
  });

  // ── 큐 비우기 ──
  $('clearBtn').addEventListener('click', () => {
    // 이미지 Blob URL 해제 — 메모리 누수 방지
    for (const job of jobs) {
      if (job.imageData) {
        for (const img of job.imageData) {
          try { URL.revokeObjectURL(img.blobUrl); } catch { /* 무시 */ }
        }
      }
    }
    jobs = [];
    selectedJobId = null;
    addLog('🧹 파일 큐를 비웠습니다.');
    render();
  });

  // ── 다시 시작 ──
  $('resetBtn').addEventListener('click', () => {
    for (const job of jobs) {
      if (job.imageData) {
        for (const img of job.imageData) {
          try { URL.revokeObjectURL(img.blobUrl); } catch { /* 무시 */ }
        }
      }
    }
    jobs = [];
    logs = [];
    selectedJobId = null;
    isProcessing = false;
    $('logArea').innerHTML = '';
    addLog('🔄 워크벤치를 초기화했습니다.');
    render();
  });

  // ── 전체 다운로드 ──
  $('downloadAllBtn').addEventListener('click', () => downloadAll());

  // ── 테마 토글 ──
  $('themeToggle').addEventListener('click', cycleTheme);

  // ── 단축키 안내 다이얼로그 ──
  $('shortcutHelpBtn').addEventListener('click', () => {
    $('shortcutDialog').showModal();
  });

  $('closeShortcutBtn').addEventListener('click', () => {
    $('shortcutDialog').close();
  });

  $('shortcutDialog').addEventListener('click', (e) => {
    if (e.target === $('shortcutDialog')) $('shortcutDialog').close();
  });

  // ── 로그 토글 ──
  $('toggleLogBtn').addEventListener('click', toggleLogArea);

  // ── 출력 포맷 라디오 ──
  document.querySelectorAll('input[name="outputFormat"]').forEach((radio) => {
    radio.addEventListener('change', updateFormatIndicator);
  });

  // ── 옵션 체크박스 변경 시 재렌더 (이미 처리된 파일에는 영향 없지만 UI 일관성) ──
  ['includeMetadata', 'includeChapterBreaks', 'normalizeWhitespace'].forEach((id) => {
    $(id).addEventListener('change', render);
  });

  // ── 탭 버튼 ──
  TAB_IDS.forEach((tabId) => {
    const tabEl = $(tabId);
    if (tabEl) {
      tabEl.addEventListener('click', () => activateTab(tabId));
    }
  });

  // ── 히스토리 삭제 ──
  $('clearHistoryBtn').addEventListener('click', async () => {
    await clearHistory();
    renderHistory();
  });

  // ── 전체 이미지 다운로드 ──
  $('downloadAllImagesBtn').addEventListener('click', () => {
    const job = jobs.find((j) => j.id === selectedJobId);
    if (job) downloadAllImages(job);
  });

  // ═══════════════════════════════════════════════════════════════
  // 키보드 단축키
  // ═══════════════════════════════════════════════════════════════
  document.addEventListener('keydown', (e) => {
    const isInputFocused = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    const isMod = e.ctrlKey || e.metaKey;

    // ── Ctrl/⌘ 조합 ──
    if (isMod) {
      // Ctrl+Shift+T — 테마 토글
      if (e.shiftKey && e.key === 'T') {
        e.preventDefault();
        cycleTheme();
        return;
      }
      // Ctrl+O — 파일 열기
      if (e.key === 'o' || e.key === 'O') {
        e.preventDefault();
        fileInput.click();
        return;
      }
      // Ctrl+D — 다운로드
      if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        downloadAll();
        return;
      }
      // Ctrl+K — 검색 포커스
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        $('previewSearch').focus();
        activateTab('tabPreview');
        return;
      }
    }

    // ── Esc — 다이얼로그 닫기 ──
    if (e.key === 'Escape') {
      if ($('previewDialog').open) {
        $('previewDialog').close();
        return;
      }
      if ($('shortcutDialog').open) {
        $('shortcutDialog').close();
        return;
      }
    }

    // 나머지 단축키는 입력 필드 포커스 시 비활성화
    if (isInputFocused) return;

    // ── ? — 단축키 안내 ──
    if (e.key === '?') {
      e.preventDefault();
      $('shortcutDialog').showModal();
      return;
    }

    // ── ↑/↓ — 큐 탐색 ──
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (jobs.length === 0) return;
      e.preventDefault();
      const currentIdx = jobs.findIndex((j) => j.id === selectedJobId);
      let newIdx;
      if (e.key === 'ArrowUp') {
        newIdx = currentIdx <= 0 ? jobs.length - 1 : currentIdx - 1;
      } else {
        newIdx = currentIdx >= jobs.length - 1 ? 0 : currentIdx + 1;
      }
      selectJob(jobs[newIdx].id);
      // 선택된 항목이 보이도록 스크롤
      const fileList = $('fileList');
      const items = fileList.querySelectorAll('.file-item');
      if (items[newIdx]) items[newIdx].scrollIntoView({ block: 'nearest' });
      return;
    }

    // ── 1-7 — 탭 전환 ──
    const num = parseInt(e.key, 10);
    if (num >= 1 && num <= 8) {
      e.preventDefault();
      activateTab(TAB_IDS[num - 1]);
      return;
    }
  });

  // ── 초기 포맷 인디케이터 ──
  updateFormatIndicator();

  // ── 초기 탭: Preview ──
  activateTab('tabPreview');

  addLog('🚀 EPUB Workbench 2026 준비 완료');

  // ═══════════════════════════════════════════════════════
  // 파일명 동기화 기능 (Filename Sync)
  // 왜: EPUB 내부 메타데이터의 dc:title이 실제 책 제목이며,
  //     파일명은 다운로드 시 완리되어 의미 없는 태그가 붙는 경우가 많음.
  //     내부 제목을 기준으로 파일명을 정리하여 다운로드 제공.
  // 어떻게: JSZip으로 EPUB 내부 container.xml → OPF → dc:title/dc:creator 추출
  // ═══════════════════════════════════════════════════════

  /** 파일명에 사용할 수 없는 문자 제거 및 정리 */
  function sanitizeForFilename(name) {
    return name
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/[\u00AB\u00BB\uD835\uDC0F\uD835\uDC01\uD835\uDC08\uD835\uDC11\uD835\uDC12\uD835\uDC13\uD835\uDC14]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\.+$/g, '')
      .trim()
      .slice(0, 200);
  }

  /**
   * EPUB(ZIP) 내부에서 container.xml → OPF 경로 → dc:title 및 dc:creator를 추출
   * 왜 JSZip 사용: 브라우저에서 실행해야 하므로 unzip CLI 대신 이미 로드된 JSZip 활용
   */
  async function extractEpubTitleAndAuthor(file) {
    try {
      const zip = await JSZip.loadAsync(file);

      // 1단계: container.xml에서 OPF 경로 찾기
      const containerEntry = zip.file('META-INF/container.xml');
      if (!containerEntry) return { title: null, author: null };

      const containerXml = await containerEntry.async('string');
      const containerDoc = new DOMParser().parseFromString(containerXml, 'application/xml');
      const rootFiles = containerDoc.getElementsByTagName('rootfile');
      if (!rootFiles.length) return { title: null, author: null };

      const opfPath = rootFiles[0].getAttribute('full-path');
      if (!opfPath) return { title: null, author: null };

      // 2단계: OPF 파일에서 dc:title, dc:creator 추출
      const opfEntry = zip.file(opfPath);
      if (!opfEntry) return { title: null, author: null };

      const opfContent = await opfEntry.async('string');
      const opfDoc = new DOMParser().parseFromString(opfContent, 'application/xml');

      // dc:title 또는 title 태그 찾기 (네임스페이스 유연 대응)
      let title = null;
      const titleEls = opfDoc.querySelectorAll('title');
      for (const el of titleEls) {
        const t = el.textContent?.trim();
        if (t) { title = t; break; }
      }

      let author = null;
      const creatorEls = opfDoc.querySelectorAll('creator');
      for (const el of creatorEls) {
        const a = el.textContent?.trim();
        if (a) { author = a; break; }
      }

      return { title, author };
    } catch {
      return { title: null, author: null };
    }
  }

  /**
   * 새 파일명 결정: "제목 (저자).epub"
   * 제목 추출 실패 시 기존 파일명에서 z-library 태그만 제거하는 폴백 적용
   */
  function buildNewFileName(originalName, title, author) {
    if (title) {
      const cleanTitle = sanitizeForFilename(title);
      const authorPart = author ? ` (${sanitizeForFilename(author)})` : '';
      return cleanTitle + authorPart + '.epub';
    }

    // 폴백: 기존 파일명에서 z-library 태그 제거
    let name = originalName.replace(/\.epub$/i, '');
    name = name.replace(/\s*\(z-library[^)]*\)/gi, '');
    name = name.replace(/\s*\(\d+\)$/g, '');
    name = name.replace(/\s*\(양장본[^)]*\)/gi, '');
    name = name.replace(/\s*\(보급판\)/gi, '');
    name = name.replace(/[\u1100-\u11FF]~[\u1161-\u1175]?\S*/g, '').trim();
    name = name.replace(/\s+/g, ' ').trim();
    return name + '.epub';
  }

  // 파일명 동기화 상태 저장소
  let renameEntries = [];

  /** 파일명 동기화 결과 렌더링 */
  function renderRenameResults() {
    const container = $('renameResults');
    const emptyEl = $('renameEmpty');
    const downloadBtn = $('downloadRenamedBtn');

    if (!renameEntries.length) {
      container.innerHTML = '';
      emptyEl.style.display = 'flex';
      downloadBtn.disabled = true;
      return;
    }

    emptyEl.style.display = 'none';

    // 요약 통계
    const changed = renameEntries.filter(e => e.oldName !== e.newName).length;
    const same = renameEntries.filter(e => e.oldName === e.newName).length;
    const errors = renameEntries.filter(e => !e.title).length;

    let html = `<div class="rename-summary">
      <span class="count-changed">🔄 변경: ${changed}개</span>
      <span class="count-same">✅ 동일: ${same}개</span>
      <span class="count-error">⚠️ 제목없음: ${errors}개</span>
    </div>`;

    renameEntries.forEach((entry, i) => {
      const isChanged = entry.oldName !== entry.newName;
      const statusIcon = entry.title ? (isChanged ? '🔄' : '✅') : '⚠️';

      html += `<div class="rename-item" style="--i:${i}">
        <span class="rename-status">${statusIcon}</span>
        <div class="rename-info">`;

      if (isChanged) {
        html += `<span class="rename-old" title="${entry.oldName}">${entry.oldName}</span>
          <span class="rename-new" title="${entry.newName}">${entry.newName}</span>`;
      } else {
        html += `<span class="rename-same" title="${entry.oldName}">${entry.oldName} (동일)</span>`;
      }

      html += `</div>
        <div class="rename-action">
          <button class="btn btn--secondary" data-rename-idx="${i}">⬇ 다운로드</button>
        </div>
      </div>`;
    });

    container.innerHTML = html;
    downloadBtn.disabled = changed === 0;

    // 개별 다운로드 버튼 이벤트
    container.querySelectorAll('[data-rename-idx]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.renameIdx, 10);
        const entry = renameEntries[idx];
        if (!entry) return;

        // EPUB 파일을 새 이름으로 다운로드
        const url = URL.createObjectURL(entry.file);
        const a = document.createElement('a');
        a.href = url;
        a.download = entry.newName;
        a.click();
        URL.revokeObjectURL(url);

        addLog(`📝 파일명 동기화 다운로드: ${entry.newName}`);
      });
    });
  }

  /** 파일명 동기화용 EPUB 파일 처리 */
  async function processRenameFiles(fileList) {
    const epubFiles = Array.from(fileList).filter(f => f.name.toLowerCase().endsWith('.epub'));
    if (!epubFiles.length) {
      addLog('⚠️ 파일명 동기화: EPUB 파일이 없습니다.');
      return;
    }

    addLog(`📝 파일명 동기화: ${epubFiles.length}개 파일 분석 시작...`);

    // 1단계: 모든 파일의 메타데이터 수집
    renameEntries = [];
    for (const file of epubFiles) {
      const { title, author } = await extractEpubTitleAndAuthor(file);
      const newName = buildNewFileName(file.name, title, author);
      renameEntries.push({ file, oldName: file.name, newName, title, author });
    }

    // 2단계: 중복 제목 감지 (메타데이터 오류 의심)
    // 왜: 같은 시리즈의 EPUB이 내부적으로 동일 제목을 가진 경우 있음 (e.g. 하버드 강의 시리즈)
    const titleCounts = {};
    renameEntries.forEach(e => {
      if (e.title) {
        const key = e.title.toLowerCase();
        titleCounts[key] = (titleCounts[key] || 0) + 1;
      }
    });

    const duplicatedTitles = new Set(
      Object.entries(titleCounts)
        .filter(([, count]) => count > 1)
        .map(([key]) => key)
    );

    // 중복 제목인 경우 기존 파일명 기반으로 폴백
    if (duplicatedTitles.size > 0) {
      addLog(`⚠️ 중복 제목 ${duplicatedTitles.size}건 감지 — 기존 파일명 기반으로 정리합니다.`);
      renameEntries.forEach(e => {
        if (e.title && duplicatedTitles.has(e.title.toLowerCase())) {
          e.newName = buildNewFileName(e.oldName, null, null);
        }
      });
    }

    // 3단계: 중복 파일명 방지
    const usedNames = new Set();
    renameEntries.forEach(e => {
      let finalName = e.newName;
      let counter = 2;
      while (usedNames.has(finalName.toLowerCase()) && counter <= 10) {
        const ext = finalName.slice(finalName.lastIndexOf('.'));
        const base = finalName.slice(0, finalName.lastIndexOf('.'));
        finalName = `${base} (${counter})${ext}`;
        counter++;
      }
      usedNames.add(finalName.toLowerCase());
      e.newName = finalName;
    });

    const changedCount = renameEntries.filter(e => e.oldName !== e.newName).length;
    addLog(`📝 분석 완료: ${changedCount}개 변경 예정, ${renameEntries.length - changedCount}개 동일`);

    renderRenameResults();
  }

  // 파일명 동기화 드롭존 이벤트
  const renameDropZone = $('renameDropZone');
  const renameFileInput = $('renameFileInput');

  if (renameDropZone && renameFileInput) {
    renameFileInput.addEventListener('change', (e) => {
      if (e.target.files.length) processRenameFiles(e.target.files);
    });

    renameDropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      renameDropZone.classList.add('drag-over');
    });

    renameDropZone.addEventListener('dragleave', () => {
      renameDropZone.classList.remove('drag-over');
    });

    renameDropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      renameDropZone.classList.remove('drag-over');
      if (e.dataTransfer.files.length) processRenameFiles(e.dataTransfer.files);
    });

    renameDropZone.addEventListener('click', () => renameFileInput.click());
    renameDropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        renameFileInput.click();
      }
    });
  }

  // 전체 다운로드 버튼: 변경된 파일들을 ZIP으로 묶어 다운로드
  const downloadRenamedBtn = $('downloadRenamedBtn');
  if (downloadRenamedBtn) {
    downloadRenamedBtn.addEventListener('click', async () => {
      const changedEntries = renameEntries.filter(e => e.oldName !== e.newName);
      if (!changedEntries.length) return;

      if (changedEntries.length === 1) {
        // 단일 파일: 직접 다운로드
        const entry = changedEntries[0];
        const url = URL.createObjectURL(entry.file);
        const a = document.createElement('a');
        a.href = url;
        a.download = entry.newName;
        a.click();
        URL.revokeObjectURL(url);
        addLog(`📝 파일명 동기화 다운로드: ${entry.newName}`);
      } else {
        // 여러 파일: ZIP으로 묶어 다운로드
        addLog(`📦 ${changedEntries.length}개 파일 ZIP 압축 중...`);
        const zip = new JSZip();
        for (const entry of changedEntries) {
          const buf = await entry.file.arrayBuffer();
          zip.file(entry.newName, buf);
        }
        const blob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'epub-renamed.zip';
        a.click();
        URL.revokeObjectURL(url);
        addLog(`✅ ZIP 다운로드 완료: epub-renamed.zip (${changedEntries.length}개 파일)`);
      }
    });
  }
});
