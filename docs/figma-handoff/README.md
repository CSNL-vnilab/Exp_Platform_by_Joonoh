# Figma 핸드오프 — 연구자가 직접 확장·수정할 수 있는 아키텍처 다이어그램

이 폴더는 `docs/diagrams/postgres-architecture/` 의 8장 도식 (마스터 1장 +
세부 6장 + DB 구조 1장)을 **Figma 로 옮긴 뒤** 연구자들이 두 가지 방식으로
*살아 있는 문서* 처럼 유지하기 위한 안내서입니다.

- **수동 드래그·복제** — Figma 캔버스 위에서 박스를 옮기고, 새 박스를 만들고,
  화살표를 잇고, 텍스트를 고칩니다.
- **자연어 프롬프트** — Figma 의 AI plugin (Diagram · Magician · FigJam AI
  등) 에 *"Booking 그림에 '대기열 확인' 박스를 왼쪽 두 번째에 추가"* 식으로
  요청해 component 를 자동으로 만들어 둡니다.

두 방식 다 작동하지만 **현 레포의 디자인 철학을 어기는 변경은 막아야**
다이어그램 묶음 전체의 가독성이 유지됩니다. 그 철학을 이 폴더가 명문화한
규약으로 옮긴 형태입니다.

---

## 1. 다섯 가지 디자인 원칙 (현 레포에서 적용된 그대로)

이 묶음은 다음 다섯 원칙을 따릅니다. Figma 에서 새로 만드는 박스·화살표도
같은 원칙 안에 있어야 합니다.

| # | 원칙 | 적용 |
|---|---|---|
| ① | **다섯 색만 사용** | 회색 (사람·일반) · 파랑 (시스템·데이터) · 황색 (외부 서비스·캐시) · 주황 (확인 게이트·주의) · 점선 회색 (미완·미래). 카테고리 외 색은 등장 금지. |
| ② | **평이한 명사구·약어 회피** | "RLS" → "사용자별 권한"; "FK" → "관계선"; "AES-256-GCM" → "암호화 저장"; "RPC" → "데이터베이스 함수". 버전 번호·라인 수·RPS 같은 내부 수치는 박스 안에 쓰지 않습니다. |
| ③ | **컴포넌트·화살표 최소화** | 한 장에 박스 15개·화살표 8개 이내가 목표. 같은 카테고리 박스를 단일 그룹 박스로 묶을 수 있으면 묶기. 압축이 가독성을 만듭니다. |
| ④ | **카테고리별 일관 layout** | 워크플로 도식은 "행동 ▶ 데이터 ▶ 결과" 3 column. ERD-축약본은 anchor 중심 방사형. layout 을 바꾸면 다이어그램 간 비교가 안 되니 같은 카테고리 안에서는 유지. |
| ⑤ | **상단 accent strip + 제목 + 부제** | 카테고리·문서 정체성이 한눈에 보이게. 본문 색은 통일하되 상단 8px strip 만 카테고리 색을 띤다. |

추가 안전장치 두 가지:

- **확인 게이트·주의는 주황 박스 + 이탤릭 작은 글씨** — 사용자의 인지적 stop
  신호. 본문 색과 섞이지 않도록.
- **미완·미래는 점선 회색** — 현재 동작과 명확히 구분.

---

## 2. 폴더 안 파일

| 파일 | 무엇 |
|---|---|
| [`design-tokens.json`](./design-tokens.json) | Tokens Studio for Figma 가 인식하는 색·폰트·간격·획 토큰. Figma 파일에 임포트하면 5색 팔레트가 Local Styles 로 박힙니다. |
| [`component-spec.md`](./component-spec.md) | Figma 에 미리 만들어 둘 master component 명세. 14 종 — 행동 박스 · 데이터 테이블 박스 · 결과 박스 · 강조 박스 · 외부 서비스 박스 · 미래 박스 · 첨부 보관소 실린더 · 액센트 strip · 화살표 4 종 등. 연구자가 새 component 를 만들 때 master 에서 instance 를 dragging 만 하면 5색 규약을 자동으로 따릅니다. |
| [`conversion-and-prompts.md`](./conversion-and-prompts.md) | drawio → SVG → Figma 변환 단계, 어느 plugin 이 어떤 역할을 하는지, AI plugin prompt 예시 패턴, DOs / DON'Ts catalog. |

