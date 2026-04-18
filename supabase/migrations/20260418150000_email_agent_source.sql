-- Add 'email_agent' to the application_source enum so the Mastra HR agent
-- (alter5-org/mastra), which receives CVs by email at careers@alter-5.com,
-- can tag its uploads distinctly from admin_manual. Without this value the
-- enum insert from /api/admin/manual-upload would fail when called with
-- source='email_agent'.

alter type application_source add value if not exists 'email_agent';
