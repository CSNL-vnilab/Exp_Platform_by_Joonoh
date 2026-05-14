# Component 명세 — Figma 마스터 라이브러리에 등록할 14 종

이 문서는 Figma 파일을 처음 만들 때 **한 번** 등록해 둘 master component
목록입니다. 등록 후 연구자는 좌측 Assets 패널에서 instance 를 drag 하기만
하면 5색 규약을 자동으로 따릅니다.

각 component 의 명세는 [`design-tokens.json`](./design-tokens.json) 의 토큰
이름과 1:1 대응됩니다. Figma 의 Local Variables / Local Styles 에 토큰을
import 한 뒤 component 만들기를 진행하세요.

---

## 명명 규칙

`category / variant — purpose` 형식. 예: `box / action — researcher action`.
이 형식으로 만들면 Figma 의 Assets 패널이 자동으로 group 화합니다.

---

## 박스 component (7 종)

### 1. `box / action — researcher or participant action`
- **언제 쓰나**: 워크플로 도식의 *왼쪽 column* (사용자·연구자·시스템이 행하는 일)
- **fill**: `color.system.fill-tint` (`#dae8fc`)
- **stroke**: `color.system.border` (`#1f4e79`) · `strokeWidth.default` (2 px)
- **borderRadius**: `borderRadius.default` (8 px)
- **font**: `fontFamily.default` · `fontSize.box-label` (12) · `fontWeight.regular`
- **default size**: 380 × 80
- **text alignment**: center / verticalAlign middle
- **variants**: `emphasized` (`strokeWidth.bold` 3 px + `fontWeight.bold`) — 활성화 토글 등 결정적 단계용

### 2. `box / table — data table group`
- **언제 쓰나**: 워크플로 도식의 *가운데 column* (데이터베이스 테이블 묶음) 또는 ERD 의 anchor 박스
- **fill**: `color.system.fill-very-light` (`#f3f8fd`)
- **stroke**: `color.system.border` · `strokeWidth.extra-bold` (4 px)
- **borderRadius**: `borderRadius.default`
- **internal layout**: 상단에 14 pt bold header text + 그 아래 11 pt sub-fields 박스 (각 sub-field 는 흰 fill · 1 px stroke)
- **default size**: 가변 (600 × N rows; row 마다 44 ~ 56 px)
- **variants**: `with-encryption-badge` (한 sub-field 박스가 주황 highlight) — 신분 정보 암호화 등 표시용

### 3. `box / result — external send / outcome`
- **언제 쓰나**: 워크플로 도식의 *오른쪽 column* (외부로 나가는 결과·발송·동기화)
- **fill**: `color.external.fill-tint` (`#fff8e1`)
- **stroke**: `color.external.border` (`#a17000`) · `strokeWidth.default`
- **borderRadius**: `borderRadius.default`
- **font**: `fontFamily.default` · `fontSize.box-label` · `fontWeight.regular`
- **default size**: 420 × 70

### 4. `box / highlight — confirmation gate or caution`
- **언제 쓰나**: 확인 게이트, 더블 청구 방지, 동시 예약 차단, 활성화 거부 같은 *인지적 stop 신호*
- **fill**: `color.highlight.fill-tint` (`#fef5e7`)
- **stroke**: `color.highlight.border` (`#d97706`) · `strokeWidth.default`
- **borderRadius**: `borderRadius.default`
- **font**: `fontFamily.default` · `fontSize.note` (10) · italic · color `color.highlight.text-strong` (`#7a4a1c`)
- **default size**: 가변 width × 36 px (한 줄 권장)
- **icon prefix (optional)**: `✓` (확인 게이트) 또는 `⚠` (주의)

### 5. `box / external-service — Gmail / Calendar / SMS`
- **언제 쓰나**: 마스터 도식의 오른쪽 외부 서비스 목록
- **fill**: `color.external.fill-tint`
- **stroke**: `color.external.border` · `strokeWidth.default`
- **borderRadius**: `borderRadius.default`
- **font**: `fontFamily.default` · `fontSize.box-label` (13) · `fontWeight.regular`
- **default size**: 280 × 70

