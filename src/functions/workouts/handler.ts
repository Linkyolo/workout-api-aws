import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import {
  climbingRoute,
  exercise,
  exerciseEntry,
  getDb,
  user,
  workout,
  workoutExercise,
} from "../../db/client";
import { getUserSub } from "../../shared/auth";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

const sns = new SNSClient({});
const TOPIC_ARN = process.env.WORKOUT_TOPIC_ARN!;
// ── Response helpers ──────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

const ok = (body: unknown): APIGatewayProxyResult => ({
  statusCode: 200,
  headers: CORS_HEADERS,
  body: JSON.stringify(body),
});
const created = (body: unknown): APIGatewayProxyResult => ({
  statusCode: 201,
  headers: CORS_HEADERS,
  body: JSON.stringify(body),
});
const noContent = (): APIGatewayProxyResult => ({
  statusCode: 204,
  headers: CORS_HEADERS,
  body: "",
});

const notFound = (message = "Not found"): APIGatewayProxyResult => ({
  statusCode: 404,
  headers: CORS_HEADERS,
  body: JSON.stringify({ code: "NOT_FOUND", message }),
});

const badRequest = (message: string): APIGatewayProxyResult => ({
  statusCode: 400,
  headers: CORS_HEADERS,
  body: JSON.stringify({ code: "BAD_REQUEST", message }),
});

const serverError = (err: unknown): APIGatewayProxyResult => {
  console.error(err);
  return {
    statusCode: 500,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      code: "INTERNAL_ERROR",
      message: "Unexpected error",
    }),
  };
};

// ── Router ────────────────────────────────────────────────────────────────────

export async function handler(
  event: APIGatewayProxyEvent,
  _ctx: Context,
): Promise<APIGatewayProxyResult> {
  const { httpMethod: m, resource: r } = event;

  console.log(`HTTP trigger — ${JSON.stringify({ method: m, resource: r })}`);
  try {
    // Public — no auth required
    if (r === "/exercises" && m === "GET") return listExercises(event);
    if (r === "/exercises/{exerciseId}" && m === "GET")
      return getExercise(event);

    // Protected — Cognito authorizer injects sub before Lambda runs
    const sub = getUserSub(event);

    if (r === "/users/me" && m === "POST") return syncUser(event, sub);

    if (r === "/workouts" && m === "GET") return listWorkouts(event, sub);
    if (r === "/workouts" && m === "POST") return createWorkout(event, sub);
    if (r === "/workouts/{workoutId}" && m === "GET")
      return getWorkout(event, sub);
    if (r === "/workouts/{workoutId}" && m === "PATCH")
      return updateWorkout(event, sub);
    if (r === "/workouts/{workoutId}" && m === "DELETE")
      return deleteWorkout(event, sub);

    if (r === "/workouts/{workoutId}/exercises" && m === "POST")
      return addExercise(event, sub);
    if (r === "/workouts/{workoutId}/exercises/{weId}" && m === "PATCH")
      return updateWorkoutExercise(event, sub);
    if (r === "/workouts/{workoutId}/exercises/{weId}" && m === "DELETE")
      return removeExercise(event, sub);

    if (r === "/workouts/{workoutId}/exercises/{weId}/entries" && m === "POST")
      return addEntry(event, sub);
    if (
      r === "/workouts/{workoutId}/exercises/{weId}/entries/{entryId}" &&
      m === "PATCH"
    )
      return updateEntry(event, sub);
    if (
      r === "/workouts/{workoutId}/exercises/{weId}/entries/{entryId}" &&
      m === "DELETE"
    )
      return deleteEntry(event, sub);

    if (r === "/workouts/{workoutId}/exercises/{weId}/routes" && m === "POST")
      return addRoute(event, sub);
    if (
      r === "/workouts/{workoutId}/exercises/{weId}/routes/{routeId}" &&
      m === "PATCH"
    )
      return updateRoute(event, sub);
    if (
      r === "/workouts/{workoutId}/exercises/{weId}/routes/{routeId}" &&
      m === "DELETE"
    )
      return deleteRoute(event, sub);

    return notFound("Route not found");
  } catch (err) {
    return serverError(err);
  }
}

// ── User sync ─────────────────────────────────────────────────────────────────

