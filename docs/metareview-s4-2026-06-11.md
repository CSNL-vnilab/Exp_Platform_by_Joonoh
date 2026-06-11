# S4 신규 6렌즈 메타리뷰 검증기록 (2026-06-11)

블라인드 리뷰 기존 6렌즈(상태머신/지급/금액/취소변경/백필/크론)와 **무중복** 신규 각도. 36 agents, ~1.9M tokens. confirmed 17 / uncertain 1 / refuted 12 (+ verifier 7건 rate-limit 사망 → S5에서 재검증).

## 렌즈별 설계 평가

### security-authz
인증·인가 측면에서 이 플랫폼의 가장 큰 구조적 약점은 "RLS 우회(createAdminClient)에 의존하는 라우트의 권한 게이트가 표준 헬퍼(requireExperimentAccess/requireBookingAccess)와 그것을 손으로 복제한 변형으로 양분되어 있다"는 점이다. 손복제 변형들은 대부분 owner/admin 체크 + experiment_id 바인딩을 올바르게 갖췄지만, 일관성이 코드 리뷰로만 강제되고 컴파일러로 강제되지 않아 새 라우트가 추가될 때마다 드리프트 가능성이 상존한다. 두 번째 약점은 인가 계층이 "행(row) 존재 여부"는 잘 막지만 "열(column) 노출 범위"는 거의 통제하지 않는다는 것 — RLS는 행 단위이고 라우트는 대부분 select("*")를 쓰기 때문에, 공개적으로 읽혀야 하는 리소스(active experiment)에서 연구자 내부 설정(주의검사 정답·조건배정 로직·내부 경로)이 그대로 새어 나간다. 세 번째는 admin 게이트가 role.ts의 redirect() 패턴과 인라인 profile.role 체크로 이원화되어 있어, 게이트 통과 전에 실행되는 부수효과(stampAttempt 등)가 다른 연구자 리소스를 건드릴 수 있는 작은 틈을 남긴다.

### pii-privacy
RRN/계좌/통장사본의 가장 큰 구조적 약점은 "민감 PII가 외부로 나가는 출구가 평문이고, 출구의 수신처를 사용자가 임의로 정한다"는 점이다. 청구 디스패치(payment-claim email)는 RRN을 평문으로 담은 xlsx + 계좌번호 + 통장사본 스캔을 일반 SMTP(STARTTLS opportunistic)로, 연구원이 모달에서 자유 입력한 임의 이메일 주소(도메인 allowlist 없음)로 발송한다 — 암호화·접근통제로 지켜온 at-rest 자산이 transit/recipient 단계에서 전부 풀린다. 두 번째 약점은 RRN/토큰 암호화가 AAD(row-binding) 없는 AES-GCM이고 RRN과 토큰이 동일 키를 공유한다는 것 — 암호문이 행/실험에 묶여있지 않아 RLS UPDATE 권한을 가진 연구원이 타 행의 rrn_cipher 3-튜플을 자기 실험 행으로 복사해 엑셀 export로 복호 결과를 얻을 수 있다(키 분리의 "blast radius" 목표가 무력화). 세 번째는 토큰 60일 TTL + 분산공격을 막지 못하는 per-Lambda 인메모리 rate-limit으로, RRN 입력 폼 토큰의 brute/leak 방어가 구조적으로 얇다.

### observability
관측성의 구조적 약점은 "수집은 있으나 평가/푸시가 없다"는 단절에 있다. 플랫폼은 실패를 성실히 기록한다(booking_integrations.last_error, payment_link_last_error, notion_health_state, reminders.status='failed') — 그러나 그 기록을 누가/언제 보느냐는 거의 전적으로 "연구원이 자기 대시보드를 열어 자기 소유 행을 우연히 본다"에 의존한다. 능동 알림(Slack)은 GH Actions의 워크플로 실패(HTTP≠200)에만 묶여 있는데, 모든 cron 라우트가 부분/전면 실패에도 ok:true·HTTP 200을 반환하므로 알림 채널이 사실상 무력화된다. 둘째 약점은 커버리지 비대칭이다: booking_integrations(gcal/email/sms/notion)는 dead-letter 타일·staleness 검출까지 갖췄지만, 동급으로 운영상 중요한 reminders(유료 SMS) 테이블과 participant_payment_info(돈) 디스패치 실패는 그 관측 인프라 바깥에 있어 집계·알림 어디에도 잡히지 않는다. 셋째, 헬스 엔드포인트(/api/health/queue)는 ok:false 백로그 신호를 계산하도록 잘 만들어졌으나 어떤 스케줄러도 유효 시크릿으로 호출해 그 신호를 평가하지 않아 dead code에 가깝다. 결과적으로 "백엔드 상태가 안 보인다"는 사용자가 본 버그 클래스는 개별 증상만 패치됐을 뿐 — 실패를 능동적으로 운영자에게 밀어주는 단일 경로의 부재라는 뿌리는 그대로 남아 있다.

