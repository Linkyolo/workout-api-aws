import { SQSEvent, SQSBatchResponse, Context } from "aws-lambda";
import { eq, sql } from "drizzle-orm";
import { exerciseEntry, getDb } from "../../db/client";

interface AddEntryPayload {
  type: "ADD_ENTRY";
  workoutId: string;
  weId: string;
  entry: {
    reps?: number;
    weightKg?: number;
    durationSecs?: number;
    distanceKm?: number;
  };
  requestId?: string;
}

export async function handler(
  event: SQSEvent,
  _ctx: Context,
): Promise<SQSBatchResponse> {
  console.log(`SQS trigger — batch size: ${event.Records.length}`);
  const db = await getDb();
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.body) as AddEntryPayload;

      switch (message.type) {
        case "ADD_ENTRY": {
          const { weId, entry } = message;

          const [{ nextNum }] = await db
            .select({
              nextNum: sql<number>`COALESCE(MAX(${exerciseEntry.entryNumber}), 0) + 1`,
            })
            .from(exerciseEntry)
            .where(eq(exerciseEntry.workoutExerciseId, weId));

          await db.insert(exerciseEntry).values({
            workoutExerciseId: weId,
            entryNumber: nextNum,
            reps: entry.reps ?? null,
            weightKg: entry.weightKg?.toString() ?? null,
            durationSecs: entry.durationSecs ?? null,
            distanceKm: entry.distanceKm?.toString() ?? null,
          });
          break;
        }
        default:
          console.warn("Unknown message type:", (message as any)?.type);
      }
    } catch (err) {
      console.error(`Failed to process SQS record ${record.messageId}:`, err);
      // Segnala solo il record fallito per consentirne il retry selettivo da parte di SQS
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
