# adv-review — 로컬 Ollama 기반 적대적 풀스택 심사위원

로컬 `qwen3.6:latest` (36B MoE) 한 대를 **앱 전반(아키텍처·DB·예약·UI/UX·운영)** 에 대한
적대적 심사위원으로 쓰는 하네스다. 슬라이스를 순차적으로 보내고, 각 슬라이스에서
나온 JSON 이슈를 모아 최종 판결문까지 생성한다.

## 왜 슬라이스 방식인가

- qwen3.6은 최대 262K 컨텍스트를 지원하지만, 실사용에서는 VRAM/지연이 빠르게 불어난다.
- 대신 `num_ctx=32768` + 입력 80K chars로 **보수적으로 묶고**, 도메인별로 11개 슬라이스를
  순차 실행해 **전 과정을 횡단**한다.
- 최종 판결은 슬라이스별 JSON 이슈만 소비하므로 슬라이스를 추가해도 컨텍스트가
  선형으로만 증가한다 (코드를 다시 넣지 않음).

## 구조

```
scripts/adv-review/
├── README.md            # 이 파일
├── run.mjs              # 오케스트레이터
├── briefing.md          # qwen에게 매번 전달되는 앱 목적·현황·범위
├── slices.mjs           # 도메인 슬라이스 정의 (11개)
├── personas/
│   ├── adversarial.md   # 슬라이스 심사위원 페르소나
│   └── synthesizer.md   # 최종 판결자 페르소나
├── presets/
│   ├── qwen36-review.json   # 슬라이스 심사 프리셋
│   └── qwen36-synth.json    # 최종 판결 프리셋
└── lib/
    ├── ollama.mjs       # 스트리밍 클라이언트
    ├── slicer.mjs       # 파일 묶음 패킹(head+tail 절단)
    └── report.mjs       # 결과 파싱·집계
```

## 실행

```bash
ollama serve &                                 # 아직이면
node scripts/adv-review/run.mjs --list         # 슬라이스 목록 확인
node scripts/adv-review/run.mjs                # 전체 실행 + 최종 판결
node scripts/adv-review/run.mjs --slice 02     # 예약 핵심만
node scripts/adv-review/run.mjs --skip-synth   # 슬라이스만
node scripts/adv-review/run.mjs --only-synth   # 이미 실행한 findings로 최종만
```

결과는 기본 `.adv-review/` 에 쌓인다:

- `README.md` — 인덱스
- `<slice-id>.md` — 슬라이스별 원본 qwen 응답
- `<slice-id>.findings.json` — 파싱된 JSON 이슈
- `all-findings.json` — 전체 이슈 집계
- `00-final-verdict.md` — 최종 판결문

## 환경 변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama 서버 |
| `ADV_MODEL` | 프리셋의 `model` | 모델 오버라이드 |
| `ADV_PRESET` | `presets/qwen36-review.json` | 슬라이스 심사 프리셋 |
| `ADV_SYNTH` | `presets/qwen36-synth.json` | 최종 판결 프리셋 |

## 페르소나·프리셋 교체

- 다른 모델로 돌리려면 `presets/*.json`에서 `model` 필드만 바꾸거나
  `ADV_MODEL=gemma4:31b node scripts/adv-review/run.mjs` 처럼 덮어쓴다.
- 페르소나를 덜 적대적으로 만들고 싶으면 `personas/adversarial.md`의 "금지 사항"·
  "기본 원칙" 섹션을 조정한다. 심사 범위를 바꾸려면 "심사 범위" 섹션을 고친다.
- 프리셋에서 `num_ctx`를 키우면 입력을 더 많이 먹일 수 있지만 VRAM·지연이 증가한다.
  `maxInputChars`는 num_ctx의 40~50% 정도로 유지하기를 권장.

## 슬라이스를 바꾸고 싶다면

`slices.mjs`에서 배열을 수정하면 된다. 각 슬라이스의 `focus` 배열은 qwen이 특별히
들여다볼 지점을 한국어로 지정한다.

## 컨텍스트 메모리 터지지 않는 이유

1. 프리셋이 `num_ctx=32768`로 잠겨 있음.
2. 슬라이서가 파일을 head 12K + tail 2K로 잘라 슬라이스 전체를 80K chars 이내로 맞춤.
3. 슬라이스는 순차 실행 → 이전 슬라이스의 코드가 다음 슬라이스에 섞이지 않음.
4. 최종 판결은 JSON 이슈만 받으므로 코드를 재투입하지 않음.
5. 이슈가 너무 많으면 synth 단계에서 LOW·OPEN을 자동으로 잘라 재압축.
