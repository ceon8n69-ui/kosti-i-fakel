CREATE TABLE "gold_ledger" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "gold_ledger_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"transaction_id" uuid NOT NULL,
	"account_type" text NOT NULL,
	"account_id" text NOT NULL,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"session_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "heroes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"class" text NOT NULL,
	"name" text NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"xp" integer DEFAULT 0 NOT NULL,
	"max_hp" integer NOT NULL,
	"stats" jsonb NOT NULL,
	"dice_json" jsonb NOT NULL,
	"scars_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"relics_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"consumables_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'alive' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "hero_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "heroes" ADD CONSTRAINT "heroes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gold_ledger_account_idx" ON "gold_ledger" USING btree ("account_type","account_id");--> statement-breakpoint
CREATE INDEX "heroes_user_idx" ON "heroes" USING btree ("user_id");