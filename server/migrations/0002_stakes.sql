ALTER TABLE chip_log ADD COLUMN ref TEXT;
CREATE UNIQUE INDEX chip_log_ref ON chip_log (player, ref) WHERE ref IS NOT NULL;
