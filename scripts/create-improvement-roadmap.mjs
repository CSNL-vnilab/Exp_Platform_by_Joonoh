#!/usr/bin/env node
// Create / replace the Notion Projects & Chores page with the 2026-04-24
// benchmark-driven improvement roadmap. Visual-hierarchy-focused layout:
// callouts per section · toggle groups to hide dense content · table
// blocks for gap analysis · to-do blocks for each recommendation.
//
// Idempotency: if an existing page with the same title prefix is found,
// it gets ARCHIVED first, then a fresh page is created. This lets the
// script double as "republish after edits."
//
// Run: `node scripts/create-improvement-roadmap.mjs`

import { readFile } from "node:fs/promises";

const envText = await readFile(".env.local", "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const NOTION_TOKEN = process.env.NOTION_API_KEY;
const PROJECTS_DB = "76e7c392-127e-47f3-8b7e-212610db9376";
const MEMBERS_DB = "94854705-c91d-4a35-a91e-803c5934745e";

async function notion(path, body, method = "POST") {
  const r = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const jbody = await r.json().catch(() => null);
  if (!r.ok) {
    throw new Error(
      `notion ${method} ${path} ${r.status}: ${JSON.stringify(jbody).slice(0, 500)}`,
    );
  }
  return jbody;
}

const TITLE = "📋 연구 플랫폼 개선 로드맵 — Notion · 연구 DB · 실험 전후 데이터 정리 (2026-04-24)";
const OLD_TITLE_PREFIX = "[로드맵] Notion UX";

// ── idempotency: archive any prior roadmap pages (old or new title) ──
async function findExisting(prefix) {
  const res = await notion(`/databases/${PROJECTS_DB}/query`, {
    filter: { property: "항목명", title: { contains: prefix } },
    page_size: 5,
  });
  return res.results ?? [];
}
for (const p of [
  ...(await findExisting(TITLE.slice(0, 25))),
  ...(await findExisting(OLD_TITLE_PREFIX)),
]) {
  console.log(`Archiving existing: ${p.id}`);
  await notion(`/pages/${p.id}`, { archived: true }, "PATCH");
}

// ── Members 이름 lookup (title prop is 이름, not 항목명) ──
const members = await notion(`/databases/${MEMBERS_DB}/query`, {
  filter: { property: "이름", title: { equals: "JOP" } },
  page_size: 5,
});
const ownerPageId = members.results?.[0]?.id ?? null;

// ── block helpers ──
const rt = (content, opts = {}) => ({
  type: "text",
  text: { content },
  annotations: opts,
});
const rtBold = (content) => rt(content, { bold: true });
const rtCode = (content) => rt(content, { code: true });
const rtLink = (content, url) => ({
  type: "text",
  text: { content, link: { url } },
});
const p = (...rtArr) => ({
  object: "block",
  type: "paragraph",
  paragraph: {
    rich_text: rtArr.flat().map((x) => (typeof x === "string" ? rt(x) : x)),
  },
});
const h2 = (content) => ({
  object: "block",
  type: "heading_2",
  heading_2: { rich_text: [rt(content)] },
});
const h3 = (content) => ({
  object: "block",
  type: "heading_3",
  heading_3: { rich_text: [rt(content)] },
});
const bullet = (...rtArr) => ({
  object: "block",
  type: "bulleted_list_item",
  bulleted_list_item: {
    rich_text: rtArr.flat().map((x) => (typeof x === "string" ? rt(x) : x)),
  },
});
const todo = (content, children = []) => ({
  object: "block",
  type: "to_do",
  to_do: {
    rich_text: [rt(content)],
    checked: false,
    children: children.length > 0 ? children : undefined,
  },
});
const callout = (content, emoji = "💡", color = "gray_background") => ({
  object: "block",
  type: "callout",
  callout: {
    icon: { type: "emoji", emoji },
    rich_text: [rt(content)],
    color,
  },
});
const toggle = (content, children = []) => ({
  object: "block",
  type: "toggle",
  toggle: {
    rich_text: [rt(content)],
    children,
  },
});
const divider = () => ({ object: "block", type: "divider", divider: {} });
const quote = (content) => ({
  object: "block",
  type: "quote",
  quote: { rich_text: [rt(content)] },
});

// Table — Notion API expects a table block with children of type table_row.
function table(headers, rows) {
  const rowBlock = (cells) => ({
    object: "block",
    type: "table_row",
    table_row: {
      cells: cells.map((c) =>
        typeof c === "string" ? [rt(c)] : c.map((x) => (typeof x === "string" ? rt(x) : x)),
      ),
    },
  });
  return {
    object: "block",
    type: "table",
    table: {
      table_width: headers.length,
      has_column_header: true,
      has_row_header: false,
      children: [rowBlock(headers), ...rows.map(rowBlock)],
    },
  };
}

// Column list for side-by-side current-vs-target.
function twoColumns(leftChildren, rightChildren) {
  return {
    object: "block",
    type: "column_list",
    column_list: {
      children: [
        { object: "block", type: "column", column: { children: leftChildren } },
        { object: "block", type: "column", column: { children: rightChildren } },
      ],
    },
  };
}

// ── content ──
const children = [
  callout(
    "2026-04-24 외부 벤치마크 + 내부 감사. P0 항목 4개만으로도 2년 뒤 재분석 가능한 수준의 재현성 확보. 연구자 확인 후 착수 순서 조정 권장.",
    "🎯",
    "blue_background",
  ),

  quote("Agent 가 자동 생성 · 재실행 시 동일 제목 페이지는 archive 후 새 페이지로 교체"),

  divider(),

  // ── Executive Summary ──
  h2("🧭 한눈에 보기"),
  twoColumns(
    [
      callout("현재 강점", "✅", "green_background"),
      bullet("예약 · 관찰 기록 · Notion 연동 자동화 축 견고"),
      bullet("세션 당 Notion 페이지 1:1 대응 유지"),
      bullet("참여자 class 자동 승급 / 블랙리스트"),
      bullet("Projects & Chores · Members · SLab 3-DB Relation 구조"),
      bullet("실험 활성화 게이트 (code_repo_url / data_path 강제)"),
    ],
    [
      callout("핵심 갭", "⚠️", "orange_background"),
      bullet("git commit SHA · env digest · container digest 미기록 (재실행 불가능)"),
      bullet("raw / derivatives 데이터 경로 분리 없음"),
      bullet("preregistration · IRB protocol ID 링크 없음"),
      bullet("제외 세션 flag · 사유 · data_quality 필드 없음"),
      bullet("BIDS / Psych-DS export 경로 없음"),
    ],
  ),

  divider(),

  // ── Audit ──
  h2("🔍 내부 감사"),
  toggle("Notion 구조 (3-DB Relation)", [
    bullet(
      rtBold("SLab DB"),
      " — 세션 한 행. 실험명 · 실험날짜 · 시간 · 프로젝트 · 버전넘버 · 피험자 ID · 회차 · 참여자 · ",
      rtCode("실험자 (Relation → Members)"),
      " · ",
      rtCode("공개 ID"),
      " · ",
      rtCode("프로젝트 (관련) (Relation → Projects)"),
      " · 상태 · Pre/Post-Survey · 특이사항 · Code/Data Directory · Parameter · Notes.",
    ),
    bullet(
      rtBold("Projects & Chores DB"),
      " — 프로젝트·업무 한 행. 항목명 · 분류 · 상태 · 기간 · 담당자 (Relation) · 우선순위 · 코드 디렉토리 · 참여자 수.",
    ),
    bullet(
      rtBold("CSNL Members DB"),
      " — 연구원 한 행. 이니셜을 타이틀로 사용 (JOP · BYL · SMJ · …).",
    ),
  ]),
  toggle("Supabase 측", [
    bullet(
      rtCode("experiments"),
      " · code_repo_url / data_path / pre_experiment_checklist / protocol_version / online_runtime_config / notion_project_page_id",
    ),
    bullet(
      rtCode("bookings · participants · booking_observations · participant_classes · participant_lab_identity"),
    ),
  ]),
  toggle("웹 UI 현황", [
    bullet(
      rtCode("/dashboard"),
      " — 기록이 누락된 실험 메타데이터 배너 · 오늘 처리할 일 7-tile 그리드",
    ),
    bullet(
      rtCode("/experiments/[id]"),
      " — 완성도 사이드바 · Notion Projects & Chores 연결 편집",
    ),
    bullet(rtCode("/schedule · /participants · /bookings"), " — 기본 테이블 뷰"),
  ]),

  divider(),

  // ── Benchmarks ──
  h2("🌐 외부 벤치마크"),
  callout(
    "표준 · 랩 · 실험 플랫폼 · 참여자 풀 4개 축. 자세한 참고 링크는 최하단 섹션 F.",
    "📚",
    "gray_background",
  ),
  toggle("표준 · 프레임워크", [
    bullet(rtBold("BIDS"), " — Poldrack 그룹 주도 신경영상 표준. sub-/ses-/ 디렉토리 + sidecar JSON 규약."),
    bullet(rtBold("Psych-DS"), " — 행동 과학 버전 BIDS. 2025-04 최신 spec. OSF · OpenNeuro 호환."),
    bullet(rtBold("NWB"), " — 전기생리 표준. Session-invariant vs session-varying 필드 구분."),
    bullet(rtBold("DataJoint"), " — 관계형 실험 파이프라인. Subject → Session → Recording → Preprocessing → Analysis 를 SQL 테이블 + FK 로 모델링."),
    bullet(rtBold("DataLad / git-annex"), " — 데이터 버전 관리. `datalad rerun <sha>` 가 재현성의 gold standard."),
    bullet(rtBold("ReproNim"), " — 컨테이너 + 스크립트 + 데이터 → 재실행 가능 체크리스트."),
    bullet(rtBold("OSF"), " — 프로젝트 단위 preregistration + DOI + GitHub/Dropbox 연동."),
    bullet(rtBold("FAIR / Turing Way / Cookiecutter Data Science"), " — 디렉토리 규약 · 메타데이터 · 재사용 가능한 데이터셋."),
  ]),
  toggle("공개 방법론을 문서화한 연구실", [
    bullet(
      rtBold("Poldrack Lab (Stanford)"),
      " — BIDS 저자. OpenNeuro 운영. ",
      rtLink("poldracklab.org", "https://www.poldracklab.org/"),
    ),
    bullet(
      rtBold("Saxe Lab (MIT)"),
      " — fMRI · 공개 파이프라인. ",
      rtLink("saxelab.mit.edu/resources", "https://saxelab.mit.edu/resources/"),
    ),
    bullet(
      rtBold("Niv Lab (Princeton)"),
      " — NivTurk 온라인 실험 플랫폼. ",
      rtLink("github.com/nivlab", "https://github.com/nivlab"),
    ),
    bullet(
      rtBold("Kording Lab (Penn)"),
      " — 오픈 퍼블리싱 · Neuromatch / C4R. ",
      rtLink("kordinglab.com", "https://kordinglab.com/resources/"),
    ),
  ]),
  toggle("실험 플랫폼 · 참여자 풀", [
    bullet(rtBold("jsPsych + Pavlovia"), " — 세션 단위 git commit 자동. `jsPsych.data.addProperties({git_commit: ...})` 관례."),
    bullet(rtBold("PsychoPy / Pavlovia"), " — `expInfo` dict + psydat/csv/log 트리오 자동 생성. PsychoPy 버전 자동 로그."),
    bullet(rtBold("Experiment Factory"), " — Poldrack/Sochat. Docker 이미지 + config.json 단위로 실험 배포."),
    bullet(rtBold("Sona Systems"), " — disqualifier-studies 필드 · 3-strike 자동 비활성 · 완료 기반 크레딧."),
    bullet(rtBold("Prolific"), " — 300+ prescreener. Peer et al. 2021: approval-rating 단독은 품질 약한 predictor — *사용 빈도 + 목적* 이 더 중요."),
  ]),

  divider(),

  // ── Gap analysis — table ──
  h2("📊 갭 분석"),
  callout("SLab 플랫폼 현재 상태 vs 표준 기대치 · 9개 영역", "🧩", "purple_background"),
  table(
    ["영역", "현재", "표준 기대", "갭"],
    [
      ["세션 메타", "date·time·sbj·round·참여자·실험자·notes", "BIDS/Psych-DS: duration·hw_id·room·stim_ver·instructions", "⚠️ 장비·환경 미기록"],
      ["코드 provenance", "code_repo_url · Code Dir", "ReproNim: git SHA · env hash · container digest", "❌ 2년 후 재실행 불가"],
      ["데이터 provenance", "data_path (단일)", "BIDS: raw · derivatives · checksum", "⚠️ raw/파생 구분 없음"],
      ["실험 전 체크", "Pre-Survey done/info", "IRB: 동의·장비 캘리·지급정보·금기·IRB 버전", "⚠️ 구조화 없음"],
      ["실험 후", "Post-Survey · Data Dir", "분석 노트북·제외 flag/사유·DOI·prereg", "❌ 핵심 3-4 필드 부재"],
      ["참여자 class", "auto 승급/블랙리스트", "Sona disqualifier · 근거 evidence 로그", "⚠️ evidence 비노출"],
      ["표준 호환", "없음", "BIDS/Psych-DS export", "❌ OpenNeuro/OSF 수동 포맷"],
      ["참여자 스키마", "name·phone·email·gender·birthdate", "BIDS: handedness·vision·L1 language", "⚠️ stratify 필드 부재"],
      ["감사 로그", "Notion row-history (coarse)", "ELN append-only 편집 로그", "⚠️ 해상도 부족"],
    ],
  ),

  divider(),

  // ── Recommendations ──
  h2("🛠️ 개선 제안"),

  callout("각 항목은 to-do 블록 — Notion 에서 직접 체크 처리 가능.", "☑️", "gray_background"),

  h3("P0 · 재현성 최소 확보 (즉시 · 1-2주)"),
  todo("C1 · git_sha / env_lockfile_hash / container_image_digest 를 bookings 에 기록 — /run 셸과 PsychoPy expInfo 가 세션 시작 시 자동 기록"),
  todo("C2 · data_path → raw_data_path / derivatives_path / analysis_notebook_url / figures_path 분리. 'raw 있고 derivatives 없음 N일' dashboard 배너"),
  todo("C3 · Projects DB 에 preregistration_url / irb_protocol_id / irb_version 컬럼. 실험 → 프로젝트 Relation 타고 세션 행 자동 노출"),
  todo("C4 · bookings 에 exclusion_flag / exclusion_reason / data_quality (good/flag/exclude) — 분석 단계 제외 세션 구분 가능"),

  h3("P1 · 표준 호환 (2-4주)"),
  todo("C5 · 프로젝트 단위 Psych-DS JSON sidecar export. dataset_description.json + participants.tsv + sessions.tsv 생성 → OSF/OpenNeuro 즉시 공유 가능"),
  todo("C6 · pre_experiment_checklist 구조화: consent_signed_at · irb_protocol_verified · eligibility_confirmed · equipment_calibrated · payment_info_collected · contraindications_checked · attention_check_pretest_passed"),
  todo("C7 · 상태=완료 전 필수 필드: actual_duration_min · exit_questionnaire_complete · researcher_notes 비어 있지 않음 · data_file_count > 0 · raw 또는 derivatives 중 하나"),
  todo("C8 · 예약 UI 에 교차 연구 제외 사유 표시 (이미 book_slot RPC 에 규칙 존재; UI 에만 공개)"),
  todo("C9 · 세션 행에 device_id / room_id / stimulus_set_version — 장비 교체 · 룸 이동 · 자극 세트 버전 변경 추적"),
  todo("C10 · participants 에 handedness / vision_correction / native_language"),

  h3("P2 · 워크플로 다듬기 (배경 작업)"),
  todo("C11 · bookings / experiments 감사 로그 테이블 (append-only): {field, old, new, who, when}"),
  todo("C12 · Notion vs native 결정 규칙 문서화 — Notion: 특이사항/wiki/프로토콜/회의록, Native: 검증·cross-row·감사·export"),
  todo("C13 · Reanalysis-readiness 0~100 점수 (git SHA · env · raw · derivatives · exclusion · prereg · DOI 가중). /experiments + /dashboard 에 도넛 차트"),
  todo("C14 · 실험별 osf_project_url / datalad_dataset_id / openneuro_accession / publication_doi — 세션→아카이브→논문 루프 닫기"),
  todo("C15 · 세션 완료 시 QC 자동 기록: attention_check_pass_rate · total_response_time_s · bot_screener_result → 저품질은 data_quality=flag 로 자동 이관"),
  todo("C16 · participant_class 전환 evidence 로그 (세션 수 · on-time 비율 · attention 통과율 · researcher 평가)"),

  divider(),

  // ── Sprint roadmap ──
  h2("📅 구현 로드맵"),
  callout("총 5 스프린트 · 약 6주. P0 완료 후 P1 병렬, P2 는 배경.", "🗺️", "blue_background"),
  table(
    ["스프린트", "기간", "범위", "산출물"],
    [
      ["Sprint A", "1-2주", "P0 재현성", "migration: bookings git/env/container · exclusion · data_quality · /run 환경 캡처 훅 · data_path 4-필드 확장"],
      ["Sprint B", "1주", "IRB / prereg", "Projects DB preregistration_url / irb_protocol_id / irb_version · experiment-form UI · SLab 자동 복사"],
      ["Sprint C", "2주", "표준 export", "scripts/export-psych-ds.mjs · /experiments/[id] Download 버튼"],
      ["Sprint D", "1주", "체크리스트 + 감사", "pre_experiment_checklist JSON schema · bookings_audit 테이블 + trigger"],
      ["Sprint E", "1주", "QC + Readiness", "attention-check 집계 자동 · /dashboard reanalysis-readiness 도넛"],
    ],
  ),

  divider(),

  // ── References ──
  h2("🔗 참고 링크"),
  toggle("표준 · 프레임워크", [
    bullet(rtLink("BIDS", "https://bids.neuroimaging.io/")),
    bullet(rtLink("Psych-DS", "https://psych-ds.github.io/")),
    bullet(rtLink("NWB", "https://nwb.org/")),
    bullet(rtLink("DataLad", "https://www.datalad.org/"), " · ", rtLink("Handbook", "https://handbook.datalad.org/")),
    bullet(rtLink("DataJoint", "https://www.datajoint.com/")),
    bullet(rtLink("ReproNim", "https://repronim.org/")),
    bullet(rtLink("OSF Preregistration", "https://help.osf.io/article/330-welcome-to-registrations")),
    bullet(rtLink("FAIR Principles", "https://www.go-fair.org/fair-principles/")),
    bullet(rtLink("The Turing Way", "https://book.the-turing-way.org/")),
    bullet(rtLink("Cookiecutter Data Science", "https://cookiecutter-data-science.drivendata.org/")),
  ]),
  toggle("랩 & 플랫폼", [
    bullet(rtLink("Poldrack Lab", "https://www.poldracklab.org/")),
    bullet(rtLink("Niv Lab", "https://nivlab.princeton.edu/")),
    bullet(rtLink("Saxe Lab Resources", "https://saxelab.mit.edu/resources/")),
    bullet(rtLink("Kording Lab Resources", "https://kordinglab.com/resources/")),
    bullet(rtLink("jsPsych + Pavlovia", "https://pavlovia.org/docs/experiments/overview")),
    bullet(rtLink("Sona Systems", "https://www.sona-systems.com/")),
    bullet(
      rtLink(
        "Prolific Data Quality Report",
        "https://www.prolific.com/resources/data-quality-of-platforms-and-panels-for-online-behavioral-research",
      ),
    ),
  ]),

  divider(),

  callout(
    "Agent 핸드오프 요약: repo 최상위 docs/improvement-roadmap.md. 체크박스 상태는 이 Notion 페이지에서 체크하시면 됩니다.",
    "🤝",
    "green_background",
  ),
];

// ── properties ──
const properties = {
  항목명: { title: [{ text: { content: TITLE } }] },
  분류: { select: { name: "Lab Chore" } },
  상태: { status: { name: "Not Started" } },
  우선순위: { select: { name: "P1" } },
};
if (ownerPageId) {
  properties["담당자"] = { relation: [{ id: ownerPageId }] };
}

console.log(`Creating page: ${TITLE}`);
console.log(`  owner=${ownerPageId?.slice(0, 8) ?? "(unlinked)"}`);
console.log(`  ${children.length} blocks (top-level)`);

const page = await notion("/pages", {
  parent: { database_id: PROJECTS_DB },
  properties,
  children,
});
console.log(`✓ Created ${page.id}`);
console.log(`  URL: ${page.url}`);