---

## 3. 전체 흐름 (한 번만)

```
docs/diagrams/postgres-architecture/   ← 본 레포의 원본 (drawio 8장)
  ├─ 각 .drawio 파일을 SVG 로 내보냄
  └─ SVG 8장 준비

Figma  ← 새 파일 1개를 만들어 다음을 등록
  1. Tokens Studio plugin 으로 design-tokens.json 임포트  → 5색 Local Styles 박힘
  2. component-spec.md 따라 14종 master component 등록
  3. SVG 8장을 frame 단위로 import (SVG 의 <text> 는 Figma text 로 변환되어 편집 가능)
  4. import 된 박스를 master component 의 instance 로 replace (한 번에 5색 통일됨)
  5. 연구자에게 Edit 권한 공유
```

이 단계가 끝나면 다음 두 흐름이 동시에 가능합니다.

**연구자가 수동으로 새 그림 만들기**
1. 빈 frame 추가
2. 좌측 Assets 패널에서 master component 를 drag
3. 텍스트만 바꿈
4. 화살표는 plugin "Autoflow" 또는 native line tool

**연구자가 prompt 로 추가하기**
1. AI plugin 열기 (Diagram · FigJam AI · Magician)
2. *"③ 예약 그림에 '대기열 확인' 박스를 왼쪽 행동 열 두 번째에 추가"* 식으로 요청
3. plugin 이 생성한 박스를 master instance 로 replace 하면 5색 규약을 따름

---

## 4. 무엇이 깨지면 안 되는가

다이어그램 묶음을 *살아 있는 문서* 로 유지하려면 다음 다섯 가지가 깨지지
않아야 합니다.

1. **5색 외 색 등장** — 빨강 · 보라 · 청록 등이 박스나 화살표에 등장하면 통일성 상실
2. **약어·버전·수치 박스 안 등장** — "FK"·"v2.1"·"5 RPS" 같은 텍스트가 한 박스라도 들어가면 다른 박스의 평이함이 깨짐
3. **한 그림 안 박스 수 폭증** — 15 박스 / 8 화살표를 초과하면 카테고리를 분할하든가 그룹화
4. **상단 strip 색 흐트러짐** — 카테고리별로 정확히 한 색만, 변경 금지
5. **확인 게이트·주의를 일반 박스로 표시** — 주황 박스 + 이탤릭이 아니면 인지적 stop 신호가 사라짐

위 다섯 위반이 발견되면 그 변경은 되돌리거나 master component 로 환원합니다.

---

## 5. 더 큰 작업이 필요해지면

본 핸드오프는 **기존 plugin 조합** (옵션 A) 입니다. 다음 단계가 필요해지면
별도 trade-off 결정이 필요합니다.

| 필요 신호 | 다음 단계 |
|---|---|
| 연구자가 같은 박스를 반복적으로 잘못 만든다 (5색 어김, 약어 사용) | 본 시스템 전용 *Custom Figma plugin* 으로 5색·약어 검사를 자동화 |
| 본 시스템의 DB schema 가 자주 바뀌어 다이어그램이 빨리 뒤처짐 | Schema → 다이어그램 자동 생성 (CLI + drawio export + Figma plugin) |
| 다른 연구실이 이 다이어그램 묶음을 자기 lab 으로 fork 해 운영하고 싶음 | 본 핸드오프를 lab-specific deployment config 와 분리 (별도 design-system repo) |

이런 신호가 보이지 않는 한 옵션 A 로 유지가 가장 효율적입니다.