### 6. `box / future — unimplemented / future-plan`
- **언제 쓰나**: 외부 미러 미완 부분, 자연어 조회 미래 계획 등
- **fill**: white
- **stroke**: `color.neutral.border-soft` (`#999`) · `strokeWidth.default` · **dashed**
- **borderRadius**: `borderRadius.default`
- **font**: `fontFamily.default` · italic · color `color.neutral.text-soft` (`#777`)
- **default size**: 가변
- **variants**: `accent-strip` 상단 strip 도 `#999` + 점선

### 7. `box / user-actor — participant / researcher / admin`
- **언제 쓰나**: 마스터 도식 왼쪽 사용자 actor
- **fill**: white
- **stroke**: `color.neutral.border` (`#555`) · `strokeWidth.default`
- **borderRadius**: `borderRadius.default`
- **font**: `fontFamily.default` · `fontSize.box-label` (14) · `fontWeight.bold`
- **default size**: 200 × 70

---

## 보조 element (3 종)

### 8. `shape / storage-cylinder — attachment vault`
- **언제 쓰나**: 첨부 보관소 (서명·통장 사본 파일이 들어있음을 시각적으로 표현)
- **shape**: cylinder3 (drawio 의 `shape=cylinder3` 와 동일한 metaphor)
- **fill**: `color.external.fill-tint`
- **stroke**: `color.external.border` · `strokeWidth.default`
- **font**: `fontSize.box-label` (12)
- **default size**: 540 × 60

### 9. `bar / accent-strip — category color stripe`
- **언제 쓰나**: 모든 도식 상단 8 px strip — 카테고리 식별용
- **shape**: rectangle, full page width
- **fill**: 카테고리 색 (시스템 = `color.system.border` 진청; 미래 = `color.neutral.border-soft` 회색)
- **stroke**: none
- **height**: `page.accent-strip-height` (8 px)

### 10. `text / section-header — region label`
- **언제 쓰나**: 한 도식 안에서 영역 라벨 ("행동" / "데이터베이스" / "결과")
- **font**: `fontFamily.default` · `fontSize.section-header` (14) · `fontWeight.bold` · color 는 카테고리 별 (시스템 영역 = 파랑, 외부 영역 = 황색, 운영 영역 = 회색)

---

## 화살표 component (4 종)

### 11. `arrow / system-thin — data read/write`
- **stroke**: `color.system.border` · `strokeWidth.default` (2 px)
- **endArrow**: `classicThin` · solid · endFill
- **언제 쓰나**: 행동 → 데이터, 데이터 → 결과 같은 일반 연결

### 12. `arrow / system-bold — primary relationship`
- **stroke**: `color.system.border` · `strokeWidth.bold` (3 px)
- **endArrow / startArrow**: 양쪽 `classicThin` · solid
- **언제 쓰나**: 핵심 anchor 관계 (experiments ↔ bookings, participants ↔ bookings)

### 13. `arrow / external-thin — external send`
- **stroke**: `color.external.border` · `strokeWidth.default`
- **endArrow**: `classicThin` · solid
- **언제 쓰나**: 데이터 → 외부 서비스 발송 (이메일·문자·캘린더)

### 14. `arrow / external-dashed — retry / weak relation`
- **stroke**: `color.external.border` · `strokeWidth.default` · **dashed**
- **endArrow**: `classicThin` · solid
- **언제 쓰나**: 자동 재시도, 범위 한정 관계 (예: labs → identity)

---

## Variant 정리 (한 component 안의 옵션)

| component | variant 축 | 옵션 |
|---|---|---|
| `box / action` | weight | regular · emphasized |
| `box / table` | highlight | normal · with-encryption-badge |
| `box / highlight` | icon | ✓ check · ⚠ caution · 텍스트만 |
| `arrow / *` | direction | one-way · two-way |

`box / future` 와 `accent-strip` 은 색만 회색 점선으로 바뀌므로 별도 variant
대신 component 가 분리되어 있는 게 더 명확합니다.

---

## 한 번에 만들어야 할까

전부 한꺼번에 만들 필요는 없습니다. **다음 순서대로 등록하면 도식 8장 중
첫 두 장을 옮기는 시점에 거의 다 등장합니다.**

1. accent-strip · section-header — 도식의 정체성
2. action · table · result — 워크플로 3 column
3. external-service · user-actor — 마스터 도식
4. highlight · future · storage-cylinder — 특수 상태
5. arrow 4 종 — 모든 연결선

도식 한 장을 Figma 로 옮길 때 등장하지 않는 component 는 그 시점에 만들지
말고, 실제 필요해질 때 등록하세요.
