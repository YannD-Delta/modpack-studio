-- The file name a profile really has for a jar (the same bytes can carry another name in another profile).
ALTER TABLE `jar_mod` ADD `file_name` text;--> statement-breakpoint
UPDATE `jar_mod` SET `file_name` = (SELECT `filename` FROM `jar` WHERE `jar`.`sha256` = `jar_mod`.`jar_sha256`);