### ux-consistency
이 플랫폼의 UI는 표면적으로 정교하다 — payment-info 폼, run-shell, 본인확인 게이트는 로딩/에러/복구/접근성(role=alert, aria-live, 허니팟, 캔버스 retina 처리)이 모범적으로 구현돼 있다. 그러나 구조적 약점은 두 군데에 집중된다. 첫째, '클라이언트 게이트 ↔ 서버 기록'의 단절이다: 사람대상 IRB 플랫폼임에도 오프라인 예약의 데이터수집 동의 체크박스가 버튼만 막을 뿐 서버에 전혀 기록되지 않아(POST body에서 누락) 감사 증적이 없다. 둘째, 공용 컴포넌트(Modal, StepIndicator, Toast)의 접근성·일관성이 페이지 단위 정성에 비해 뒤처져 있어 — ARIA 라벨 부재, 자동소멸 토스트가 예약실패의 유일 피드백 채널 — 키보드/스크린리더 사용자와 PII를 다루는 참여자가 일관된 경험을 받지 못한다. 페르소나 혼용 안티패턴은 거의 없으나(레이아웃이 깔끔히 분리됨), 실시간 슬롯 동기화의 stale-closure 버그가 참여자에게 '예약 가능해 보이는데 거부되는' 인지 부조화를 만든다.

### query-perf
쿼리 성능 관점에서 가장 큰 구조적 약점은 "DB가 해야 할 집계/필터를 애플리케이션 메모리로 끌어올리는 패턴"이 참여자 관리 경로에 집중돼 있다는 점이다. /api/participants는 mode/class 필터를 인덱스 없는 컬럼(experiment_mode) 위에서 전체 스캔으로 후보 participant_id 집합을 JS로 만들고, 그 임의 크기의 ID 배열을 다시 .in()으로 되먹이는 2단 구조여서 데이터가 수백→수천으로 늘면 가장 먼저 무너진다. 슬롯 픽커·예약목록·결제패널 같은 다른 hot 경로는 오히려 잘 배치(batch)·캐시돼 있어(freebusy 5분 캐시, range 단일쿼리, claim-bundle 바운디드 동시성) 양극화가 뚜렷하다 — 한쪽은 모범적이고 한쪽은 인덱스/페이지네이션 가드가 통째로 빠져 있다. 단일 랩 규모라 당장 장애는 아니지만, 참여자 풀이 커질수록 가장 자주 열리는 화면이 가장 먼저 느려지는 비대칭이 핵심 리스크다.

### test-coverage
테스트 커버리지 관점에서 이 플랫폼의 구조적 약점은 세 가지다. (1) CI 게이트가 사실상 비어 있다 — .github/workflows/ci.yml 은 tsc --noEmit + 문서동기화 2종(test-guide-bridge-sync, migration-status)만 돌린다. scripts/ 안의 19개 test-*.mjs 와 모든 e2e-*.mjs 는 CI 가 한 번도 호출하지 않아 merge 를 막지 못하고, 누군가 수동으로 기억해야만 돈다. (2) 이번 세션에 추가된 회귀위험 핵심 로직(status SSOT canTransition/isLive, reschedule_booking RPC 동시성, reminder 부분실패/재시도, no_show 게이트, recommendAmount 정산금액 계산)은 단 한 줄의 테스트도 없다 — recommendAmount/canTransition 처럼 순수함수라 ROI 가 가장 높은 대상조차 비어 있다. (3) 가장 위험한 클래스는 "SSOT 모듈은 대칭을 강제하는데 그 모듈을 import 하지 않는 라우트가 비대칭을 재도입"하는 케이스다 — 상태전이 매트릭스와 dispatch 분기가 코드 여러 곳에 흩어져 있고 이를 한 번에 묶어 검증하는 통합 테스트가 없어, status.ts 가 막으려던 바로 그 no_show 사고가 라우트 레이어에서 되살아나 있는데 아무도 못 잡는다.

## Confirmed (17)

