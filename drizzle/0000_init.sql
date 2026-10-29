CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target` text,
	`detail` text
);
--> statement-breakpoint
CREATE TABLE `blacklist` (
	`mod_id` text NOT NULL,
	`origin` text NOT NULL,
	`valid_for` text,
	`reason` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`mod_id`, `origin`)
);
--> statement-breakpoint
CREATE TABLE `blob` (
	`sha256` text PRIMARY KEY NOT NULL,
	`size` integer NOT NULL,
	`refs` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`before` text,
	`after` text
);
--> statement-breakpoint
CREATE TABLE `jar` (
	`sha256` text PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`size` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jar_mod` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`jar_sha256` text NOT NULL,
	`profile_id` integer NOT NULL,
	`mod_id` text NOT NULL,
	`version` text NOT NULL,
	`declared_side` text DEFAULT 'unknown' NOT NULL,
	`is_jij` integer DEFAULT 0 NOT NULL,
	`parent_jar` text,
	`library_key` text,
	FOREIGN KEY (`jar_sha256`) REFERENCES `jar`(`sha256`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`) REFERENCES `profile`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `job` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`params` text DEFAULT 'null' NOT NULL,
	`status` text NOT NULL,
	`progress` real,
	`message` text,
	`lock_key` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mod_decision` (
	`mod_id` text NOT NULL,
	`kind` text NOT NULL,
	`side` text,
	`reason` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`mod_id`, `kind`)
);
--> statement-breakpoint
CREATE TABLE `pack_version` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pack` text NOT NULL,
	`version` text NOT NULL,
	`mc` text,
	`loader` text,
	`loader_version` text,
	`base_atm_version` text,
	`lmp_hotfix` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pack_version_pack_version_unique` ON `pack_version` (`pack`,`version`);--> statement-breakpoint
CREATE TABLE `profile` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pack_version_id` integer NOT NULL,
	`side` text NOT NULL,
	`state` text NOT NULL,
	`location_kind` text NOT NULL,
	`location` text NOT NULL,
	`captured_at` text,
	`manifest_hash` text,
	`immutable` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`pack_version_id`) REFERENCES `pack_version`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
