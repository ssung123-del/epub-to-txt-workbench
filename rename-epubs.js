#!/usr/bin/env node

/**
 * EPUB 파일명 동기화 스크립트 v2
 * 
 * 핵심 로직:
 *   1. EPUB 내부 OPF에서 dc:title(책 제목)과 dc:creator(저자)를 추출
 *   2. 추출한 제목으로 "제목 (저자).epub" 형태의 새 파일명을 생성
 *   3. 같은 제목이 중복 발생하면 → 메타데이터 오류 의심 → 기존 파일명에서 정리하는 폴백
 *   4. 저자 이름에서 불필요한 특수문자, z-library 태그 등을 정리
 * 
 * 사용법:
 *   node rename-epubs.js --dry-run ~/Downloads/EPUB   (미리보기)
 *   node rename-epubs.js ~/Downloads/EPUB              (실제 적용)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── 설정 ──
const DRY_RUN = process.argv.includes('--dry-run');
const TARGET_DIR = process.argv.filter(a => !a.startsWith('--')).slice(2)[0];

if (!TARGET_DIR) {
    console.error('사용법: node rename-epubs.js [--dry-run] <EPUB_폴더_경로>');
    process.exit(1);
}

const resolvedDir = path.resolve(TARGET_DIR);
if (!fs.existsSync(resolvedDir)) {
    console.error(`❌ 폴더를 찾을 수 없습니다: ${resolvedDir}`);
    process.exit(1);
}

console.log(`\n📖 EPUB 파일명 동기화 도구 v2`);
console.log(`   대상 폴더: ${resolvedDir}`);
console.log(`   모드: ${DRY_RUN ? '🔍 DRY-RUN (미리보기만)' : '⚡ 실제 변경'}\n`);

// ── 유틸리티 함수 ──

/**
 * EPUB 내부에서 OPF 경로를 찾고, dc:title과 dc:creator를 추출합니다.
 * 왜 unzip 사용: npm 의존성 없이 macOS 기본 도구만으로 동작하기 위해.
 */
