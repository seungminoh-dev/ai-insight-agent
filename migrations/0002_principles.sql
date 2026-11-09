-- 원칙 중심으로 바꾼다: 테마를 축 아래 묶고, 후보 검토 단계는 없앤다 (틀린 근거만 dismissed로 숨긴다)
ALTER TABLE themes ADD COLUMN axis TEXT;
UPDATE insights SET status = 'confirmed' WHERE status = 'candidate';