async function syncUser(event: APIGatewayProxyEvent, sub: string) {
  const db = await getDb();
  const body = JSON.parse(event.body ?? "{}") as { displayName?: string };

  await db
    .insert(user)
    .values({ cognitoSub: sub, displayName: body.displayName ?? null })
    .onConflictDoNothing();

  const [row] = await db
    .select()
    .from(user)
    .where(eq(user.cognitoSub, sub))
    .limit(1);

  return ok(row);
}

// ── Exercise catalogue ────────────────────────────────────────────────────────

async function listExercises(event: APIGatewayProxyEvent) {
  const db = await getDb();
  const { category, tracking_type } = event.queryStringParameters ?? {};

  const rows = await db
    .select()
    .from(exercise)
    .where(
      and(
        category
          ? eq(exercise.category, category as typeof exercise.category._.data)
          : undefined,
        tracking_type
          ? eq(
              exercise.trackingType,
              tracking_type as typeof exercise.trackingType._.data,
            )
          : undefined,
      ),
    )
    .orderBy(exercise.category, exercise.name);

  return ok(rows);
}

async function getExercise(event: APIGatewayProxyEvent) {
  const db = await getDb();
  const exerciseId = event.pathParameters?.exerciseId;
  if (!exerciseId) return badRequest("exerciseId is required");

  const [row] = await db
    .select()
    .from(exercise)
    .where(eq(exercise.id, exerciseId))
    .limit(1);

  return row ? ok(row) : notFound(`Exercise '${exerciseId}' not found`);
}

// ── Workouts ──────────────────────────────────────────────────────────────────

async function listWorkouts(event: APIGatewayProxyEvent, sub: string) {
  const db = await getDb();
  const {
    from,
    to,
    limit = "20",
    offset = "0",
  } = event.queryStringParameters ?? {};

  const rows = await db
    .select({
      id: workout.id,
      name: workout.name,
      performedOn: workout.performedOn,
      notes: workout.notes,
      createdAt: workout.createdAt,
    })
    .from(workout)
    .innerJoin(user, eq(workout.userId, user.id))
    .where(
      and(
        eq(user.cognitoSub, sub),
        from ? gte(workout.performedOn, new Date(from)) : undefined,
        to ? lte(workout.performedOn, new Date(to)) : undefined,
      ),
    )
    .orderBy(desc(workout.performedOn))
    .limit(Number(limit))
    .offset(Number(offset));

  return ok(rows);
}

async function createWorkout(event: APIGatewayProxyEvent, sub: string) {
  const db = await getDb();
  const body = JSON.parse(event.body ?? "{}") as {
    name?: string;
    performedOn?: string;
    notes?: string;
  };

  if (!body.name) return badRequest("name is required");
  if (!body.performedOn) return badRequest("performedOn is required");

  const [row] = await db
    .insert(workout)
    .values({
      userId: sql`(SELECT id FROM "user" WHERE cognito_sub = ${sub})`,
      name: body.name,
      performedOn: new Date(body.performedOn),
      notes: body.notes ?? null,
    })
    .returning();

  return created(row);
}