function extractEpubMetadata(epubPath) {
    try {
        const containerXml = execSync(
            `unzip -p "${epubPath}" "META-INF/container.xml" 2>/dev/null`,
            { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
        );

        const opfMatch = containerXml.match(/full-path\s*=\s*["']([^"']+)["']/i);
        if (!opfMatch) return { title: null, author: null };

        const opfContent = execSync(
            `unzip -p "${epubPath}" "${opfMatch[1]}" 2>/dev/null`,
            { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
        );

        // dc:title 추출 (여러 개일 수 있으므로 첫 번째만)
        const titleMatch = opfContent.match(/<(?:dc:)?title[^>]*>([^<]+)<\/(?:dc:)?title>/i);
        const title = titleMatch ? titleMatch[1].trim() : null;

        // dc:creator 추출
        const authorMatch = opfContent.match(/<(?:dc:)?creator[^>]*>([^<]+)<\/(?:dc:)?creator>/i);
        const author = authorMatch ? authorMatch[1].trim() : null;

        return { title, author };
    } catch {
        return { title: null, author: null };
    }
}

/**
 * 파일 시스템 금지 문자와 불필요한 아티팩트를 제거합니다.
 */
function sanitize(name) {
    return name
        .replace(/[\\/:*?"<>|]/g, '')       // 파일시스템 금지 문자
        .replace(/[«»𝐏𝐁𝐈𝐑𝐒𝐓𝐔]/g, '')       // 메타데이터 깨진 유니코드 아티팩트
        .replace(/\s*,\s*/g, ', ')           // 쉼표 주변 공백 정규화
        .replace(/\s+/g, ' ')               // 연속 공백 정리
        .replace(/\.+$/g, '')               // 끝의 점 제거
        .trim()
        .slice(0, 200);
}

/**
 * z-library 태그와 기타 잡음을 제거하여 기존 파일명에서 제목+저자를 복구합니다.
 * 왜: 내부 메타데이터가 잘못되었을 때(예: 하버드 시리즈) 폴백으로 사용.
 */
function cleanExistingFileName(fileName) {
    let name = fileName.replace(/\.epub$/i, '');

    // z-library 태그 제거: "(z-library.sk, 1lib.sk, z-lib.sk)" 패턴
    name = name.replace(/\s*\(z-library[^)]*\)/gi, '');

    // 중복 번호 태그 제거: "(1)", "(2)" 등
    name = name.replace(/\s*\(\d+\)$/g, '');

    // "(양장본 HardCover)" 같은 불필요 태그 제거
    name = name.replace(/\s*\(양장본[^)]*\)/gi, '');
    name = name.replace(/\s*\(보급판\)/gi, '');
    name = name.replace(/\s*\(골드\s*에디션\)/gi, '');

    // 잘린 유니코드 글자 정리 (ᄎ~한, ᄋ~ᅩ 등)
    name = name.replace(/[ᄀ-ᇿ]~[ᅡ-ᅵ]?\S*/g, '').trim();

    // 연속 공백 정리
    name = name.replace(/\s+/g, ' ').trim();

    return name;
}

// ── 1단계: 모든 파일의 메타데이터 수집 ──

const files = fs.readdirSync(resolvedDir)
    .filter(f => f.toLowerCase().endsWith('.epub'))
    .sort();

console.log(`📚 총 ${files.length}개 EPUB 파일 발견\n`);

// 모든 파일의 메타데이터를 먼저 수집하여 중복 제목 감지
const fileData = files.map(file => {
    const fullPath = path.join(resolvedDir, file);
    const metadata = extractEpubMetadata(fullPath);
    return { file, fullPath, ...metadata };
});

// ── 2단계: 중복 제목 감지 (메타데이터 오류 의심) ──
// 왜: 같은 시리즈(예: 하버드 강의들)의 EPUB이 내부적으로 동일 제목을 가진 경우가 있음
const titleCounts = {};
fileData.forEach(d => {
    if (d.title) {
        const key = d.title.toLowerCase();
        titleCounts[key] = (titleCounts[key] || 0) + 1;
    }
});

const duplicatedTitles = new Set(
    Object.entries(titleCounts)
        .filter(([, count]) => count > 1)
        .map(([key]) => key)
);

if (duplicatedTitles.size > 0) {
    console.log(`⚠️  메타데이터 제목 중복 감지 (${duplicatedTitles.size}건) — 해당 파일은 기존 파일명 기반으로 정리합니다:`);
    duplicatedTitles.forEach(t => console.log(`   → "${t}" (${titleCounts[t]}개 파일에서 동일 제목)`));
    console.log('');
}

// ── 3단계: 새 파일명 결정 ──

console.log('─'.repeat(80));

let renamed = 0;
let skipped = 0;
let failed = 0;
let unchanged = 0;
const usedNames = new Set();
const results = [];

for (const data of fileData) {
    const { file, fullPath, title, author } = data;

    // 제목 추출 실패 시
    if (!title) {
        // 폴백: 기존 파일명을 정리해서 사용
        const cleaned = cleanExistingFileName(file);
        if (cleaned && cleaned + '.epub' !== file) {
            const newFileName = sanitize(cleaned) + '.epub';
            processRename(file, fullPath, newFileName, '메타데이터 없음 → 파일명 정리');
        } else {
            results.push({ status: '❌ SKIP', old: file, new: '(변경 불가)', reason: '메타데이터 없음, 파일명도 이미 깨끗' });
            failed++;
        }
        continue;
    }

    // 중복 제목인 경우 → 기존 파일명을 정리하여 사용 (메타데이터 오류 의심)
    if (duplicatedTitles.has(title.toLowerCase())) {
        const cleaned = cleanExistingFileName(file);
        const newFileName = sanitize(cleaned) + '.epub';
        processRename(file, fullPath, newFileName, '중복 제목 → 파일명 기반 정리');
        continue;
    }

    // 정상: 메타데이터 기반 이름 생성
    const cleanTitle = sanitize(title);
    const cleanAuthor = author ? sanitize(author) : '';
    const authorPart = cleanAuthor ? ` (${cleanAuthor})` : '';
    const newFileName = cleanTitle + authorPart + '.epub';
    processRename(file, fullPath, newFileName, '');
}

function processRename(oldName, oldFullPath, newFileName, reason) {
    // 중복 파일명 방지
    let finalName = newFileName;
    let counter = 2;
    while (usedNames.has(finalName.toLowerCase()) && counter <= 10) {
        const ext = path.extname(finalName);
        const base = finalName.slice(0, -ext.length);
        finalName = `${base} (${counter})${ext}`;
        counter++;
    }
    usedNames.add(finalName.toLowerCase());

    // 이미 같은 이름이면 건너뜀
    if (oldName === finalName) {
        results.push({ status: '✅ OK', old: oldName, new: finalName, reason: '이미 동일' });
        unchanged++;
        return;
    }

    const newFullPath = path.join(resolvedDir, finalName);

    // 대상에 이미 다른 파일 존재 시 건너뜀 (안전)
    if (fs.existsSync(newFullPath) && oldName !== finalName) {
        results.push({ status: '⚠️ 충돌', old: oldName, new: finalName, reason: '같은 이름 파일 존재' });
        skipped++;
        return;
    }

    if (DRY_RUN) {
        results.push({ status: '🔄 변경예정', old: oldName, new: finalName, reason });
        renamed++;
    } else {
        try {
            fs.renameSync(oldFullPath, newFullPath);
            results.push({ status: '✅ 변경완료', old: oldName, new: finalName, reason });
            renamed++;
        } catch (err) {
            results.push({ status: '❌ 에러', old: oldName, new: finalName, reason: err.message });
            failed++;
        }
    }
}

// ── 결과 출력 ──
console.log('');
for (const r of results) {
    console.log(`${r.status}`);
    if (r.old !== r.new) {
        console.log(`   기존: ${r.old}`);
        console.log(`   변경: ${r.new}`);
    } else {
        console.log(`   파일: ${r.old}`);
    }
    if (r.reason) console.log(`   사유: ${r.reason}`);
    console.log('');
}

console.log('─'.repeat(80));
console.log(`\n📊 결과 요약:`);
console.log(`   🔄 ${DRY_RUN ? '변경 예정' : '변경 완료'}: ${renamed}개`);
console.log(`   ✅ 이미 일치: ${unchanged}개`);
console.log(`   ⚠️ 충돌/건너뜀: ${skipped}개`);
console.log(`   ❌ 실패: ${failed}개`);

if (DRY_RUN && renamed > 0) {
    console.log(`\n💡 실제 적용하려면 --dry-run 플래그를 제거하고 다시 실행하세요.`);
}
console.log('');
