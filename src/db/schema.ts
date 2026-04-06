import {
	pgTable,
	pgEnum,
	uuid,
	text,
	integer,
	numeric,
	date,
	boolean,
	timestamp,
	unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ── Enums ────────────────────────────────────────────────────────────────────

export const categoryEnum = pgEnum("category", [
	"strength",
	"calisthenics",
	"sports",
]);

export const trackingTypeEnum = pgEnum("tracking_type", [
	"strength",   // reps + weight  — bench press, pistol squat
	"bodyweight", // reps only      — push-ups, negative muscle-ups
	"timed",      // duration       — isometric holds, pigeon split
	"running",    // distance + duration
	"freestyle",  // duration only  — football freestyle
	"climbing",   // duration + routes
]);

// ── Tables ───────────────────────────────────────────────────────────────────

export const user = pgTable("user", {
	id: uuid("id").primaryKey().defaultRandom(),
	cognitoSub: text("cognito_sub").notNull().unique(),
	displayName: text("display_name"),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const exercise = pgTable("exercise", {
	id: uuid("id").primaryKey().defaultRandom(),
	name: text("name").notNull(),
	category: categoryEnum("category").notNull(),
	trackingType: trackingTypeEnum("tracking_type").notNull(),
	muscleGroup: text("muscle_group"),
});

export const workout = pgTable("workout", {
	id: uuid("id").primaryKey().defaultRandom(),
	userId: uuid("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
	name: text("name").notNull(),
	performedOn: date("performed_on", { mode: "date" }).notNull(),
	notes: text("notes"),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workoutExercise = pgTable("workout_exercise", {
	id: uuid("id").primaryKey().defaultRandom(),
	workoutId: uuid("workout_id").notNull().references(() => workout.id, { onDelete: "cascade" }),
	exerciseId: uuid("exercise_id").notNull().references(() => exercise.id),
	sortOrder: integer("sort_order").notNull().default(0),
}, (t) => ({
	uniquePerWorkout: unique().on(t.workoutId, t.exerciseId),
}));

export const exerciseEntry = pgTable("exercise_entry", {
	id: uuid("id").primaryKey().defaultRandom(),
	workoutExerciseId: uuid("workout_exercise_id").notNull().references(() => workoutExercise.id, { onDelete: "cascade" }),
	entryNumber: integer("entry_number").notNull(),
	reps: integer("reps"),
	weightKg: numeric("weight_kg", { precision: 6, scale: 2 }),
	durationSecs: integer("duration_secs"),
	distanceKm: numeric("distance_km", { precision: 7, scale: 3 }),
});

export const climbingRoute = pgTable("climbing_route", {
	id: uuid("id").primaryKey().defaultRandom(),
	workoutExerciseId: uuid("workout_exercise_id").notNull().references(() => workoutExercise.id, { onDelete: "cascade" }),
	difficulty: text("difficulty").notNull(),
	completed: boolean("completed").notNull().default(false),
	attempts: integer("attempts").notNull().default(1),
});

// ── Relations ────────────────────────────────────────────────────────────────
// Used by the relational query API (db.query.*). No effect on the DB schema.

export const userRelations = relations(user, ({ many }) => ({
	workouts: many(workout),
}));

export const workoutRelations = relations(workout, ({ one, many }) => ({
	user: one(user, { fields: [workout.userId], references: [user.id] }),
	workoutExercises: many(workoutExercise),
}));

export const workoutExerciseRelations = relations(workoutExercise, ({ one, many }) => ({
	workout: one(workout, { fields: [workoutExercise.workoutId], references: [workout.id] }),
	exercise: one(exercise, { fields: [workoutExercise.exerciseId], references: [exercise.id] }),
	entries: many(exerciseEntry),
	climbingRoutes: many(climbingRoute),
}));

export const exerciseEntryRelations = relations(exerciseEntry, ({ one }) => ({
	workoutExercise: one(workoutExercise, {
		fields: [exerciseEntry.workoutExerciseId],
		references: [workoutExercise.id],
	}),
}));

export const climbingRouteRelations = relations(climbingRoute, ({ one }) => ({
	workoutExercise: one(workoutExercise, {
		fields: [climbingRoute.workoutExerciseId],
		references: [workoutExercise.id],
	}),
}));
