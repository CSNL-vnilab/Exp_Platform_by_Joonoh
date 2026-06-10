---
name: lab-vercel-optimize
description: lab-reservation 의 Vercel/Next.js 성능·배포 최적화 전용. "느려/무거워/빌드 오래 걸려/번들 줄여/콜드스타트/캐시" 류 요청, 함수 사이즈 초과, 배포 실패 진단, cron 토폴로지 변경, 성능 재측정·최적화 재실행 요청이 나오면 반드시 이 스킬을 사용할 것. 기능 버그 수정은 해당 없음.
---

# lab-vercel-optimize — 성능·배포 최적화 규약

repo: `/Users/csnl/Documents/claude/lab-reservation-main` · 프로젝트: `lab-reservation` (alias lab-reservation-seven.vercel.app)

## 측정 먼저 (baseline 없으면 시작 금지)

```bash
# 빌드/번들 — First Load JS per route 표가 핵심
/Applications/Codex.app/Contents/Resources/node node_modules/next/dist/bin/next build 2>&1 | tail -60
# 함수/배포 인스펙션
vercel inspect <deployment-url>   # 람다 사이즈 목록
# 무거운 의존성 후보
du -sh node_modules/* | sort -rh | head -15
```

baseline → 변경 → 동일 지표 재측정 → 전/후 표를 산출물에 포함.

## Hobby 티어 제약 (설계 입력)

- cron: 2개 한도 + **일 1회 미만 주기 불가** (`*/15` 는 배포 자체가 거부됨 — 2026-05-29 실측). 서브-daily 는 GH Actions(1-4h 지터 감수, 시간 민감 작업은 스케줄 보정 — 예: 리마인더 07:00 KST 선행).
- 동시 빌드 1: 연속 push 는 이전 빌드 CANCELED → push 후 60초 대기 (AGENTS.md 규칙 2).
- 함수 사이즈: 템플릿 자산(NanumGothic 2MB, xlsx/docx/pdf 템플릿)이 번들에 포함됨 — payment 라우트 함수가 최대. 새 대형 자산은 여기 영향 평가 필수.

## 알려진 최적화 지형 (2026-06-10 기준)

| 항목 | 상태 | 비고 |
|---|---|---|
| NanumGothic full-embed (PDF ~780KB/장) | 의도됨 | subset:true 가 글리프 드랍 버그 → fontkit 업데이트 후 재시도 가능 |
| pdfkit + pdf-lib 공존 | 정리 후보 | pdfkit 은 overlay 방식 도입으로 미사용 — 제거 시 deps 감소 |
| exceljs | 사용처 확인 후 정리 후보 | template-filler 는 JSZip 직접 조작 |
| freebusy-cache | 유지 | GCal 호출 절감 — 무효화 경로(invalidateCalendarCache) 끊지 말 것 |
| pdfjs-dist | devDep 화 후보 | 런타임 미사용(좌표 추출은 빌드타임) |

## 안전 규칙

- 캐시 무효화 경로(invalidateCalendarCache, templateCache miss)를 끊는 변경 금지.
- dynamic import 로 라우트별 코드 분리 시, 결제 번들 빌더처럼 동기 의존이 있는 곳은 콜드스타트 비용과 비교 후 결정.
- 측정 불가 항목(실사용 TTFB 등)은 vercel logs / x-vercel-cache 헤더로 대체 측정.

## 배포 검증

변경 배포 후: `vercel ls` Ready 확인 → `NEXT_PUBLIC_APP_URL=https://lab-reservation-seven.vercel.app node scripts/smoke-all.mjs` 4/4 → 핵심 페이지 1개 curl 응답코드. 실패 시 직전 커밋으로 revert 커밋(force-push 금지).
