export const KST_TIMEZONE = "Asia/Seoul";

export const BOOKING_ERRORS = {
  EXPERIMENT_NOT_FOUND: "실험을 찾을 수 없습니다.",
  DUPLICATE_PARTICIPATION: "이미 해당 실험에 참여 신청하셨습니다.",
  SLOT_ALREADY_TAKEN: "선택하신 시간대가 이미 예약되었습니다. 다른 시간대를 선택해주세요.",
  SLOT_CONTENTION_RETRY: "다른 참여자가 동시에 예약 중입니다. 잠시 후 다시 시도해주세요.",
  WRONG_SESSION_COUNT: "필수 회차를 모두 선택해주세요.",
  PAST_SLOT: "이미 지난 시간대는 예약할 수 없습니다.",
  // Participant whose current class for the experiment's lab is 'blacklist'.
  // Deliberately vague — we do not reveal the blacklist label to participants.
  PARTICIPANT_BLACKLISTED:
    "현재 예약을 받을 수 없는 상태입니다. 담당 연구원에게 문의해 주세요.",
  // Researcher declared an exclusion list on this experiment's online
  // runtime config — participant has prior booking on one of those
  // experiments (cross-study exclusion). D9, migration 00045.
  EXPERIMENT_EXCLUDED:
    "이 실험은 연구자가 지정한 다른 연구에 이미 참여하신 분께는 열려 있지 않습니다.",
} as const;

export const BOOKING_RETRY = {
  MAX_ATTEMPTS: 3,
  BACKOFF_MS: 200,
} as const;

export const SESSION_DURATIONS = [
  { label: "30분", value: 30 },
  { label: "45분", value: 45 },
  { label: "60분 (1시간)", value: 60 },
  { label: "90분 (1시간 30분)", value: 90 },
  { label: "120분 (2시간)", value: 120 },
] as const;

export const GENDER_OPTIONS = [
  { label: "남성", value: "male" },
  { label: "여성", value: "female" },
  { label: "기타", value: "other" },
] as const;