| # | sev | lens | finding | 처리 |
|---|-----|------|---------|------|
| 0 | critical | pii-privacy | 청구 디스패치 메일이 평문 RRN·계좌·통장사본을 임의 수신처로 발송 — 도메인 allowlist 없음 | S5 수정중(critical PII) |
| 1 | high | observability | 모든 cron 라우트가 부분·전면 실패에도 HTTP 200(ok:true)을 반환 → GH Actions notify-cron-failure가 절대 발화하지 않음 (알림 채널 무력화) | S5 수정중(cron outage) |
| 2 | high | observability | 실패한 reminders(유료 SMS 채널)가 어떤 대시보드·알림에도 잡히지 않음 — reminders 테이블이 booking_integrations dead-letter 관측 인프라 바깥 | 백로그(reminders 관측 — booking_integrations outbox 편입) |
| 3 | medium | observability | 지급 안내 메일 디스패치 실패(payment_link_last_error/attempts)가 집계·알림 어디에도 없음 — 해당 실험 bookings 페이지를 직접 열어야만 보임 | 백로그(payment 디스패치 집계) |
| 4 | high | ux-consistency | 데이터수집 동의 체크박스가 버튼만 게이팅하고 서버에 전혀 기록되지 않음 (IRB 감사 증적 부재) | 백로그-high(IRB 동의 서버기록 — 스키마 변경) |
| 5 | medium | ux-consistency | WeekTimetable 실시간 슬롯 동기화의 stale-closure — 갱신된 가용성이 아닌 구버전으로 선택 prune 판단 | 백로그 |
| 6 | medium | ux-consistency | 공용 Modal — dialog/닫기버튼에 ARIA 라벨 부재, 스크린리더가 모달 제목·닫기 의도를 못 읽음 | 백로그 |
| 7 | low | ux-consistency | 예약 단계 진행표시(StepIndicator)가 순수 시각 — aria-current/진행상태 안내 없음 | 백로그 |
| 8 | low | ux-consistency | 예약 실패 피드백이 3초 자동소멸 토스트가 유일 채널 — 메시지 유실 위험 | 백로그 |
| 9 | high | query-perf | 참여자 관리 mode 필터: experiment_mode 인덱스 부재 + 전체 bookings 스캔을 JS Set으로 수집 (기본 탭이라 매 로드마다 실행) | 백로그(참여자관리 인덱스 — 단일랩 규모상 medium 실질) |
| 10 | medium | query-perf | class/mode 필터가 만든 임의 크기 candidateIds를 .in()으로 되먹임 — 대용량 IN 리스트 + 페이지네이션이 후처리라 비효율 | 백로그 |
| 11 | medium | query-perf | 참여자 이름/전화 검색이 선행 와일드카드 ILIKE — trigram 인덱스 없어 매 검색이 seq scan | 백로그 |
| 12 | low | query-perf | 블랙리스트/클래스 변경 cascade가 미래 예약을 한 건씩 순차 UPDATE + 그룹당 순차 dispatch (N+1 쓰기) | 백로그 |
| 13 | high→downgrade | test-coverage | recommendAmount 정산금액 계산기가 순수함수인데 테스트 0 — 비례계산/반올림/경계조건 회귀 시 잘못된 지급액을 조용히 추천 | 백로그(recommendAmount 단위테스트) |
| 14 | high | test-coverage | reminder 부분실패/재시도 분기(email-OK/SMS-fail vs total-fail, attempts<3)가 테스트 0 — 회귀 시 유료 SMS 중복발송 또는 리마인드 영구손실 | 백로그-high(reminder 재시도 테스트) |
| 15 | medium | test-coverage | reschedule_booking RPC 동시성(00072)이 통합테스트 0 — 라우트의 advisory-lock 밖 capacity SELECT 와 RPC 원자검증 사이 레이스가 무검증, 더블부킹 회귀 가능 | 백로그(reschedule RPC 동시성 테스트) |
| 16 | medium | test-coverage | canTransition/isLive/isTerminalNonPayable SSOT 가 미러일 뿐인데 SQL 규약과의 정합을 자동검증하는 테스트 0 — TS/SQL 드리프트가 침묵 | 백로그(SSOT↔SQL 정합 테스트) |

## Uncertain (1) / Reverify (S5)
- (low) [security-authz] admin 전용 mutation 라우트들이 role.ts requireAdmin()의 redirect() 패턴에 의존 — API에서 403 대신 307을 반환하며 게이트 의미가 비명시적

rate-limit 으로 verifier 사망한 7건(security 렌즈 다수 포함)은 S5 에서 재검증 → 결과는 본 문서에 추가 예정.