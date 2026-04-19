-- Persist the per-question anti-extraction counters that the interview UI
-- already tracks and submits. Until now only paste_count / tab_switches /
-- burst_count had storage, so copy/right-click/shortcut/drag attempts were
-- visible to the grader (via the summaryText `Señales:` line) but lost for
-- re-analysis or audit. Defaulting to 0 keeps existing rows queryable.

alter table interview_answers
  add column if not exists copy_blocked        integer not null default 0,
  add column if not exists right_click_blocked integer not null default 0,
  add column if not exists shortcut_blocked    integer not null default 0,
  add column if not exists drag_blocked        integer not null default 0;
