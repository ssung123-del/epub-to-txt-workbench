<div align="center">

# 📖 EPUB TXT Workbench

**EPUB → TXT, 브라우저에서 끝.**

파일은 어디에도 업로드되지 않습니다. 모든 변환은 당신의 브라우저 안에서만 일어납니다.

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![No Server](https://img.shields.io/badge/Server-None-10b981.svg)](#)
[![Vanilla JS](https://img.shields.io/badge/JS-Vanilla-f59e0b.svg)](#tech-stack)

</div>

---

## 왜 만들었나요?

EPUB 파일에서 텍스트만 뽑고 싶을 때, 무거운 프로그램을 설치하거나 파일을 외부 서버에 올리는 건 불필요합니다.  
**`index.html` 하나만 열면 됩니다.**

---

## ✨ 핵심 기능

| 기능 | 설명 |
|:-----|:-----|
| 🔒 **완전한 프라이버시** | 서버 업로드 없음, 100% 로컬 처리 |
| 📂 **드래그 앤 드롭** | 파일을 끌어다 놓으면 바로 변환 시작 |
| 📚 **대량 처리** | 최대 80개 파일 동시 변환 (파일당 150MB) |
| 🏷️ **메타데이터 추출** | 제목 · 저자 · 언어 자동 파싱 |
| ⚙️ **세밀한 옵션** | 챕터 구분선, 메타데이터 포함, 공백 정리 |
| 🔍 **실시간 미리보기** | 변환 결과 즉시 확인 + 텍스트 검색 |
| 📋 **클립보드 복사** | 원클릭 복사 |
| 📦 **ZIP 다운로드** | 여러 파일은 ZIP으로 한 번에 |
| 🔄 **실패 재시도** | 개별 파일 재변환 가능 |

---

## 🚀 빠른 시작

```bash
# 1. 클론
git clone https://github.com/ssung123-del/epub-to-txt-workbench.git

# 2. 브라우저에서 열기
open epub-to-txt-workbench/index.html
```

> **그게 끝입니다.** 빌드, 설치, 의존성 설정이 없습니다.

---

## ⚙️ 변환 옵션

| 옵션 | 기본값 | 설명 |
|:-----|:------:|:-----|
| 책 제목 · 저자 · 언어 포함 | ✅ | TXT 상단에 메타데이터 헤더 추가 |
| 챕터 구분선 포함 | ✅ | `[Chapter N] 제목` 형태의 구분선 삽입 |
| 공백과 빈 줄 정리 | ✅ | 불필요한 공백·빈 줄 제거 |

---

<a id="tech-stack"></a>
## 🛠 기술 스택

```
HTML5          시맨틱 마크업 · 접근성 (ARIA)
CSS3           Custom Properties · 반응형 (980px / 680px)
JavaScript     Vanilla ES2020+ · 프레임워크 없음
JSZip 3.10.1   EPUB(ZIP) 파싱 (CDN)
IBM Plex       Sans KR + Mono (Google Fonts)
```

---

## 📐 작동 원리

```
EPUB 파일 (ZIP)
  ↓
META-INF/container.xml 파싱
  ↓
OPF 파일에서 manifest + spine 추출
  ↓
spine 순서대로 챕터 HTML 순회
  ↓
HTML에서 텍스트만 추출 + 정규화
  ↓
TXT 생성 → 다운로드 (단일 또는 ZIP)
```

---

## 📁 프로젝트 구조

```
epub-to-txt-workbench/
├── index.html     앱 셸 · 시맨틱 마크업
├── style.css      디자인 시스템 · 반응형 레이아웃
├── script.js      EPUB 파싱 · UI 로직
└── README.md      이 파일
```

---

## 접근성

- **키보드 내비게이션** — skip-link, tabindex, 포커스 관리
- **스크린 리더** — aria-label, aria-live, role 속성
- **모션 감소** — `prefers-reduced-motion` 미디어쿼리 대응

---

## 제한 사항

- DRM이 걸린 EPUB 파일은 처리할 수 없습니다
- 이미지, 오디오 등 미디어 콘텐츠는 추출되지 않습니다 (텍스트만)
- 매우 큰 파일(150MB 초과)은 제외됩니다

---

## 라이선스

[MIT](LICENSE) — 자유롭게 사용, 수정, 배포할 수 있습니다.

---

<div align="center">
<sub>서버 없이, 프레임워크 없이, 설치 없이.</sub>
</div>
