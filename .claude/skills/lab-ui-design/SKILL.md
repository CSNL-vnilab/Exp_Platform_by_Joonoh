---
name: lab-ui-design
description: lab-reservation 웹 UI/UX 설계·개선 전용. 화면 추가/개선, 컴포넌트 설계, 폼 UX, 모바일 대응, 한국어 카피, "UI 바꿔/예쁘게/불편해/버튼이 안 보여" 류 요청, 참여자·연구자 화면 설계가 나오면 반드시 이 스킬을 사용할 것. 디자인 개선 재실행·부분 수정 요청("이 화면만 다시") 포함. 백엔드 전용 작업은 해당 없음.
---

# lab-ui-design — 웹 UI 설계 규약

repo: `/Users/csnl/Documents/claude/lab-reservation-main`

## 두 페르소나, 두 기준

| | 연구자 (admin) | 참여자 (public) |
|---|---|---|
| 라우트 | `src/app/(admin)/*` | `src/app/(public)/*` (book, booking-edit, payment-info, run) |
| 우선가치 | 정보 밀도, 일괄 작업, 상태 가시성 | 단순함, 신뢰감, 모바일 우선 |
| 실패 양식 | 상태가 안 보여서 운영 혼란 | 다음 행동이 불명확해서 이탈 |
| 카피 톤 | 간결한 존댓말, 도메인 용어 OK | 부드러운 존댓말, 용어 풀어쓰기 |

## 디자인 시스템 (재사용 강제)

- 프리미티브: `src/components/ui/` — Card/CardContent, Button(variant), Input(label 내장), toast (`useToast`)
- 토큰: `text-foreground / text-muted / border-border / bg-card / text-primary / bg-primary` — 새 hex 하드코딩 금지
- 상태 뱃지 관례: emerald(완료/성공), amber(대기/주의), red(실패), sky(정보/링크)
- 모바일: 사이드바는 `lg:` 분기 + 오버레이 패턴 (`src/components/sidebar.tsx` 참조)

## 반복 버그 클래스 → 설계 체크리스트

이 플랫폼에서 실제 반복된 UI 결함. 새 화면/개선마다 체크:

1. **숨은 백엔드 상태**: 발송중/실패/억제/잠금 상태가 화면에 안 보임 → 모든 비동기 액션은 (진행중, 성공, 실패+사유, 재시도 버튼) 4상태를 렌더.
2. **게이트 불일치**: 버튼 활성화 조건이 서버 게이트와 다름 (예: 페이지의 allBookingsCompleted ↔ notify 의 payable.every) → 버튼 조건은 서버 로직과 같은 함수/규약을 인용하고 주석으로 출처 명시.
3. **optimistic UI 미복귀**: 클릭 시 즉시 숨겼는데 서버 실패 → 카드 부활 누락. optimistic 처리엔 반드시 실패 롤백.
4. **새로고침 의존**: `window.location.reload()` 남발 — 가능하면 응답으로 로컬 상태 갱신.

## 작업 워크플로우

1. 대상 화면의 현 구현 + 그 화면이 부르는 API 라우트를 **함께** 읽는다 (경계면).
2. 페르소나 기준표로 문제 정의 → 개선안 (큰 변경이면 2안 비교).
3. 구현 → `tsc --noEmit` → 수동 QC 경로 작성 (URL + 클릭 순서 + 기대 결과).
4. 산출물: `_workspace/{NN}_ui-architect_*.md` + 코드 diff.

## 핵심 화면 맵

| 화면 | 파일 | 주의점 |
|---|---|---|
| 결제 패널 | src/components/payment-panel.tsx (+bookings/page.tsx PaymentSection) | 발송 상태머신 4분기 렌더(883-973행 부근), allBookingsCompleted 게이트 |
| 메타데이터 필 | (admin)/metadata-fill/* | optimistic opt-out + 서버 필터 동기 |
| 예약 플로우 | components/booking/* + (public)/book/[id] | 다세션 슬롯 선택, overlap-aware 슬롯 상태 |
| 참여자 셀프서비스 | (public)/booking-edit/[token]/* | 2h 컷오프 메시지, 토큰 만료 UX |
| 참여자 관리 | (admin)/participants/* | 모드 탭(오프라인/온라인), PII 전체 공개 정책(재게이트 금지) |