async function getWorkout(event: APIGatewayProxyEvent, sub: string) {
  const db = await getDb();
  const workoutId = event.pathParameters?.workoutId;
  if (!workoutId) return badRequest("workoutId is required");

  // Verify ownership
  const [workoutRow] = await db
    .select()
    .from(workout)
    .innerJoin(user, eq(workout.userId, user.id))
    .where(and(eq(workout.id, workoutId), eq(user.cognitoSub, sub)))
    .limit(1);

  if (!workoutRow) return notFound();

  // Fetch exercises + entries in one query
  const rows = await db
    .select({
      weId: workoutExercise.id,
      sortOrder: workoutExercise.sortOrder,
      exerciseId: exercise.id,
      exerciseName: exercise.name,
      trackingType: exercise.trackingType,
      category: exercise.category,
      muscleGroup: exercise.muscleGroup,
      entryId: exerciseEntry.id,
      entryNumber: exerciseEntry.entryNumber,
      reps: exerciseEntry.reps,
      weightKg: exerciseEntry.weightKg,
      durationSecs: exerciseEntry.durationSecs,
      distanceKm: exerciseEntry.distanceKm,
    })
    .from(workoutExercise)
    .innerJoin(exercise, eq(workoutExercise.exerciseId, exercise.id))
    .leftJoin(
      exerciseEntry,
      eq(exerciseEntry.workoutExerciseId, workoutExercise.id),
    )
    .where(eq(workoutExercise.workoutId, workoutId))
    .orderBy(workoutExercise.sortOrder, exerciseEntry.entryNumber);

  // Fetch climbing routes separately — one extra query only if the workout has exercises
  const routeRows = await db
    .select({
      weId: climbingRoute.workoutExerciseId,
      id: climbingRoute.id,
      difficulty: climbingRoute.difficulty,
      completed: climbingRoute.completed,
      attempts: climbingRoute.attempts,
    })
    .from(climbingRoute)
    .innerJoin(
      workoutExercise,
      eq(climbingRoute.workoutExerciseId, workoutExercise.id),
    )
    .where(eq(workoutExercise.workoutId, workoutId));

  // Group routes by workout_exercise id
  const routesByWeId = new Map<string, unknown[]>();
  for (const r of routeRows) {
    if (!routesByWeId.has(r.weId)) routesByWeId.set(r.weId, []);
    routesByWeId.get(r.weId)!.push({
      id: r.id,
      difficulty: r.difficulty,
      completed: r.completed,
      attempts: r.attempts,
    });
  }

  // Assemble nested structure
  const exerciseMap = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    if (!exerciseMap.has(r.weId)) {
      exerciseMap.set(r.weId, {
        id: r.weId,
        sortOrder: r.sortOrder,
        exercise: {
          id: r.exerciseId,
          name: r.exerciseName,
          trackingType: r.trackingType,
          category: r.category,
          muscleGroup: r.muscleGroup,
        },
        entries: [],
        climbingRoutes: routesByWeId.get(r.weId) ?? [],
      });
    }
    if (r.entryId) {
      const ex = exerciseMap.get(r.weId)!;
      (ex.entries as unknown[]).push({
        id: r.entryId,
        entryNumber: r.entryNumber,
        reps: r.reps,
        weightKg: r.weightKg,
        durationSecs: r.durationSecs,
        distanceKm: r.distanceKm,
      });
    }
  }

  return ok({
    ...workoutRow.workout,
    workoutExercises: [...exerciseMap.values()],
  });
}

async function updateWorkout(event: APIGatewayProxyEvent, sub: string) {
  const db = await getDb();
  const workoutId = event.pathParameters?.workoutId;
  if (!workoutId) return badRequest("workoutId is required");

  const body = JSON.parse(event.body ?? "{}") as {
    name?: string;
    performedOn?: string;
    notes?: string;
  };

  const patch: Partial<typeof workout.$inferInsert> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.performedOn !== undefined)
    patch.performedOn = new Date(body.performedOn);
  if (body.notes !== undefined) patch.notes = body.notes;

  if (Object.keys(patch).length === 0) return badRequest("No fields to update");

  const [updated] = await db
    .update(workout)
    .set(patch)
    .where(
      and(
        eq(workout.id, workoutId),
        eq(
          workout.userId,
          sql`(SELECT id FROM "user" WHERE cognito_sub = ${sub})`,
        ),
      ),
    )
    .returning();

  return updated ? ok(updated) : notFound();
}

async function deleteWorkout(event: APIGatewayProxyEvent, sub: string) {
  const db = await getDb();
  const workoutId = event.pathParameters?.workoutId;
  if (!workoutId) return badRequest("workoutId is required");

  const [deleted] = await db
    .delete(workout)
    .where(
      and(
        eq(workout.id, workoutId),
        eq(
          workout.userId,
          sql`(SELECT id FROM "user" WHERE cognito_sub = ${sub})`,
        ),
      ),
    )
    .returning({ id: workout.id });

  return deleted ? noContent() : notFound();
}

// ── Workout exercises ─────────────────────────────────────────────────────────

