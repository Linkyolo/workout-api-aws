CREATE TYPE "public"."category" AS ENUM('strength', 'calisthenics', 'sports');--> statement-breakpoint
CREATE TYPE "public"."tracking_type" AS ENUM('strength', 'bodyweight', 'timed', 'running', 'freestyle', 'climbing');--> statement-breakpoint
CREATE TABLE "climbing_route" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workout_exercise_id" uuid NOT NULL,
	"difficulty" text NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exercise" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"category" "category" NOT NULL,
	"tracking_type" "tracking_type" NOT NULL,
	"muscle_group" text
);
--> statement-breakpoint
CREATE TABLE "exercise_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workout_exercise_id" uuid NOT NULL,
	"entry_number" integer NOT NULL,
	"reps" integer,
	"weight_kg" numeric(6, 2),
	"duration_secs" integer,
	"distance_km" numeric(7, 3)
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cognito_sub" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_cognito_sub_unique" UNIQUE("cognito_sub")
);
--> statement-breakpoint
CREATE TABLE "workout" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"performed_on" date NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workout_exercise" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workout_id" uuid NOT NULL,
	"exercise_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "workout_exercise_workout_id_exercise_id_unique" UNIQUE("workout_id","exercise_id")
);
--> statement-breakpoint
ALTER TABLE "climbing_route" ADD CONSTRAINT "climbing_route_workout_exercise_id_workout_exercise_id_fk" FOREIGN KEY ("workout_exercise_id") REFERENCES "public"."workout_exercise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercise_entry" ADD CONSTRAINT "exercise_entry_workout_exercise_id_workout_exercise_id_fk" FOREIGN KEY ("workout_exercise_id") REFERENCES "public"."workout_exercise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout" ADD CONSTRAINT "workout_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_exercise" ADD CONSTRAINT "workout_exercise_workout_id_workout_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."workout"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_exercise" ADD CONSTRAINT "workout_exercise_exercise_id_exercise_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercise"("id") ON DELETE no action ON UPDATE no action;