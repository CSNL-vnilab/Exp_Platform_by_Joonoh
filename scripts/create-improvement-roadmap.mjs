#!/usr/bin/env node
// One-off: create a Notion Projects & Chores page with the Notion UX +
// Research Project DB + pre/post-experiment data organization roadmap
// synthesized from the 2026-04-24 benchmark report.
//
// Page lives in the Projects & Chores DB as a Lab Chore with
// 담당자 = 박준오 (jy061100/JOP). Content is ~20 structured blocks.
//
// Run: `node scripts/create-improvement-roadmap.mjs`
// Idempotent via title match: re-running finds the existing page by
// title prefix and short-circuits (prints the URL).

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

const TITLE = "[로드맵] Notion UX · 연구 프로젝트 DB · 실험 전후 데이터 정리 개선안 (2026-04-24)";

// Idempotency: search Projects DB for an existing page with this title.
const existing = await notion(`/databases/${PROJECTS_DB}/query`, {
  filter: {
    property: "항목명",
    title: { contains: TITLE.slice(0, 40) },
  },
  page_size: 5,
});
if ((existing.results ?? []).length > 0) {
  console.log(
    "Page already exists, skipping:",
    existing.results[0].url ?? existing.results[0].id,
  );
  process.exit(0);
}

// Find 박준오's Members page_id (researcher whose initial is JOP).
// Members DB title property is "이름", not "항목명".
const members = await notion(`/databases/${MEMBERS_DB}/query`, {
  filter: { property: "이름", title: { equals: "JOP" } },
  page_size: 5,
});
const ownerPageId = members.results?.[0]?.id ?? null;

// ── helpers ──
const p = (text) => ({
  object: "block",
  type: "paragraph",
  paragraph: { rich_text: [{ type: "text", text: { content: text } }] },
});
const h1 = (text) => ({
  object: "block",
  type: "heading_1",
  heading_1: { rich_text: [{ type: "text", text: { content: text } }] },
});
const h2 = (text) => ({
  object: "block",
  type: "heading_2",
  heading_2: { rich_text: [{ type: "text", text: { content: text } }] },
});
const h3 = (text) => ({
  object: "block",
  type: "heading_3",
  heading_3: { rich_text: [{ type: "text", text: { content: text } }] },
});
const b = (text) => ({
  object: "block",
  type: "bulleted_list_item",
  bulleted_list_item: {
    rich_text: [{ type: "text", text: { content: text } }],
  },
});
const code = (text, lang = "plain text") => ({
  object: "block",
  type: "code",
  code: {
    language: lang,
    rich_text: [{ type: "text", text: { content: text } }],
  },
});
const callout = (text, emoji = "💡") => ({
  object: "block",
  type: "callout",
  callout: {
    icon: { type: "emoji", emoji },
    rich_text: [{ type: "text", text: { content: text } }],
  },
});
const divider = () => ({ object: "block", type: "divider", divider: {} });
const to_do = (text) => ({
  object: "block",
  type: "to_do",
  to_do: { rich_text: [{ type: "text", text: { content: text } }], checked: false },
});

