# Migration prompt — drawio-mcp 로 다이어그램 변환

> **이 문서를 새 Claude Code 세션의 첫 user message 로 그대로 붙여넣으세요.**
> 단일 파일로 컨텍스트 회복 + 작업 지시까지 끝나도록 설계됨.

---

## 0. 컨텍스트 (이전 세션에서 한 일)

2026-05-01 세션에서:

1. `lab-reservation` 의 architecture 를 칠판 그림 ↔ 코드 1:1 매핑 후 정리.
2. 3개 mermaid 다이어그램으로 `docs/architecture.md` 작성 → 외부 협력자/리뷰어 청중.
3. 3개 adversarial review 병렬 실행 (architect / security / devil's-advocate 관점) → 핵심 오류 수정 (BUNDLER 위치, GCal description PII 노출, cron count, RNG 표기, RUN_TOKEN_SECRET fallback, 다이어그램 분리 1a + 1b).
4. README 의 `<img src="architecture.svg">` → mermaid inline 으로 교체.
5. `@drawio/mcp` user-scope MCP 설치 — **이번 세션에서 처음으로 `mcp__drawio__*` tools 가 로드됨**.
6. 다이어그램 1a 의 디자인·가독성 1차 개선 (TB 방향, subgraph 그룹핑, 4-tier 컬러링).

**현재 상태**: 모든 변경 `main` 푸시 완료. 자동 배포 정상화 (`requireVerifiedCommits: false`).

---

## 1. 이 세션 목표

`docs/architecture.md` 의 mermaid 다이어그램 3종을 **drawio-mcp 로 .drawio 로 변환** 하고, mermaid 가 표현 못하는 부분을 native drawio 로 보강.

### 변환 대상 (3종)

| # | 위치 | 노드 수 | 우선순위 |
|---|---|---|---|
| 1a | `docs/architecture.md` §1a — 사용자가 보는 것 | 5 | LOW (mermaid 로도 충분히 읽힘) |
| 1b | `docs/architecture.md` §1b — 내부 메커니즘 | ~25 | **HIGH** (.drawio 로 가야 깔끔) |
| 2-A | `docs/architecture.md` §2-A — 업로드 sequence | 6 actors | MED (sequence 는 mermaid 가 OK) |
| 2-B | `docs/architecture.md` §2-B — 검색 sequence | 3 actors | LOW |
| 3 | `docs/architecture.md` §3 — Data Flow | ~18 | **HIGH** |

### 산출물 형태

각 다이어그램마다:
- `docs/diagrams/<name>.drawio` (편집 가능 native)
- `docs/diagrams/<name>.svg` (README · architecture.md 에 임베딩, 검색 가능 텍스트 유지)

`architecture.md` 의 mermaid 블록은 그대로 두되, 각 다이어그램 위에 `<picture>` 태그로 .svg 임베딩 추가.

---

## 2. 디자인 규칙 (지켜야 할 일관성)

### 컬러 (현 mermaid classDef 와 동일하게 유지)

| 카테고리 | 채우기 | 테두리 | 글자색 |
|---|---|---|---|
| Actor (연구자/참여자) | `#e8f5ff` | `#3a87cd` 2px | `#1a4480` |
| App (Vercel/Next.js) | `#e8fff0` | `#28a745` 2px | `#0d4825` |
| LLM Provider | `#f5e8ff` | `#9333ea` 1.5px | `#4a1d7a` |
| Store (Supabase, NAS) | `#f0f8ff` | `#4a90e2` 2px | `#1a4480` |
| Source (입력원) | `#fffbe6` | `#b8860b` 1.5px | `#5a3a00` |
| Process (가공) | `#e8fff0` | `#28a745` 1.5px | `#0d4825` |
| Mirror (외부 미러) | `#fff4e6` | `#e08a3c` 1.5px | `#7a4a1c` |
| Warn (PII 노출지점) | `#ffe6e6` | `#d34a2a` 2px | `#7a1c1c` |
| Cron | `#f5f5dc` | `#9ca36e` 1.5px | `#4a4a1c` |

### 도형

- Actor → ellipse (`(())` in mermaid)
- App / Process → rounded rectangle
- Store / DB → cylinder (`[(...)]` in mermaid)
- Mirror / External → rectangle
- Cron → notched/parallelogram
- Subgraph → labeled container

### 라벨 규칙

- 한글 위주, 기술 용어는 영문 유지 (Vercel / Supabase / Notion).
- 데이터 방향 라벨은 **"무엇이 흐르는가"** 적기 (예: "FreeBusy 조회", "이벤트 생성"). "왜" 가 아니라 "무엇" — `회의 충돌 회피` 같은 효과 라벨은 금지.
- 양방향 화살표는 양쪽 라벨 분리 (예: 위쪽 "읽기·쓰기", 아래쪽 보조 라벨).

### 용어 (강제)

- "배포" → **"업로드"**
- "학습" → **"자료 등록" / "메모리 갱신" / "인덱싱"** (맥락에 맞게)
- "production deploy" → "프로덕션 업로드"

---

## 3. drawio-mcp 사용 가이드

설치된 패키지: `@drawio/mcp` (user-scope, `~/.claude.json`).

이번 세션 시작 시 자동 로드되는 tools (대략, ToolSearch 로 확인):
- `mcp__drawio__create_diagram` — XML 또는 Mermaid 입력 → .drawio 파일 또는 inline 렌더
- `mcp__drawio__search_shapes` — 10000+ shape 라이브러리 검색 (AWS, GCP, 일반 도형 등)
- 외 export 관련 tools

권장 흐름:
1. 첫 turn: `ToolSearch query "select:mcp__drawio__*"` 로 정확한 schema 확보
2. mermaid 블록을 그대로 `create_diagram` 에 넣어서 1차 .drawio 생성
3. `search_shapes` 로 더 적합한 도형 (예: AWS Lambda 모양 → Vercel Functions, Postgres 코끼리 → Supabase Postgres) 찾아 교체
4. `.drawio` 다운로드 → `docs/diagrams/<name>.drawio`
5. 필요시 GUI 에디터로 layout 미세조정 (drawio.com 에서 열기)
6. `.svg` export (drawio CLI 또는 desktop) → `docs/diagrams/<name>.svg`

PNG/SVG export 가 자동화되지 않는다면 사용자에게 한 번만 부탁.

---

## 4. mermaid 가 표현 못한 것 (drawio 에서 보강해야 할 것)

| 보강 항목 | 현재 mermaid 표현 | drawio 에서 |
|---|---|---|
| Trust boundary | 표현 없음 | 점선 박스로 "anonymous" / "authenticated" 영역 시각 구분 |
| 데이터 방향 화살표의 굵기 차이 | `-->` `==>` `-..-` 3종 | 두께 + 색깔 + endpoint 모양 4축 변별 |
| Multi-source 화살표 | `A & B & C --> D` (렌더 불안정) | 명시적 hub 또는 분기점 노드 |
| Subgraph 안의 nested subgraph | mermaid 1단 깊이만 깔끔 | 무제한 |
| Sticky note / 주석 | 없음 | 노란 sticky 추가 |

특히 Diagram 1b 에서:
- Vercel Functions 박스 안의 5개 sub-component 는 trust boundary 안쪽 (auth 통과)
- LLM Provider 는 trust boundary 바깥 (외부 호출)
- 명시적 boundary 표시 필요

Diagram 3 에서:
- "PII 중복지점" 구역을 빨간 점선 박스로 묶어서 시각 강조
- GCal description 만 단독 warn 색은 약함

---

## 5. 검증 절차

각 .drawio + .svg 생성 후:
1. **렌더 확인** — GitHub 에 push 한 뒤 README + architecture.md 에서 .svg 가 제대로 보이는지
2. **다크모드** — drawio 의 `darkMode` 옵션으로 dark 버전도 생성 (`<picture>` 의 `media="(prefers-color-scheme: dark)"` 활용)
3. **모바일 뷰포트** — 1b 가 너무 wide 하면 수직 stack 으로 fallback
4. **adversarial re-review** — 이전 세션과 동일한 3 perspective 로 1회만 추가 검토 (시간 비용 대비 가치 충분)

---

## 6. 파일 맵 (이번 세션이 손댈 곳)

```
docs/
  architecture.md                           ← mermaid 블록 위에 .svg 임베딩 추가
  diagrams/                                 ← 신규 디렉토리
    01a-system-user-visible.drawio
    01a-system-user-visible.svg
    01b-system-internal.drawio
    01b-system-internal.svg
    02a-flow-upload.drawio                  (sequence — 선택)
    02a-flow-upload.svg
    02b-flow-search.drawio                  (sequence — 선택)
    02b-flow-search.svg
    03-data-flow.drawio
    03-data-flow.svg
README.md                                   ← 1a .svg 임베딩으로 교체
docs/handoff/drawio-conversion-prompt.md    ← 이 문서. 작업 끝나면 archive 로 이동.
```

---

## 7. 중요 제약

1. **mermaid 블록을 지우지 말 것**. .svg 와 함께 두 형태로 보존 — mermaid 는 GitHub diff 에서 변경사항 추적이 쉽고, .svg 는 이쁘다. `<picture>` 안에 .svg 두고 그 아래 `<details><summary>Mermaid source</summary>` 로 mermaid 보존.

2. **`docs/architecture.svg` (구 파일) 을 만들지 말 것**. 이전 세션이 mermaid 로 옮긴 이유가 있었고 (단일 svg 파일 다중 생산 어려움), 새 시스템은 다이어그램 별로 분리.

3. **multi-session 규칙 (AGENTS.md §6, §7)** — push 전에 `git fetch && git log HEAD..origin/main` 확인. 다른 세션의 미커밋 작업 덮어쓰지 않기. 60초 간격 prod-affecting 푸시.

4. **Vercel 자동배포는 정상**. push 하면 auto-deploy. 단 docs/ 변경은 `vercel.json` 에 build-skip 룰 없으면 prod 빌드 트리거하므로 의미 없는 cron 알람 발생 가능 — 가능하면 docs PR 단위로 묶어 한 번에 push.

5. **drawio shape 라이브러리** — Vercel 공식 로고 없음. 이름표 + 색깔로 표현. Supabase 도 마찬가지. 일반 cloud 아이콘 또는 회사 워드마크 사용.

---

## 8. 완료 정의

- [ ] `mcp__drawio__*` tools 로드 확인 (ToolSearch)
- [ ] 1a, 1b, 3 — .drawio + .svg 페어 생성
- [ ] (선택) 2-A, 2-B sequence 도 .drawio 로 변환
- [ ] `architecture.md` 에 .svg 임베딩 (`<picture>` + dark mode media query)
- [ ] `README.md` 의 1a inline mermaid 도 .svg 로 교체
- [ ] 3 perspective adversarial re-review (architect / security / devil's-advocate) 1회
- [ ] 모든 변경 `main` 에 push, auto-deploy 통과 확인
- [ ] 이 prompt 파일은 archive 로 이동: `docs/handoff/archive/drawio-conversion-prompt.md`

---

## 9. 안 해야 할 것

- **doc 의 사실관계 변경 금지** — adversarial review 가 검증한 사실들 (GCal PII, cron 6+1, mulberry32 uint32, RUN_TOKEN_SECRET fallback 등) 은 이미 정확함. 다이어그램의 시각화만 개선.
- **scope creep 금지** — 새 다이어그램 추가 금지. 기존 3종 + (선택) sequence 2종만.
- **Paperzilla / csnl-ops 까지 끌어들이지 말 것** — 이 doc 의 청중은 lab-reservation reviewer. ecosystem 인벤토리는 이미 §7 에 표로 정리됨.

---

*Source: 2026-05-01 stress-test session, commit `24ca277` 시점.*
