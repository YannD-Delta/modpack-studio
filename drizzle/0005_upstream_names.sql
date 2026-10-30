-- Neutral names: the followed pack is "upstream" and the user's pack is "own" in columns and stored values.
ALTER TABLE `pack_version` RENAME COLUMN `base_atm_version` TO `base_upstream_version`;--> statement-breakpoint
ALTER TABLE `pack_version` RENAME COLUMN `lmp_hotfix` TO `own_hotfix`;--> statement-breakpoint
UPDATE `blacklist` SET `origin` = 'upstream_derived' WHERE `origin` = 'atm_derived';