const children = [
  callout(
    "2026-04-24 외부 벤치마크 + 내부 감사 기반. 연구자와의 협의 없이 agent가 자동 생성 — 착수 전 우선순위 / 범위 재확인 필요.",
    "📌",
  ),

  h2("요약"),
  p(
    "SLab 플랫폼은 예약 · 관찰 기록 · Notion 연동의 기본 축은 잘 갖춰져 있으나, 2년 뒤 재분석이 가능한 수준의 메타데이터(git commit, 환경 digest, raw/derivatives 분리, prereg 링크 등)는 수집하지 않음. BIDS / Psych-DS / DataLad / OSF 표준을 기준으로 보면 '공유 가능한 데이터셋'까지의 거리는 중간 정도. 아래 P0 항목만 완료해도 연구 기록의 재현성이 크게 올라가며, P1~P2 는 표준 호환성 + UX 다듬기.",
  ),

  h2("A. 현재 상태 (내부 감사)"),
  h3("Notion 구조"),
  b("SLab DB — 세션 한 행. 실험명/실험날짜/시간/프로젝트/버전넘버/피험자ID/회차/참여자/실험자(Relation)/공개ID/프로젝트(관련)/상태/Pre-Survey/Post-Survey/특이사항/Code Directory/Data Directory/Parameter/Notes."),
  b("Projects & Chores DB — 프로젝트·업무 한 행. 항목명/분류/상태/기간/담당자(Relation)/우선순위/코드 디렉토리/참여자 수."),
  b("CSNL Members DB — 연구원 한 행. 이니셜을 타이틀로 사용."),
  h3("Supabase 측"),
  b("experiments.code_repo_url / data_path / pre_experiment_checklist / protocol_version / online_runtime_config(counterbalance / attention_checks / screeners / exclude_experiment_ids) / notion_project_page_id"),
  b("bookings, participants, booking_observations, participant_classes(newbie/royal/vip/blacklist), participant_lab_identity(HMAC 가명)"),
  h3("웹 UI"),
  b("/dashboard — 기록이 누락된 실험 메타데이터 배너 + 오늘 처리할 일 7-tile 그리드"),
  b("/experiments/[id] — 완성도 사이드바 + Notion Projects & Chores 연결 편집"),
  b("/schedule, /participants, /bookings — 기본 테이블 뷰"),

  h2("B. 벤치마크 요약"),
  p(
    "표준: BIDS(신경영상) / Psych-DS(행동) / NWB(전기생리) / DataJoint(관계형 파이프라인) / DataLad+git-annex(데이터 버전 관리) / ReproNim / OSF / FAIR / The Turing Way / Cookiecutter Data Science.",
  ),
  p(
    "랩: Poldrack Lab(Stanford, BIDS 주도) · Saxe Lab(MIT, OpenNeuro 공개) · Niv Lab(Princeton, NivTurk) · Kording Lab(Penn).",
  ),
  p(
    "실험 플랫폼: jsPsych+Pavlovia(자동 git commit) · PsychoPy(psydat/csv/log 트리오) · Experiment Factory(Docker 컨테이너 단위).",
  ),
  p(
    "참여자 풀: Sona Systems(disqualifier-studies, 3-strike 자동 비활성) · Prolific(reputation filter).",
  ),

  h2("C. 갭 분석"),
  b("세션 메타데이터 — duration / hardware_id / room_id / stimulus_set_version / instructions snapshot 부재."),
  b("코드 provenance — code_repo_url 은 있으나 git commit SHA, env lockfile hash, container digest 없음. 2년 후 재실행 불가."),
  b("데이터 provenance — data_path 단일. raw vs derivatives 분리 없음, checksum 없음."),
  b("실험 전 체크 — IRB protocol ID/version, 장비 캘리브레이션, 참여비 수금 상태, 금기사항 필드 부재."),
  b("실험 후 정리 — 분석 노트북 URL, 제외 플래그, 제외 사유, publication DOI, preregistration 링크 부재."),
  b("참여자 class — 자동 승급/블랙리스트는 있으나 class 전환의 근거 evidence 로그(on-time rate, attention-check 통과율) 미기록."),
  b("표준 호환 — BIDS / Psych-DS export 경로 없음. OSF/OpenNeuro 공유 시 수동 재포맷 필요."),
  b("참여자 스키마 — handedness / 시력교정 / 모국어 미기록."),
  b("감사 로그 — 세션 행의 이력(누가 언제 실험자 Relation 을 바꿨나) 없음."),

  h2("D. 개선 제안"),
  h3("P0 — 재현성 최소 확보"),
  to_do(
    "C1 · experiments 또는 bookings 에 experiment_git_sha / env_lockfile_hash / container_image_digest 컬럼 추가. /run 셸과 PsychoPy expInfo 가 세션 시작 시점에 자동 기록.",
  ),
  to_do(
    "C2 · data_path 를 raw_data_path / derivatives_path / analysis_notebook_url / figures_path 로 분리. Dashboard 에 'raw 있고 derivatives 비어 있음 N일 경과' 배너.",
  ),
  to_do(
    "C3 · Projects DB 에 preregistration_url / irb_protocol_id / irb_version 컬럼 추가. 실험 → 프로젝트 Relation 을 타고 세션 행에 자동 노출.",
  ),
  to_do(
    "C4 · bookings 에 exclusion_flag / exclusion_reason / data_quality(good/flag/exclude) 추가. 필수 필드가 아니면 분석 단계에서 제외 세션을 구분 불가.",
  ),

  h3("P1 — 표준 호환"),
  to_do(
    "C5 · 프로젝트 단위 Psych-DS JSON sidecar export 버튼. dataset_description.json + participants.tsv + sessions.tsv 생성 → OSF/OpenNeuro 공유 즉시 가능.",
  ),
  to_do(
    "C6 · pre_experiment_checklist 를 구조화: consent_signed_at(타임스탬프 + 문서 URL), irb_protocol_verified, eligibility_confirmed(스크리너 버전), equipment_calibrated(eye-tracker/monitor/audio/EEG), payment_info_collected, contraindications_checked, attention_check_pretest_passed. 상태=완료 전 dashboard gate.",
  ),
  to_do(
    "C7 · 상태=완료 전 필수 필드: actual_duration_min, participant_exit_questionnaire_complete, researcher_notes 비어 있지 않음, data_file_count > 0, raw_data_path 또는 derivatives_path 중 최소 하나.",
  ),
  to_do(
    "C8 · 예약 UI 에서 교차 연구 제외 발동 시 사유 표시 ('participant 가 2026-02-03 에 실험 X 완료 · 본 실험 Y 는 X 참여자 제외'). 현재 book_slot RPC 에 규칙만 있고 UI 공개 없음.",
  ),
  to_do(
    "C9 · 세션 행에 device_id / room_id / stimulus_set_version 추가. 장비 교체·룸 이동·자극 세트 버전 변경이 재현성에 치명적.",
  ),
  to_do(
    "C10 · participants 스키마에 handedness / vision_correction / native_language 컬럼. 행동 연구는 이 변수들로 자주 stratify 함.",
  ),

  h3("P2 — 워크플로 다듬기"),
  to_do(
    "C11 · bookings / experiments 행 감사 로그 테이블 (append-only): {field, old, new, who, when}. Notion row-history 는 해상도 부족.",
  ),
  to_do(
    "C12 · Notion vs native 결정 규칙 문서화. Notion: 특이사항 자유 텍스트/프로젝트 wiki/프로토콜 PDF/회의록/랩 chore. Native: 검증 필요한 데이터/cross-row 제약/감사 로그/계산 필드/BIDS export.",
  ),
  to_do(
    "C13 · 'Reanalysis-readiness' 0~100 점수. commit SHA / env / raw / derivatives / exclusion 로그 / prereg / DOI 항목 가중. /experiments detail + /dashboard 에 표시.",
  ),
  to_do(
    "C14 · 실험별 osf_project_url / datalad_dataset_id / openneuro_accession / publication_doi. 세션 → 아카이브 → 논문 루프 닫기.",
  ),
  to_do(
    "C15 · 세션 완료 시점 QC 메트릭 자동 기록: attention_check_pass_rate / total_response_time_s / bot_screener_result. 저품질 세션 자동 data_quality=flag.",
  ),
  to_do(
    "C16 · participant_class 전환 evidence 로그: 단순 '승급'이 아니라 근거(세션 수, on-time 비율, attention 통과율, researcher 평가)까지 audit 에 남김.",
  ),

  h2("E. 구현 로드맵 (스프린트 단위)"),
  h3("Sprint A · P0 재현성 (1-2 주)"),
  b("migration: bookings.git_sha / env_digest / container_digest, bookings.exclusion_flag / reason / data_quality"),
  b("/run 셸에 환경 캡처 훅 추가, PsychoPy expInfo 템플릿 업데이트 가이드"),
  b("experiments.data_path 를 4-필드로 확장하고 기존 데이터 마이그레이션"),
  h3("Sprint B · IRB / prereg (1 주)"),
  b("Projects DB preregistration_url / irb_protocol_id / irb_version 스키마 확장"),
  b("experiment-form.tsx 에 입력 UI 추가, SLab DB 에 읽어오기"),
  h3("Sprint C · 표준 export (2 주)"),
  b("scripts/export-psych-ds.mjs — 프로젝트 지정 시 dataset_description.json + participants.tsv + sessions.tsv 생성"),
  b("UI: /experiments/[id] 에 Download Psych-DS 버튼"),
  h3("Sprint D · 체크리스트 + 감사 (1 주)"),
  b("pre_experiment_checklist 를 JSON schema 로 구조화"),
  b("bookings_audit 테이블 + trigger (append-only)"),
  h3("Sprint E · QC + Readiness score (1 주)"),
  b("Online 실험의 attention_check_pass_rate 집계 자동화"),
  b("/dashboard 에 'reanalysis-readiness' 도넛 차트"),

  h2("F. 참고 링크"),
  b("BIDS · https://bids.neuroimaging.io/"),
  b("Psych-DS · https://psych-ds.github.io/"),
  b("NWB · https://nwb.org/"),
  b("DataLad · https://www.datalad.org/ · 핸드북 https://handbook.datalad.org/"),
  b("DataJoint · https://www.datajoint.com/"),
  b("ReproNim · https://repronim.org/"),
  b("OSF Preregistration · https://help.osf.io/article/330-welcome-to-registrations"),
  b("FAIR Principles · https://www.go-fair.org/fair-principles/"),
  b("The Turing Way · https://book.the-turing-way.org/"),
  b("Cookiecutter Data Science · https://cookiecutter-data-science.drivendata.org/"),
  b("Poldrack Lab · https://www.poldracklab.org/"),
  b("Niv Lab · https://nivlab.princeton.edu/"),
  b("Saxe Lab · https://saxelab.mit.edu/resources/"),
  b("jsPsych + Pavlovia · https://pavlovia.org/docs/experiments/overview"),
  b("Sona Disqualifier-Studies · https://www.sona-systems.com/"),
  b("Prolific data quality · https://www.prolific.com/resources/data-quality-of-platforms-and-panels-for-online-behavioral-research"),

  divider(),
  callout(
    "갱신 방법: scripts/create-improvement-roadmap.mjs 가 동일 제목의 기존 페이지를 감지하면 재실행 시 no-op. 제목 변경 또는 기존 페이지 삭제 후 재실행으로 새 버전 생성.",
    "🔁",
  ),
];

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
console.log(`  ${children.length} blocks`);

// Notion API allows up to 100 children in a single create; we have ~60, fine.
const page = await notion("/pages", {
  parent: { database_id: PROJECTS_DB },
  properties,
  children,
});
console.log(`✓ Created ${page.id}`);
console.log(`  URL: ${page.url}`);
