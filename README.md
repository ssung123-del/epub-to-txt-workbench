<div align="center">

# 📖 EPUB Workbench

**EPUB → TXT, Markdown, JSON, HTML. 브라우저에서 끝.**

파일은 어디에도 업로드되지 않습니다. 모든 변환은 당신의 브라우저 안에서만 일어납니다.

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![No Server](https://img.shields.io/badge/Server-None-10b981.svg)](#)
[![PWA Support](https://img.shields.io/badge/PWA-Supported-007f5f.svg)](#)
[![Vanilla JS](https://img.shields.io/badge/JS-Vanilla-f59e0b.svg)](#tech-stack)

</div>

---

## 왜 만들었나요?

EPUB 파일에서 텍스트와 메타데이터, 목차, 심지어 이미지까지 추출하고 싶을 때, 무거운 프로그램을 설치하거나 파일을 외부 서버에 올리는 것은 보안 위험이 따릅니다.  
**`index.html` 하나로 100% 로컬에서 모든 작업을 해결할 수 있습니다.**

---

## ✨ 2026년 신규 개선 및 핵심 기능

| 기능 분류 | 세부 기능 및 설명 |
|:---|:---|
| 🎨 **Premium UI/UX** | 2026 트렌드에 맞춘 **글래스모피즘** 디자인, **다크/라이트 모드** 자동/수동 전환, 부드러운 **마이크로 애니메이션** |
| 📄 **멀티 포맷 출력** | 기존 **TXT** 외에 **Markdown**(YAML 헤더 포함), **JSON**(메타+챕터+통계 구조화), **HTML**(정제된 시맨틱) 지원 |
| 📑 **목차(TOC) 네비게이터** | EPUB 2/3 목차를 트리 구조로 자동 파싱하여 미리보기에서 해당 챕터로 바로 이동 |
| 📊 **텍스트 통계 대시보드** | 글자수, 단어수, 예상 독서 시간, **챕터별 분량 시각화 차트**, **자주 사용된 단어 TOP 10** 분석 (한국어 조사 필터 적용) |
| 🗂 **EPUB 구조 뷰어** | EPUB(ZIP) 내부 파일 시스템 구조 및 파일 크기를 트리뷰로 시각화 탐색 |
| 🖼 **이미지 추출기** | EPUB 내의 모든 이미지(JPG, PNG, GIF, WEBP)를 썸네일로 확인하고 개별 또는 전체 ZIP으로 다운로드 |
| 🕐 **로컬 히스토리** | 브라우저 내장 데이터베이스(IndexedDB)에 변환 기록을 최대 100개까지 자동 저장 및 관리 |
| ⌨ **단축키 및 접근성** | 키보드 중심 조작 단축키 지원, 웹 접근성 지침 준수, 모션 감소 모드 지원 |
| 🔌 **PWA & 오프라인** | **Service Worker** 및 Manifest 탑재로 인터넷 연결이 끊겨도 작동하는 완전한 오프라인 독립형 앱 |

---

## 🚀 빠른 시작

```bash
# 1. 클론
git clone https://github.com/ssung123-del/epub-to-txt-workbench.git

# 2. 브라우저에서 열기
open epub-to-txt-workbench/index.html
```

> **빌드, 설치, 백엔드 서버가 필요 없습니다.** 브라우저만 있으면 즉시 실행됩니다.

---

## ⚙️ 변환 옵션

*   **책 제목 · 저자 · 언어 포함** — 파일 최상단에 메타데이터 정보 추가
*   **챕터 구분선 포함** — `[Chapter N] 제목` 형태의 장 구분선 삽입
*   **공백과 빈 줄 정리** — 불필요한 연속 공백과 다중 빈 줄 제거

---

<a id="tech-stack"></a>
## 🛠 기술 스택

```
HTML5            시맨틱 마크업 · 접근성 (ARIA)
CSS3 (HSL)       CSS Custom Properties · 글래스모피즘 · 다크모드 대응
JavaScript       Vanilla ES2020+ (Worker 미사용 로컬 최적화)
JSZip 3.10.1     EPUB(ZIP) 파싱 및 이미지/TXT ZIP 압축 (CDN)
IndexedDB        로컬 히스토리 영속성 저장
Service Worker   오프라인 캐싱 및 PWA 지원
Google Fonts     Inter (본문) + JetBrains Mono (코드/데이터)
```

---

## 📁 프로젝트 구조

```
epub-to-txt-workbench/
├── index.html     메인 애플리케이션 (시맨틱 UI 및 다이얼로그)
├── style.css      프리미엄 HSL 다크모드 및 글래스모피즘 스타일시트
├── script.js      EPUB 파싱, 통계/TOC 추출, IndexedDB 및 UI 로직
├── manifest.json  PWA 설치 매니페스트
├── sw.js          오프라인 리소스 캐싱 서비스 워커
└── README.md      프로젝트 설명서 (본 파일)
```

---

## ⌨ 키보드 단축키

*   `Ctrl/⌘ + O` — 파일 선택 창 열기
*   `Ctrl/⌘ + D` — 전체 파일 다운로드
*   `Ctrl/⌘ + K` — 미리보기 검색창 포커스
*   `Ctrl/⌘ + Shift + T` — 다크/라이트 테마 강제 토글
*   `1 ~ 7` — 작업 탭 간 전환 (큐, 미리보기, 목차, 통계, 구조, 이미지, 히스토리)
*   `↑ / ↓` — 파일 큐 목록 항목 탐색
*   `?` — 키보드 단축키 도움말 다이얼로그 열기
*   `Esc` — 열려 있는 다이얼로그 닫기

---

## 라이선스

이 프로젝트는 [MIT License](LICENSE)에 따라 오픈 소스로 제공됩니다. 자유롭게 포크하고 개조하여 사용하십시오.
