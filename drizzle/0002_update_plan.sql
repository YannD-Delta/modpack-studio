CREATE TABLE `update_plan_item` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`base_profile_id` integer NOT NULL,
	`other_profile_id` integer NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`action` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`base_profile_id`) REFERENCES `profile`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`other_profile_id`) REFERENCES `profile`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `update_plan_item_base_profile_id_other_profile_id_kind_key_unique` ON `update_plan_item` (`base_profile_id`,`other_profile_id`,`kind`,`key`);