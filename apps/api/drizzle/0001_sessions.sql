CREATE TABLE "session_commands" (
	"session_id" uuid NOT NULL,
	"command_id" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"type" text NOT NULL,
	"first_seq" integer NOT NULL,
	"last_seq" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_commands_session_id_command_id_pk" PRIMARY KEY("session_id","command_id")
);
--> statement-breakpoint
CREATE TABLE "session_events" (
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_events_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
CREATE TABLE "session_snapshots" (
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"state_json" jsonb NOT NULL,
	CONSTRAINT "session_snapshots_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_id" uuid,
	"owner_id" uuid NOT NULL,
	"scenario_id" text NOT NULL,
	"seed_hash" text NOT NULL,
	"seed" text NOT NULL,
	"seq" integer NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"ended_reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "session_commands" ADD CONSTRAINT "session_commands_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_snapshots" ADD CONSTRAINT "session_snapshots_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_owner_state_idx" ON "sessions" USING btree ("owner_id","state");