import {
	APIGatewayProxyEvent,
	APIGatewayProxyResult,
	Context,
} from "aws-lambda";
import { and, asc, count, eq, gte, lte, max, sql, sum } from "drizzle-orm";
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
		body: JSON.stringify({ code: "INTERNAL_ERROR", message: "Unexpected error" }),
	};
};

// ── Router ────────────────────────────────────────────────────────────────────

export async function handler(
	event: APIGatewayProxyEvent,
	_ctx: Context
): Promise<APIGatewayProxyResult> {
	const { httpMethod: m, resource: r } = event;

	try {
		const sub = getUserSub(event);

		if (r === "/stats/summary" && m === "GET") return getSummary(sub);
		if (r === "/stats/frequency" && m === "GET") return getFrequency(event, sub);
		if (r === "/stats/exercises/{exerciseId}" && m === "GET") return getExerciseProgression(event, sub);

		return notFound("Route not found");
	} catch (err) {
		return serverError(err);
	}
}

// ── GET /stats/summary ────────────────────────────────────────────────────────
// Total sessions, total volume lifted, current streak

async function getSummary(sub: string) {
	const db = await getDb();

	// Total workout sessions
	const [{ totalWorkouts }] = await db
		.select({ totalWorkouts: count(workout.id) })
		.from(workout)
		.innerJoin(user, eq(workout.userId, user.id))
		.where(eq(user.cognitoSub, sub));

	// Total volume across all strength/bodyweight sets: SUM(reps * weight_kg)
	const [{ totalVolumeKg }] = await db
		.select({
			totalVolumeKg: sql<number>`
        COALESCE(SUM(${exerciseEntry.reps} * ${exerciseEntry.weightKg}::numeric), 0)
      `,
		})
		.from(exerciseEntry)
		.innerJoin(workoutExercise, eq(exerciseEntry.workoutExerciseId, workoutExercise.id))
		.innerJoin(workout, eq(workoutExercise.workoutId, workout.id))
		.innerJoin(user, eq(workout.userId, user.id))
		.where(
			and(
				eq(user.cognitoSub, sub),
				sql`${exerciseEntry.reps} IS NOT NULL`,
				sql`${exerciseEntry.weightKg} IS NOT NULL`,
			)
		);

	// Current streak: consecutive days with at least one workout, counting back from today
	const streakResult = await db.execute<{ streak: number }>(sql`
    WITH daily AS (
      SELECT DISTINCT w.performed_on::date AS day
      FROM workout w
      JOIN "user" u ON u.id = w.user_id
      WHERE u.cognito_sub = ${sub}
    ),
    numbered AS (
      SELECT day,
             ROW_NUMBER() OVER (ORDER BY day DESC) AS rn
      FROM daily
    ),
    streak_check AS (
      SELECT day,
             rn,
             (CURRENT_DATE - (rn - 1) * INTERVAL '1 day')::date AS expected
      FROM numbered
    )
    SELECT COUNT(*) AS streak
    FROM streak_check
    WHERE day = expected
  `);

	const streak = streakResult.rows[0]?.streak ?? 0;

	return ok({ totalWorkouts, totalVolumeKg: Number(totalVolumeKg), currentStreak: Number(streak) });
}

// ── GET /stats/frequency ──────────────────────────────────────────────────────
// Workouts per calendar week within a date range

async function getFrequency(event: APIGatewayProxyEvent, sub: string) {
	const db = await getDb();
	const { from, to } = event.queryStringParameters ?? {};

	const rows = await db
		.select({
			week: sql<string>`TO_CHAR(DATE_TRUNC('week', ${workout.performedOn}), 'IYYY-IW')`,
			weekStartDate: sql<string>`DATE_TRUNC('week', ${workout.performedOn})::date`,
			workoutCount: count(workout.id),
		})
		.from(workout)
		.innerJoin(user, eq(workout.userId, user.id))
		.where(
			and(
				eq(user.cognitoSub, sub),
				from ? gte(workout.performedOn, new Date(from)) : undefined,
				to ? lte(workout.performedOn, new Date(to)) : undefined,
			)
		)
		.groupBy(sql`DATE_TRUNC('week', ${workout.performedOn})`)
		.orderBy(asc(sql`DATE_TRUNC('week', ${workout.performedOn})`));

	return ok(rows);
}

// ── GET /stats/exercises/{exerciseId} ─────────────────────────────────────────
// Progression over time — response shape determined by tracking_type

