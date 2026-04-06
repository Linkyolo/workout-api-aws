import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { exercise } from "./schema";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

async function main() {
	const db = drizzle(neon(process.env.DATABASE_URL!));

	await db.insert(exercise).values([
		// Strength
		{ name: "Bench press", category: "strength", trackingType: "strength", muscleGroup: "chest" },
		{ name: "Squat", category: "strength", trackingType: "strength", muscleGroup: "legs" },
		{ name: "Deadlift", category: "strength", trackingType: "strength", muscleGroup: "back" },
		{ name: "Pistol squat", category: "strength", trackingType: "strength", muscleGroup: "legs" },
		// Calisthenics
		{ name: "Push-ups", category: "calisthenics", trackingType: "bodyweight", muscleGroup: "chest" },
		{ name: "Pull-ups", category: "calisthenics", trackingType: "bodyweight", muscleGroup: "back" },
		{ name: "Negative muscle-up", category: "calisthenics", trackingType: "bodyweight", muscleGroup: "back" },
		{ name: "Plank", category: "calisthenics", trackingType: "timed", muscleGroup: "core" },
		{ name: "Pigeon split", category: "calisthenics", trackingType: "timed", muscleGroup: "hip flexors" },
		// Sports
		{ name: "Running", category: "sports", trackingType: "running" },
		{ name: "Football freestyle", category: "sports", trackingType: "freestyle" },
		{ name: "Climbing", category: "sports", trackingType: "climbing" },
	]).onConflictDoNothing();

	console.log("Seeded exercise catalogue");
}

main().catch(console.error).finally(() => process.exit(0));
