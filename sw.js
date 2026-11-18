// EPUB Workbench — Service Worker
// 오프라인 동작을 위해 핵심 파일과 CDN 리소스를 캐시합니다.

const CACHE_NAME = 'epub-wb-v3';

// 캐시할 핵심 자원 목록
const CORE_ASSETS = [
    './',
    './index.html',
    './style.css',
    './script.js',
    './manifest.json',
];

// CDN 리소스는 런타임에 캐시 (네트워크 우선, 실패 시 캐시)
const CDN_PATTERNS = [
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'cdnjs.cloudflare.com'
];

// 설치: 핵심 파일 프리캐시
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(CORE_ASSETS))
            .then(() => self.skipWaiting())
    );
});

// 활성화: 이전 캐시 정리
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys
                    .filter((key) => key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

// 요청 가로채기: 캐시 우선 전략 (핵심 파일), 네트워크 우선 (CDN)
self.addEventListener('fetch', (event) => {
    const { request } = event;

    // POST 등 비-GET 요청은 무시
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // CDN 리소스: 네트워크 우선, 실패 시 캐시
    const isCdnRequest = CDN_PATTERNS.some((pattern) => url.hostname.includes(pattern));

    if (isCdnRequest) {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    // 정상 응답이면 캐시에 저장
                    if (response.ok) {
                        const cloned = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, cloned));
                    }
                    return response;
                })
                .catch(() => caches.match(request))
        );
        return;
    }

    // 로컬 파일: 캐시 우선, 없으면 네트워크
    event.respondWith(
        caches.match(request)
            .then((cached) => {
                if (cached) return cached;

                return fetch(request).then((response) => {
                    // 같은 origin의 정상 응답만 캐시
                    if (response.ok && url.origin === self.location.origin) {
                        const cloned = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, cloned));
                    }
                    return response;
                });
            })
    );
});