async function getExerciseProgression(event: APIGatewayProxyEvent, sub: string) {
	const db = await getDb();
	const { exerciseId } = event.pathParameters!;
	const {
		from,
		to,
		limit = "50",
	} = event.queryStringParameters ?? {};

	// 1. Resolve exercise + tracking type
	const [ex] = await db
		.select()
		.from(exercise)
		.where(eq(exercise.id, exerciseId!))
		.limit(1);

	if (!ex) return notFound(`Exercise '${exerciseId}' not found`);

	// 2. Fetch all sessions for this exercise belonging to the user
	const sessions = await db
		.select({
			workoutId: workout.id,
			performedOn: workout.performedOn,
			weId: workoutExercise.id,
		})
		.from(workoutExercise)
		.innerJoin(workout, eq(workoutExercise.workoutId, workout.id))
		.innerJoin(user, eq(workout.userId, user.id))
		.where(
			and(
				eq(workoutExercise.exerciseId, exerciseId!),
				eq(user.cognitoSub, sub),
				from ? gte(workout.performedOn, new Date(from)) : undefined,
				to ? lte(workout.performedOn, new Date(to)) : undefined,
			)
		)
		.orderBy(asc(workout.performedOn))
		.limit(Number(limit));

	if (sessions.length === 0) return ok({ exercise: ex, dataPoints: [] });

	const weIds = sessions.map((s) => s.weId);

	// 3. Build data points based on tracking_type
	let dataPoints: unknown[];

	switch (ex.trackingType) {

		case "strength": {
			// Per session: totalSets, bestSet (max weight), totalVolumeKg
			const rows = await db
				.select({
					weId: exerciseEntry.workoutExerciseId,
					totalSets: count(exerciseEntry.id),
					bestWeightKg: max(exerciseEntry.weightKg),
					bestReps: sql<number>`
            (ARRAY_AGG(${exerciseEntry.reps} ORDER BY ${exerciseEntry.weightKg} DESC NULLS LAST))[1]
          `,
					totalVolumeKg: sql<number>`
            SUM(${exerciseEntry.reps} * ${exerciseEntry.weightKg}::numeric)
          `,
				})
				.from(exerciseEntry)
				.where(sql`${exerciseEntry.workoutExerciseId} = ANY(${weIds})`)
				.groupBy(exerciseEntry.workoutExerciseId);

			const byWeId = new Map(rows.map((r) => [r.weId, r]));
			dataPoints = sessions.map((s) => {
				const r = byWeId.get(s.weId);
				return {
					workoutId: s.workoutId,
					performedOn: s.performedOn,
					trackingType: "strength",
					totalSets: r?.totalSets ?? 0,
					bestSet: { reps: r?.bestReps ?? 0, weightKg: Number(r?.bestWeightKg ?? 0) },
					totalVolumeKg: Number(r?.totalVolumeKg ?? 0),
				};
			});
			break;
		}

		case "bodyweight": {
			const rows = await db
				.select({
					weId: exerciseEntry.workoutExerciseId,
					totalSets: count(exerciseEntry.id),
					bestReps: max(exerciseEntry.reps),
					totalReps: sum(exerciseEntry.reps),
				})
				.from(exerciseEntry)
				.where(sql`${exerciseEntry.workoutExerciseId} = ANY(${weIds})`)
				.groupBy(exerciseEntry.workoutExerciseId);

			const byWeId = new Map(rows.map((r) => [r.weId, r]));
			dataPoints = sessions.map((s) => {
				const r = byWeId.get(s.weId);
				return {
					workoutId: s.workoutId,
					performedOn: s.performedOn,
					trackingType: "bodyweight",
					totalSets: r?.totalSets ?? 0,
					bestSet: { reps: r?.bestReps ?? 0 },
					totalReps: Number(r?.totalReps ?? 0),
				};
			});
			break;
		}

		case "timed": {
			const rows = await db
				.select({
					weId: exerciseEntry.workoutExerciseId,
					totalSets: count(exerciseEntry.id),
					bestDurationSecs: max(exerciseEntry.durationSecs),
					totalDurationSecs: sum(exerciseEntry.durationSecs),
				})
				.from(exerciseEntry)
				.where(sql`${exerciseEntry.workoutExerciseId} = ANY(${weIds})`)
				.groupBy(exerciseEntry.workoutExerciseId);

			const byWeId = new Map(rows.map((r) => [r.weId, r]));
			dataPoints = sessions.map((s) => {
				const r = byWeId.get(s.weId);
				return {
					workoutId: s.workoutId,
					performedOn: s.performedOn,
					trackingType: "timed",
					totalSets: r?.totalSets ?? 0,
					bestDurationSecs: r?.bestDurationSecs ?? 0,
					totalDurationSecs: Number(r?.totalDurationSecs ?? 0),
				};
			});
			break;
		}

		case "running": {
			const rows = await db
				.select({
					weId: exerciseEntry.workoutExerciseId,
					distanceKm: sum(exerciseEntry.distanceKm),
					durationSecs: sum(exerciseEntry.durationSecs),
				})
				.from(exerciseEntry)
				.where(sql`${exerciseEntry.workoutExerciseId} = ANY(${weIds})`)
				.groupBy(exerciseEntry.workoutExerciseId);

			const byWeId = new Map(rows.map((r) => [r.weId, r]));
			dataPoints = sessions.map((s) => {
				const r = byWeId.get(s.weId);
				const distanceKm = Number(r?.distanceKm ?? 0);
				const durationSecs = Number(r?.durationSecs ?? 0);
				// Derived — not stored, computed here to keep the DB clean
				const paceSecsPerKm = distanceKm > 0 ? Math.round(durationSecs / distanceKm) : null;
				return {
					workoutId: s.workoutId,
					performedOn: s.performedOn,
					trackingType: "running",
					distanceKm,
					durationSecs,
					paceSecsPerKm,
				};
			});
			break;
		}

		case "freestyle": {
			const rows = await db
				.select({
					weId: exerciseEntry.workoutExerciseId,
					durationSecs: sum(exerciseEntry.durationSecs),
				})
				.from(exerciseEntry)
				.where(sql`${exerciseEntry.workoutExerciseId} = ANY(${weIds})`)
				.groupBy(exerciseEntry.workoutExerciseId);

			const byWeId = new Map(rows.map((r) => [r.weId, r]));
			dataPoints = sessions.map((s) => ({
				workoutId: s.workoutId,
				performedOn: s.performedOn,
				trackingType: "freestyle",
				durationSecs: Number(byWeId.get(s.weId)?.durationSecs ?? 0),
			}));
			break;
		}

		case "climbing": {
			// Session-level duration from exercise_entry + route details from climbing_route
			const entryRows = await db
				.select({
					weId: exerciseEntry.workoutExerciseId,
					durationSecs: sum(exerciseEntry.durationSecs),
				})
				.from(exerciseEntry)
				.where(sql`${exerciseEntry.workoutExerciseId} = ANY(${weIds})`)
				.groupBy(exerciseEntry.workoutExerciseId);

			const routeRows = await db
				.select({
					weId: climbingRoute.workoutExerciseId,
					difficulty: climbingRoute.difficulty,
					completed: climbingRoute.completed,
					attempts: climbingRoute.attempts,
				})
				.from(climbingRoute)
				.where(sql`${climbingRoute.workoutExerciseId} = ANY(${weIds})`);

			const entryByWeId = new Map(entryRows.map((r) => [r.weId, r]));
			const routesByWeId = new Map<string, typeof routeRows>();
			for (const r of routeRows) {
				if (!routesByWeId.has(r.weId)) routesByWeId.set(r.weId, []);
				routesByWeId.get(r.weId)!.push(r);
			}

			dataPoints = sessions.map((s) => {
				const routes = routesByWeId.get(s.weId) ?? [];
				const completedRoutes = routes.filter((r) => r.completed).length;

				// Max difficulty: sort grades numerically by stripping the "V" prefix
				const maxDifficulty = routes
					.map((r) => r.difficulty)
					.sort((a, b) => {
						const parse = (d: string) => parseInt(d.replace(/[^0-9]/g, ""), 10) || 0;
						return parse(b) - parse(a);
					})[0] ?? null;

				return {
					workoutId: s.workoutId,
					performedOn: s.performedOn,
					trackingType: "climbing",
					durationSecs: Number(entryByWeId.get(s.weId)?.durationSecs ?? 0),
					totalRoutes: routes.length,
					completedRoutes,
					maxDifficulty,
					routes: routes.map(({ difficulty, completed, attempts }) => ({
						difficulty, completed, attempts,
					})),
				};
			});
			break;
		}

		default:
			return badRequest(`Unknown tracking_type: ${ex.trackingType}`);
	}

	return ok({ exercise: ex, dataPoints });
}