async function addExercise(event: APIGatewayProxyEvent, sub: string) {
  const db = await getDb();
  const workoutId = event.pathParameters?.workoutId;
  if (!workoutId) return badRequest("workoutId is required");

  const body = JSON.parse(event.body ?? "{}") as {
    exerciseId?: string;
    sortOrder?: number;
  };
  if (!body.exerciseId) return badRequest("exerciseId is required");

  const [ownerCheck] = await db
    .select({ id: workout.id })
    .from(workout)
    .innerJoin(user, eq(workout.userId, user.id))
    .where(and(eq(workout.id, workoutId), eq(user.cognitoSub, sub)))
    .limit(1);

  if (!ownerCheck) return notFound();

  const [row] = await db
    .insert(workoutExercise)
    .values({
      workoutId,
      exerciseId: body.exerciseId,
      sortOrder: body.sortOrder ?? 0,
    })
    .returning();

  return created(row);
}

async function updateWorkoutExercise(event: APIGatewayProxyEvent, sub: string) {
  const db = await getDb();
  const workoutId = event.pathParameters?.workoutId;
  const weId = event.pathParameters?.weId;
  if (!workoutId || !weId) return badRequest("workoutId and weId are required");

  const body = JSON.parse(event.body ?? "{}") as { sortOrder?: number };
  if (body.sortOrder === undefined) return badRequest("sortOrder is required");

  const [ownerCheck] = await db
    .select({ id: workoutExercise.id })
    .from(workoutExercise)
    .innerJoin(workout, eq(workoutExercise.workoutId, workout.id))
    .innerJoin(user, eq(workout.userId, user.id))
    .where(
      and(
        eq(workoutExercise.id, weId),
        eq(workout.id, workoutId),
        eq(user.cognitoSub, sub),
      ),
    )
    .limit(1);

  if (!ownerCheck) return notFound();

  const [updated] = await db
    .update(workoutExercise)
    .set({ sortOrder: body.sortOrder })
    .where(eq(workoutExercise.id, weId))
    .returning();

  return updated ? ok(updated) : notFound();
}

async function removeExercise(event: APIGatewayProxyEvent, sub: string) {
  const db = await getDb();
  const workoutId = event.pathParameters?.workoutId;
  const weId = event.pathParameters?.weId;
  if (!workoutId || !weId) return badRequest("workoutId and weId are required");

  const [ownerCheck] = await db
    .select({ id: workoutExercise.id })
    .from(workoutExercise)
    .innerJoin(workout, eq(workoutExercise.workoutId, workout.id))
    .innerJoin(user, eq(workout.userId, user.id))
    .where(
      and(
        eq(workoutExercise.id, weId),
        eq(workout.id, workoutId),
        eq(user.cognitoSub, sub),
      ),
    )
    .limit(1);

  if (!ownerCheck) return notFound();

  const [deleted] = await db
    .delete(workoutExercise)
    .where(eq(workoutExercise.id, weId))
    .returning({ id: workoutExercise.id });

  return deleted ? noContent() : notFound();
}

// ── Entries: deprecated, kept as a ref  ───────────────────────────────────────────────────────────────────

// async function addEntry(event: APIGatewayProxyEvent, sub: string) {
// 	const db = await getDb();
// 	const workoutId = event.pathParameters?.workoutId;
// 	const weId = event.pathParameters?.weId;
// 	if (!workoutId || !weId) return badRequest("workoutId and weId are required");
//
// 	const body = JSON.parse(event.body ?? "{}") as {
// 		reps?: number;
// 		weightKg?: number;
// 		durationSecs?: number;
// 		distanceKm?: number;
// 	};
//
// 	const [ownerCheck] = await db
// 		.select({ id: workoutExercise.id })
// 		.from(workoutExercise)
// 		.innerJoin(workout, eq(workoutExercise.workoutId, workout.id))
// 		.innerJoin(user, eq(workout.userId, user.id))
// 		.where(and(eq(workoutExercise.id, weId), eq(workout.id, workoutId), eq(user.cognitoSub, sub)))
// 		.limit(1);
//
// 	if (!ownerCheck) return notFound();
//
// 	const [{ nextNum }] = await db
// 		.select({ nextNum: sql<number>`COALESCE(MAX(${exerciseEntry.entryNumber}), 0) + 1` })
// 		.from(exerciseEntry)
// 		.where(eq(exerciseEntry.workoutExerciseId, weId));
//
// 	const [row] = await db
// 		.insert(exerciseEntry)
// 		.values({
// 			workoutExerciseId: weId,
// 			entryNumber: nextNum,
// 			reps: body.reps ?? null,
// 			weightKg: body.weightKg?.toString() ?? null,
// 			durationSecs: body.durationSecs ?? null,
// 			distanceKm: body.distanceKm?.toString() ?? null,
// 		})
// 		.returning();
//
// 	return created(row);
// }

