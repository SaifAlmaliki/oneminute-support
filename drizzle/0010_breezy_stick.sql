CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "knowledge_chunk" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"user_email" text NOT NULL,
	"chunk_index" text NOT NULL,
	"chunk_type" text NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"meta_data" text,
	"created_at" text DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "knowledge_source" ADD COLUMN "blob_url" text;--> statement-breakpoint
ALTER TABLE "knowledge_source" ADD COLUMN "blob_pathname" text;--> statement-breakpoint
ALTER TABLE "knowledge_source" ADD COLUMN "extraction_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_source" ADD COLUMN "extraction_error" text;--> statement-breakpoint
ALTER TABLE "knowledge_source" ADD COLUMN "chunk_count" text;--> statement-breakpoint
ALTER TABLE "knowledge_chunk" ADD CONSTRAINT "knowledge_chunk_source_id_knowledge_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_source" DROP COLUMN "content";
--> statement-breakpoint
ALTER TABLE "knowledge_chunk"
  ADD COLUMN "fts" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', "content")) STORED;
--> statement-breakpoint
CREATE INDEX "knowledge_chunk_embedding_idx"
  ON "knowledge_chunk" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint
CREATE INDEX "knowledge_chunk_fts_idx"
  ON "knowledge_chunk" USING gin ("fts");
--> statement-breakpoint
CREATE INDEX "knowledge_chunk_source_idx" ON "knowledge_chunk" ("source_id");
--> statement-breakpoint
CREATE INDEX "knowledge_chunk_user_idx" ON "knowledge_chunk" ("user_email");
