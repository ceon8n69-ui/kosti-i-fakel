CREATE TABLE "table_members" (
	"table_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"hero_id" uuid,
	"ready" integer DEFAULT 0 NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "table_members_table_id_user_id_pk" PRIMARY KEY("table_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by" uuid NOT NULL,
	"chat_id" bigint,
	"target_kind" text DEFAULT 'expedition' NOT NULL,
	"target" text NOT NULL,
	"mode" text DEFAULT 'live' NOT NULL,
	"dm_mode" text DEFAULT 'auto' NOT NULL,
	"turn_timer" integer NOT NULL,
	"status" text DEFAULT 'lobby' NOT NULL,
	"session_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "turn_timer_sec" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "turn_deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "table_members" ADD CONSTRAINT "table_members_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_members" ADD CONSTRAINT "table_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;