async function updateEntry(event: APIGatewayProxyEvent, sub: string) {
  const db = await getDb();
  const weId = event.pathParameters?.weId;
  const entryId = event.pathParameters?.entryId;
  if (!weId || !entryId) return badRequest("weId and entryId are required");

  const body = JSON.parse(event.body ?? "{}") as {
    reps?: number;
    weightKg?: number;
    durationSecs?: number;
    distanceKm?: number;
  };

  const patch: Partial<typeof exerciseEntry.$inferInsert> = {};
  if (body.reps !== undefined) patch.reps = body.reps;
  if (body.weightKg !== undefined) patch.weightKg = body.weightKg.toString();
  if (body.durationSecs !== undefined) patch.durationSecs = body.durationSecs;
  if (body.distanceKm !== undefined)
    patch.distanceKm = body.distanceKm.toString();

  if (Object.keys(patch).length === 0) return badRequest("No fields to update");

  const [ownerCheck] = await db
    .select({ id: exerciseEntry.id })
    .from(exerciseEntry)
    .innerJoin(
      workoutExercise,
      eq(exerciseEntry.workoutExerciseId, workoutExercise.id),
    )
    .innerJoin(workout, eq(workoutExercise.workoutId, workout.id))
    .innerJoin(user, eq(workout.userId, user.id))
    .where(
      and(
        eq(exerciseEntry.id, entryId),
        eq(workoutExercise.id, weId),
        eq(user.cognitoSub, sub),
      ),
    )
    .limit(1);

  if (!ownerCheck) return notFound();

  const [updated] = await db
    .update(exerciseEntry)
    .set(patch)
    .where(eq(exerciseEntry.id, entryId))
    .returning();

  return updated ? ok(updated) : notFound();
}

async function deleteEntry(event: APIGatewayProxyEvent, sub: string) {
  const db = await getDb();
  const weId = event.pathParameters?.weId;
  const entryId = event.pathParameters?.entryId;
  if (!weId || !entryId) return badRequest("weId and entryId are required");

  const [ownerCheck] = await db
    .select({ id: exerciseEntry.id })
    .from(exerciseEntry)
    .innerJoin(
      workoutExercise,
      eq(exerciseEntry.workoutExerciseId, workoutExercise.id),
    )
    .innerJoin(workout, eq(workoutExercise.workoutId, workout.id))
    .innerJoin(user, eq(workout.userId, user.id))
    .where(
      and(
        eq(exerciseEntry.id, entryId),
        eq(workoutExercise.id, weId),
        eq(user.cognitoSub, sub),
      ),
    )
    .limit(1);

  if (!ownerCheck) return notFound();

  const [deleted] = await db
    .delete(exerciseEntry)
    .where(eq(exerciseEntry.id, entryId))
    .returning({ id: exerciseEntry.id });

  return deleted ? noContent() : notFound();
}

// ── Climbing routes ───────────────────────────────────────────────────────────

async function addRoute(event: APIGatewayProxyEvent, sub: string) {
  const db = await getDb();
  const workoutId = event.pathParameters?.workoutId;
  const weId = event.pathParameters?.weId;
  if (!workoutId || !weId) return badRequest("workoutId and weId are required");

  const body = JSON.parse(event.body ?? "{}") as {
    difficulty?: string;
    completed?: boolean;
    attempts?: number;
  };
  if (!body.difficulty) return badRequest("difficulty is required");

  const [ownerCheck] = await db
    .select({ id: workoutExercise.id })
    .from(workoutExercise)
    .innerJoin(workout, eq(workoutExercise.workoutId, workout.id))
    .innerJoin(user, eq(workout.userId, user.id))
    .where(
      and(
        eq(workoutExercise.id, weId),
        eq(workout.id, workoutId),
        eq(user.cognitoSub, sub),
      ),
    )
    .limit(1);

  if (!ownerCheck) return notFound();

  const [row] = await db
    .insert(climbingRoute)
    .values({
      workoutExerciseId: weId,
      difficulty: body.difficulty,
      completed: body.completed ?? false,
      attempts: body.attempts ?? 1,
    })
    .returning();

  return created(row);
}

