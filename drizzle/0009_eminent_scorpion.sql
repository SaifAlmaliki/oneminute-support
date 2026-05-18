ALTER TABLE "chatBotMetadata" ADD COLUMN "mode" text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "channel" text DEFAULT 'text' NOT NULL;