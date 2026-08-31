import { createHash } from "node:crypto";

import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lte,
  not,
  or,
  sql,
} from "drizzle-orm";
import { validate as validateUuid } from "uuid";

import { LABEL_PREVIEW_STALE_ERROR } from "@invook/contracts";

import {
  getDatabase,
  type Database,
  type DatabaseExecutor,
} from "./client";
import {
  labelPreviewReceipts,
  historicalThreadLabelScans,
  type LabelPreviewReceiptResult,
} from "./schema";

export const LABEL_PREVIEW_RECEIPT_LIMIT = 100;
export const LABEL_PREVIEW_RECEIPT_LIFETIME_MS = 15 * 60 * 1_000;
const LABEL_PREVIEW_RECEIPT_CLEANUP_LIMIT = 100;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export class LabelPreviewReceiptConflictError extends Error {
  constructor() {
    super(LABEL_PREVIEW_STALE_ERROR);
    this.name = "LabelPreviewReceiptConflictError";
  }
}

function normalizeDefinitionValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function customLabelDefinitionHash(input: {
  name: string;
  description: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        contractVersion: 1,
        name: normalizeDefinitionValue(input.name),
        description: normalizeDefinitionValue(input.description),
      }),
    )
    .digest("hex");
}

function validateReceiptResults(value: unknown): LabelPreviewReceiptResult[] {
  if (!Array.isArray(value)) {
    throw new Error("A label preview receipt result is invalid.");
  }
  if (value.length > LABEL_PREVIEW_RECEIPT_LIMIT) {
    throw new Error("A label preview receipt cannot contain more than 100 results.");
  }
  const threadIds = new Set<string>();
  const results: LabelPreviewReceiptResult[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") {
      throw new Error("A label preview receipt result is invalid.");
    }
    const threadId = "threadId" in candidate ? candidate.threadId : null;
    const classifierInputHash =
      "classifierInputHash" in candidate
        ? candidate.classifierInputHash
        : null;
    const matched = "matched" in candidate ? candidate.matched : null;
    const confidence = "confidence" in candidate ? candidate.confidence : null;
    const modelId = "modelId" in candidate ? candidate.modelId : null;
    if (
      typeof threadId !== "string" ||
      !validateUuid(threadId) ||
      threadIds.has(threadId) ||
      typeof classifierInputHash !== "string" ||
      !SHA256_PATTERN.test(classifierInputHash) ||
      typeof matched !== "boolean" ||
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 100 ||
      typeof modelId !== "string" ||
      !modelId.trim()
    ) {
      throw new Error("A label preview receipt result is invalid.");
    }
    threadIds.add(threadId);
    results.push({
      threadId,
      classifierInputHash,
      matched,
      confidence,
      modelId,
    });
  }
  return results;
}

export async function createLabelPreviewReceipt(
  input: {
    userId: string;
    accountId: string;
    name: string;
    description: string;
    results: LabelPreviewReceiptResult[];
    createdAt?: Date;
  },
  database: Database = getDatabase(),
): Promise<{ id: string; expiresAt: Date }> {
  const results = validateReceiptResults(input.results);
  const createdAt = input.createdAt ?? new Date();
  const expiresAt = new Date(
    createdAt.getTime() + LABEL_PREVIEW_RECEIPT_LIFETIME_MS,
  );
  const [receipt] = await database
    .insert(labelPreviewReceipts)
    .values({
      userId: input.userId,
      accountId: input.accountId,
      definitionHash: customLabelDefinitionHash(input),
      scannedThreadCount: results.length,
      results,
      expiresAt,
      createdAt,
      updatedAt: createdAt,
    })
    .returning({ id: labelPreviewReceipts.id });
  if (!receipt) throw new Error("The label preview receipt could not be saved.");
  return { id: receipt.id, expiresAt };
}

export async function consumeLabelPreviewReceipt(
  input: {
    receiptId: string;
    userId: string;
    accountId: string;
    name: string;
    description: string;
    historicalScanId: string;
    consumedAt: Date;
  },
  database: DatabaseExecutor,
): Promise<void> {
  const [receipt] = await database
    .select({
      id: labelPreviewReceipts.id,
      definitionHash: labelPreviewReceipts.definitionHash,
      expiresAt: labelPreviewReceipts.expiresAt,
      consumedScanId: labelPreviewReceipts.consumedScanId,
    })
    .from(labelPreviewReceipts)
    .where(
      and(
        eq(labelPreviewReceipts.id, input.receiptId),
        eq(labelPreviewReceipts.userId, input.userId),
        eq(labelPreviewReceipts.accountId, input.accountId),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !receipt ||
    receipt.consumedScanId !== null ||
    receipt.expiresAt.getTime() <= input.consumedAt.getTime() ||
    receipt.definitionHash !== customLabelDefinitionHash(input)
  ) {
    throw new LabelPreviewReceiptConflictError();
  }
  const [consumed] = await database
    .update(labelPreviewReceipts)
    .set({
      consumedScanId: input.historicalScanId,
      updatedAt: input.consumedAt,
    })
    .where(
      and(
        eq(labelPreviewReceipts.id, receipt.id),
        isNull(labelPreviewReceipts.consumedScanId),
      ),
    )
    .returning({ id: labelPreviewReceipts.id });
  if (!consumed) throw new LabelPreviewReceiptConflictError();
}

export async function deleteExpiredLabelPreviewReceipts(
  database: Database = getDatabase(),
): Promise<number> {
  return database.transaction(async (transaction) => {
    const activeScanStep = transaction
      .select({ id: historicalThreadLabelScans.id })
      .from(historicalThreadLabelScans)
      .where(
        and(
          inArray(historicalThreadLabelScans.status, ["queued", "running"]),
          eq(historicalThreadLabelScans.id, labelPreviewReceipts.consumedScanId),
        ),
      )
      .limit(1);
    const receipts = await transaction
      .select({ id: labelPreviewReceipts.id })
      .from(labelPreviewReceipts)
      .where(
        or(
          and(
            isNull(labelPreviewReceipts.consumedScanId),
            lte(labelPreviewReceipts.expiresAt, new Date()),
          ),
          and(
            isNotNull(labelPreviewReceipts.consumedScanId),
            not(exists(activeScanStep)),
          ),
        ),
      )
      .orderBy(asc(labelPreviewReceipts.createdAt))
      .limit(LABEL_PREVIEW_RECEIPT_CLEANUP_LIMIT)
      .for("update", { skipLocked: true });
    if (receipts.length === 0) return 0;
    const deleted = await transaction
      .delete(labelPreviewReceipts)
      .where(
        inArray(
          labelPreviewReceipts.id,
          receipts.map((receipt) => receipt.id),
        ),
      )
      .returning({ id: labelPreviewReceipts.id });
    return deleted.length;
  });
}
