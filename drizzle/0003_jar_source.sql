CREATE TABLE `jar_source` (
	`profile_id` integer NOT NULL,
	`file_name` text NOT NULL,
	`project_id` integer NOT NULL,
	`file_id` integer NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	PRIMARY KEY(`profile_id`, `file_name`),
	FOREIGN KEY (`profile_id`) REFERENCES `profile`(`id`) ON UPDATE no action ON DELETE no action
);
