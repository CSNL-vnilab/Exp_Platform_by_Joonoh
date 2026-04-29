-- 정산 정보 입력 화면 (PaymentInfoForm) 보완: 참여자 본인이 결제 시점에
-- 이름·연락처·이메일을 확인하고 필요하면 정정할 수 있도록 한다. 이 값은
-- 행정 제출용 엑셀 (실험참여자비 양식) 의 성명/이메일 셀과 청구 ZIP 의
-- 통장사본 파일명에 그대로 흘러 들어가므로, 예약 당시의 participants 행과
-- 따로 스냅샷을 떠 두는 편이 안전하다.
--
-- 설계:
--
-- 1. participants 테이블을 직접 UPDATE 하지 않는다 — 같은 사람의 다른
--    예약/실험에 영향이 갈 수 있다. 결제 행에만 override 를 둔다.
-- 2. name_override / email_override 는 NULL 인 동안 participants.name /
--    participants.email 을 그대로 쓴다 (엑셀 빌더가 fallback 로직 적용).
-- 3. phone 은 기존에 어떤 컬럼에도 저장되지 않던 값이므로 override 가
--    아니라 단순 컬럼 'phone' 으로 추가한다. participants.phone 이 비어
--    있을 때를 위한 fallback 도 빌더에서 처리.
--
-- 컬럼은 모두 nullable — 기존 행의 backfill 비용을 0 으로 유지한다.

ALTER TABLE participant_payment_info
  ADD COLUMN IF NOT EXISTS name_override  text,
  ADD COLUMN IF NOT EXISTS email_override text,
  ADD COLUMN IF NOT EXISTS phone          text;

COMMENT ON COLUMN participant_payment_info.name_override IS
  '참여자가 정산 시점에 정정한 성명. NULL 이면 participants.name 사용.';
COMMENT ON COLUMN participant_payment_info.email_override IS
  '참여자가 정산 시점에 정정한 이메일. NULL 이면 participants.email 사용.';
COMMENT ON COLUMN participant_payment_info.phone IS
  '참여자 연락처 (행정 제출용). participants.phone 의 스냅샷 또는 정정값.';
