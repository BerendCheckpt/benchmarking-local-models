-- One-off: add the created_at and token_limit columns and backfill existing rows.
-- Run once:
--   docker exec -i postgres psql -U n8n -d n8n -v ON_ERROR_STOP=1 < migrations/2026-10-30-created-at.sql
BEGIN;
ALTER TABLE benchmark_results.rsults ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE benchmark_results.rsults ADD COLUMN IF NOT EXISTS token_limit boolean NOT NULL DEFAULT false;
UPDATE benchmark_results.rsults SET token_limit = true WHERE error ILIKE '%output token maximum%';
UPDATE benchmark_results.rsults SET model = 'Qwen3.6:36B' WHERE model IS NULL;
UPDATE benchmark_results.rsults SET created_at = '2026-10-29 12:00 Europe/Amsterdam' WHERE model = 'Qwen3.8:27B';
UPDATE benchmark_results.rsults SET created_at = '2026-10-28 12:00 Europe/Amsterdam' WHERE model = 'Qwen3.6:36B';
COMMIT;