async function updateRoute(event: APIGatewayProxyEvent, sub: string) {
  const db = await getDb();
  const weId = event.pathParameters?.weId;
  const routeId = event.pathParameters?.routeId;
  if (!weId || !routeId) return badRequest("weId and routeId are required");

  const body = JSON.parse(event.body ?? "{}") as {
    difficulty?: string;
    completed?: boolean;
    attempts?: number;
  };

  const patch: Partial<typeof climbingRoute.$inferInsert> = {};
  if (body.difficulty !== undefined) patch.difficulty = body.difficulty;
  if (body.completed !== undefined) patch.completed = body.completed;
  if (body.attempts !== undefined) patch.attempts = body.attempts;

  if (Object.keys(patch).length === 0) return badRequest("No fields to update");

  const [ownerCheck] = await db
    .select({ id: climbingRoute.id })
    .from(climbingRoute)
    .innerJoin(
      workoutExercise,
      eq(climbingRoute.workoutExerciseId, workoutExercise.id),
    )
    .innerJoin(workout, eq(workoutExercise.workoutId, workout.id))
    .innerJoin(user, eq(workout.userId, user.id))
    .where(
      and(
        eq(climbingRoute.id, routeId),
        eq(workoutExercise.id, weId),
        eq(user.cognitoSub, sub),
      ),
    )
    .limit(1);

  if (!ownerCheck) return notFound();

  const [updated] = await db
    .update(climbingRoute)
    .set(patch)
    .where(eq(climbingRoute.id, routeId))
    .returning();

  return updated ? ok(updated) : notFound();
}

async function deleteRoute(event: APIGatewayProxyEvent, sub: string) {
  const db = await getDb();
  const weId = event.pathParameters?.weId;
  const routeId = event.pathParameters?.routeId;
  if (!weId || !routeId) return badRequest("weId and routeId are required");

  const [ownerCheck] = await db
    .select({ id: climbingRoute.id })
    .from(climbingRoute)
    .innerJoin(
      workoutExercise,
      eq(climbingRoute.workoutExerciseId, workoutExercise.id),
    )
    .innerJoin(workout, eq(workoutExercise.workoutId, workout.id))
    .innerJoin(user, eq(workout.userId, user.id))
    .where(
      and(
        eq(climbingRoute.id, routeId),
        eq(workoutExercise.id, weId),
        eq(user.cognitoSub, sub),
      ),
    )
    .limit(1);

  if (!ownerCheck) return notFound();

  const [deleted] = await db
    .delete(climbingRoute)
    .where(eq(climbingRoute.id, routeId))
    .returning({ id: climbingRoute.id });

  return deleted ? noContent() : notFound();
}
// -- Handler HTTP (publish): --

async function addEntry(event: APIGatewayProxyEvent, sub: string) {
  const workoutId = event.pathParameters?.workoutId;
  const weId = event.pathParameters?.weId;
  if (!workoutId || !weId) return badRequest("workoutId and weId are required");

  const body = JSON.parse(event.body ?? "{}") as {
    reps?: number;
    weightKg?: number;
    durationSecs?: number;
    distanceKm?: number;
  };

  const db = await getDb();
  const [ownerCheck] = await db
    .select({ id: workoutExercise.id })
    .from(workoutExercise)
    .innerJoin(workout, eq(workoutExercise.workoutId, workout.id))
    .innerJoin(user, eq(workout.userId, user.id))
    .where(
      and(
        eq(workoutExercise.id, weId),
        eq(workout.id, workoutId),
        eq(user.cognitoSub, sub),
      ),
    )
    .limit(1);
  if (!ownerCheck) return notFound();

  const message = {
    type: "ADD_ENTRY",
    sub,
    workoutId,
    weId,
    entry: body,
    requestId: event.requestContext.requestId,
  };

  await sns.send(
    new PublishCommand({
      TopicArn: TOPIC_ARN,
      Message: JSON.stringify(message),
      // utile per eventuale filtering SNS in futuro
      MessageAttributes: {
        type: { DataType: "String", StringValue: message.type },
      },
    }),
  );

  return {
    statusCode: 202,
    headers: CORS_HEADERS,
    body: JSON.stringify({ status: "accepted" }),
  };
}
