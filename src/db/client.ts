import {
	SSMClient,
	GetParameterCommand,
} from "@aws-sdk/client-ssm";
import { drizzle, NeonHttpDatabase } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

// Re-export everything from schema so handlers have a single import point:
//   import { db }      from "../../db/client"  ← query client
//   import { workout } from "../../db/client"  ← table references + types
export * from "./schema";

export type Db = NeonHttpDatabase<typeof schema>;

// Module-level singleton — reused across warm Lambda invocations
let _db: Db | null = null;

const sm = new SSMClient({});

async function resolveConnectionString(): Promise<string> {
	const res = await sm.send(
		new GetParameterCommand({
			Name: process.env.NEON_SSM_PARAM,
			WithDecryption: true, // parameter is stored as SecureString
		})
	);
	if (!res.Parameter?.Value) throw new Error("SSM parameter NEON_SSM_PARAM is empty");
	return res.Parameter.Value;
}

export async function getDb(): Promise<Db> {
	if (_db) return _db;

	const connectionString = await resolveConnectionString();

	// neon() uses Neon's HTTP driver — no persistent TCP connection, no pool.
	// Ideal for Lambda: cold start is fast, no connection leaks on timeout.
	// drizzle() wraps it and receives the full schema for the relational query API.
	_db = drizzle(neon(connectionString), { schema });
	return _db;
}
