# 변환 절차 + AI prompt 패턴 + DOs / DON'Ts

이 문서는 다음 세 가지를 한 자리에 모았습니다.

1. drawio → Figma 변환 단계 (한 번만)
2. 연구자가 AI plugin 으로 다이어그램을 확장할 때 쓰는 prompt 패턴
3. 무엇이 OK 이고 무엇이 NG 인지의 한 페이지 catalog

---

## 1. drawio → Figma 변환 (한 번만)

### 1-가. SVG 로 내보내기

drawio 파일 한 장씩 SVG 로 내보냅니다. 두 가지 방법 중 편한 쪽:

**방법 A — drawio desktop 또는 [app.diagrams.net](https://app.diagrams.net)**

1. `.drawio` 파일 열기
2. `File → Export As → SVG…`
3. 옵션:
   - Zoom: 100% (드릴 다운하지 않음)
   - Border Width: 0
   - **Include a copy of my diagram**: 끄기 (Figma 에서는 vector 만 필요)
   - **Embed Images**: 켜기 (있으면)
   - **Embed Fonts**: 끄기 (Figma 가 Pretendard 시스템 폰트로 다시 매핑)
4. 8 장 모두 같은 옵션으로 export

**방법 B — CLI (선택, 자동화)**

drawio desktop 의 `--export` 옵션을 활용하거나 [drawio-export](https://www.npmjs.com/package/drawio-export) npm 패키지로 일괄 변환 가능. 8장 정도라면 GUI 가 더 빠릅니다.

### 1-나. Figma 파일 만들기

1. Figma 에서 새 파일 생성 — 이름 `lab-reservation architecture`
2. **Tokens Studio for Figma** plugin 설치 후 [`design-tokens.json`](./design-tokens.json) 임포트 → Local Variables 에 5색 + 폰트 + 간격 토큰이 박힘
3. [`component-spec.md`](./component-spec.md) 의 14 종 master component 등록
   - 처음 두 장 (마스터 + 실험등록) 만 옮겨도 component 가 거의 다 등장하므로 그때 등록해도 됩니다.

### 1-다. SVG 임포트

1. 새 Page 를 도식 한 장 단위로 만듦 (`00-master`, `01-experiment-registration` …)
2. 각 SVG 를 캔버스에 drag → 자동으로 vector group + text layer 로 변환
3. SVG 의 `<text>` 요소는 Figma text 가 되어 *편집 가능*
4. 박스·화살표는 vector path 로 들어옴 — 그대로 두면 5색 통일은 SVG 단계에서 이미 확보됨

### 1-라. (선택) Master component instance 로 replace

각 박스를 master component 의 instance 로 *replace* 하면 이후 5색 토큰을
한 번에 바꿀 수 있습니다. 단, 한 번에 다 할 필요 없음 — 처음 두 장만
해두고 나머지는 필요할 때 점진적으로.

---

## 2. AI plugin prompt 패턴

다음 두 plugin 중 하나를 사용 (둘 다 무료):

- **Diagram by Diagram** (figma.com/community/plugin/Diagram-AI)
- **Magician for Figma** (figma.com/community/plugin/843461159747178978)

### 2-가. 기본 prompt 패턴

```
[그림 번호 + 카테고리] 그림에 [무엇] 박스를 [어디에] 추가
```

예시:

- `③ 예약 그림에 "대기열 확인" 박스를 왼쪽 행동 열 두 번째에 추가`
- `④ 청구 그림에 "관리자 검토" 박스를 행동 열 맨 아래에 추가`
- `⑤ 운영 그림 B 절에 "탈퇴 신청" 박스를 행동 column 에 추가`

### 2-나. 카테고리 변경 prompt

```
이 박스를 [카테고리] 로 변경
```

카테고리는 5 종 — `시스템` · `외부 서비스` · `확인 게이트 · 주의` · `미래 ·
미완` · `사용자`. 예:

- `이 박스를 외부 서비스 카테고리로 변경` → 황색 fill·stroke 로 바뀜
- `이 박스를 확인 게이트 카테고리로 변경` → 주황 + 이탤릭 으로 바뀜
- `이 박스를 미래 카테고리로 변경` → 회색 점선

### 2-다. 화살표 추가 / 변경

```
[A] 와 [B] 사이에 [관계 유형] 화살표 추가
```

관계 유형 4 종 — `데이터 읽기·쓰기` · `핵심 관계` · `외부 발송` · `자동
재시도`. 예:

- `예약 행 박스와 캘린더 캐시 박스 사이에 데이터 읽기·쓰기 화살표 추가`
- `정기 작업과 발송 채널 사이에 자동 재시도 화살표 추가` (자동으로 황색
  점선이 됨)

### 2-라. 텍스트 평이화

가끔 plugin 이 만든 박스 텍스트에 약어가 들어옵니다. 그때:

```
이 박스 텍스트를 평이한 한국어로 다시 써줘. 약어 금지.
```

또는 직접 잘 알려진 약어 → 평이한 표현 대응:

| 약어·기술 용어 | 평이한 표현 |
|---|---|
| RLS | 사용자별 권한 |
| FK / foreign key | 관계선 |
| RPC | 데이터베이스 함수 |
| JWT | 인증 토큰 |
| HMAC | 변조 방지 해시 |
| AES-256-GCM | 암호화 저장 |
| advisory lock | 잠금 |
| jsonb | 구조화된 항목 |
| trigger | 자동 처리 |
| index | 빠른 조회를 위한 보조 |

---

## 3. DOs / DON'Ts catalog

### ✓ OK

- 새 박스를 만들 때 좌측 Assets 패널에서 master component 의 instance 를 drag
- 카테고리가 같은 박스를 같은 column / row 에 정렬 (행동 박스는 왼쪽 column 안에서만)
- 한 그림 안 박스 수가 12 ~ 14 개를 넘어가면 카테고리를 묶어서 그룹 박스로 표현
- 확인 게이트·주의는 주황 박스 + 이탤릭 + (선택) ✓/⚠ 아이콘
- 화살표 끝점은 박스의 *모서리 connection point* 에 snap

### ✗ NG (이 변경은 즉시 되돌릴 것)

- **5색 외 색 등장** — 빨강 / 보라 / 청록 / 형광색이 한 박스라도 등장하면 통일성이 깨짐
- **약어·버전·수치 박스 안 등장**
  - 안 됨: `RLS`, `v2.1`, `5 RPS`, `60일`, `최대 5회`
  - 됨: `사용자별 권한`, `현재 버전`, `한도가 있음`, `약 두 달`, `여러 번 시도`
- **상단 strip 색 흐트러짐** — 한 도식의 strip 색은 한 종류만. 색을 바꾸려면 도식의 카테고리 자체가 바뀐 것임
- **확인 게이트를 일반 박스로 표시** — 주황 / 이탤릭 이 아니면 인지적 stop 신호 사라짐
- **한 그림에 박스 15 + 화살표 8 초과** — 그림 분할 또는 그룹화
- **AI plugin 이 만든 결과를 검토 없이 그대로 두기** — plugin 은 5색 모름. 만들고 나면 카테고리 변경 prompt 로 환원해야 함

### ⚠ 주의

- master component 의 *override* 가 아닌 *detach* 를 하면 한 instance 가 5색 토큰 갱신에서 제외됨. 가능하면 detach 금지.
- 한 박스 안에 텍스트가 두 줄 이상 들어가면 폰트 크기를 줄이지 말고 박스 크기를 키울 것.
- 화살표가 박스 위를 가로지르면 layout 을 재배치 (화살표가 박스를 *덮으면* 가독성 급락).

---

## 4. 검수 체크리스트 (변경 후 commit 전에)

연구자가 다이어그램을 수정한 뒤 Figma 의 *Share → Get link* 로 변경본을
공유하기 전에 아래 5 항목 통과:

- [ ] 5색 외 색이 한 곳도 없음
- [ ] 약어 / 버전 번호 / 라인 수 / RPS 같은 수치 텍스트 없음
- [ ] 박스 수 ≤ 15, 화살표 수 ≤ 8 (또는 카테고리 그룹화로 압축)
- [ ] 확인 게이트·주의는 주황 + 이탤릭으로 명확히 구분
- [ ] 상단 strip 색이 한 종류만 (해당 카테고리 색)

5 항목 모두 통과하면 layer 정리 (사용 안 하는 hidden vector 삭제) 후 공유.

---

## 5. 도식별 카테고리 색 매핑 (참고)

| 도식 | 카테고리 색 (상단 strip) |
|---|---|
| 00 마스터 | `color.system.border` (파랑) |
| 01 실험등록 | `color.system.border` (파랑) |
| 02 모집 | `color.system.border` (파랑) |
| 03 예약 | `color.system.border` (파랑) |
| 04 청구 | `color.system.border` (파랑) |
| 05 운영 | `color.system.border` (파랑) |
| 06 자연어 조회 (미래) | `color.neutral.border-soft` (회색 — 미래·미완) |
| 07 DB 구조 (ERD) | `color.system.border` (파랑) |

01–05 가 모두 같은 파랑인 이유: **카테고리 색은 그림의 *역할*** (시스템
설명 도식 vs 미래 개념도) 을 의미하지, 1·2·3 순서 색이 아닙니다. 5색
제약을 지키려는 의도적 선택입니다.
