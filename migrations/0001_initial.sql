CREATE TABLE `activity` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_name` text NOT NULL,
	`action` text NOT NULL,
	`destination` text NOT NULL,
	`status` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_user_time` ON `activity` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`env_var` text NOT NULL,
	`encrypted_token` text NOT NULL,
	`allow_agent_use` integer DEFAULT false NOT NULL,
	`revision` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credentials_user_name` ON `credentials` (`user_id`,`name`);--> statement-breakpoint
CREATE TABLE `handoffs` (
	`hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`config` text NOT NULL,
	`purpose` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE INDEX `handoffs_expiry` ON `handoffs` (`expires_at`);
