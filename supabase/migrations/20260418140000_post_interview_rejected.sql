-- Add post_interview_rejected status so admin can formally reject candidates
-- after they've completed the interview and receive a rejection email.
-- Previously there was no transition out of 'interview_completed' for
-- candidates we decide not to hire — they stayed in-flight forever.

alter type application_status add value if not exists 'post_interview_rejected';
