CREATE TABLE `project_choice` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`new_clean_id` integer NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`choice` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_choice_project_id_new_clean_id_kind_key_unique` ON `project_choice` (`project_id`,`new_clean_id`,`kind`,`key`);