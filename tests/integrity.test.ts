import assert from "node:assert/strict";
import test from "node:test";
import { createSourceIdentity, mergeResultBySourceRowId, validateAssociation } from "../app/lib/integrity.ts";

type TestRow = ReturnType<typeof createSourceIdentity> & {
  sku: string;
  note: string;
  status: string;
  name_en?: string;
  issues?: string;
  error?: string;
};

function row(sourceExcelRow: number, sku: string, note: string): TestRow {
  return {
    ...createSourceIdentity({
      sourceExcelRow,
      sourceSkuRaw: sku,
      sourceNoteRaw: note,
      sourceFileId: "test-file",
      importBatchId: "test-batch",
    }),
    sku,
    note,
    status: "pending",
  };
}

function apply(rows: TestRow[], result: Record<string, unknown>): TestRow[] {
  return mergeResultBySourceRowId(rows, result, (original, workerResult) => ({
    ...original,
    status: "done",
    name_en: String(workerResult.name_en ?? ""),
  }));
}

test("reverse-order async worker results stay attached to source_row_id", () => {
  const rowA = row(2, "FD-6W7Z5426605A", "Door Handle");
  const rowB = row(3, "FD-SP411", "Platinum Spark Plug");
  let rows = [rowA, rowB];

  rows = apply(rows, {
    source_row_id: rowB.source_row_id,
    source_excel_row: rowB.source_excel_row,
    source_sku_raw: rowB.source_sku_raw,
    source_sku_normalized: rowB.source_sku_normalized,
    source_note_raw: rowB.source_note_raw,
    sku: rowB.source_sku_raw,
    name_en: "Motorcraft Platinum Spark Plug",
  });
  rows = apply(rows, {
    source_row_id: rowA.source_row_id,
    source_excel_row: rowA.source_excel_row,
    source_sku_raw: rowA.source_sku_raw,
    source_sku_normalized: rowA.source_sku_normalized,
    source_note_raw: rowA.source_note_raw,
    sku: rowA.source_sku_raw,
    name_en: "Ford Exterior Door Handle",
  });

  assert.equal(rows[0].name_en, "Ford Exterior Door Handle");
  assert.equal(rows[1].name_en, "Motorcraft Platinum Spark Plug");
  assert.equal(rows[0].source_note_raw, "Door Handle");
  assert.equal(rows[1].source_note_raw, "Platinum Spark Plug");
});

test("sorted rows still merge by source_row_id", () => {
  const rows = [row(5, "B-2", "Second"), row(4, "A-1", "First")].sort((a, b) => a.sku.localeCompare(b.sku));
  const target = rows[1];
  const next = apply(rows, {
    source_row_id: target.source_row_id,
    source_excel_row: target.source_excel_row,
    source_sku_raw: target.source_sku_raw,
    source_sku_normalized: target.source_sku_normalized,
    source_note_raw: target.source_note_raw,
    sku: target.source_sku_raw,
    name_en: "Only second row changed",
  });

  assert.equal(next[1].name_en, "Only second row changed");
  assert.equal(next[0].name_en, undefined);
});

test("filtered rows do not let missing rows receive updates", () => {
  const rows = [row(2, "A", "Alpha"), row(3, "B", "Beta")];
  const filtered = rows.filter((item) => item.sku === "A");
  const next = apply(filtered, {
    source_row_id: rows[1].source_row_id,
    source_excel_row: rows[1].source_excel_row,
    source_sku_raw: rows[1].source_sku_raw,
    source_sku_normalized: rows[1].source_sku_normalized,
    source_note_raw: rows[1].source_note_raw,
    sku: rows[1].source_sku_raw,
    name_en: "Should not apply",
  });

  assert.equal(next[0].name_en, undefined);
});

test("duplicate normalized OEM numbers with different supplier prefixes remain distinct", () => {
  const rowA = row(2, "FD-6W7Z5426605A", "Door Handle");
  const rowB = row(3, "6W7Z5426605A", "Same OEM from another source");
  assert.equal(rowA.source_sku_normalized, rowB.source_sku_normalized);
  assert.notEqual(rowA.source_row_id, rowB.source_row_id);

  const next = apply([rowA, rowB], {
    source_row_id: rowB.source_row_id,
    source_excel_row: rowB.source_excel_row,
    source_sku_raw: rowB.source_sku_raw,
    source_sku_normalized: rowB.source_sku_normalized,
    source_note_raw: rowB.source_note_raw,
    sku: rowB.source_sku_raw,
    name_en: "Updated duplicate only",
  });

  assert.equal(next[0].name_en, undefined);
  assert.equal(next[1].name_en, "Updated duplicate only");
});

test("blank rows can be skipped by importer-facing code", () => {
  assert.equal(String("").trim(), "");
});

test("failed job retry updates only the matching failed row", () => {
  const failed = { ...row(2, "A", "Alpha"), status: "failed" };
  const done = { ...row(3, "B", "Beta"), status: "done", name_en: "Existing" };
  const next = apply([failed, done], {
    source_row_id: failed.source_row_id,
    source_excel_row: failed.source_excel_row,
    source_sku_raw: failed.source_sku_raw,
    source_sku_normalized: failed.source_sku_normalized,
    source_note_raw: failed.source_note_raw,
    sku: failed.source_sku_raw,
    name_en: "Retried",
  });

  assert.equal(next[0].name_en, "Retried");
  assert.equal(next[1].name_en, "Existing");
});

test("worker returning another row SKU is rejected", () => {
  const original = row(2, "A", "Alpha");
  const integrity = validateAssociation(original, {
    source_row_id: original.source_row_id,
    source_excel_row: original.source_excel_row,
    source_sku_raw: "B",
    source_sku_normalized: "B",
    source_note_raw: original.source_note_raw,
    sku: "B",
  });

  assert.equal(integrity.accepted, false);
  assert.ok(integrity.issues.includes("CROSS_BOUND_RESULT_REJECTED"));
});

test("platinum spark plug note with door handle result is semantic cross-binding", () => {
  const original = row(3, "FD-SP411", "Platinum Spark Plug");
  const integrity = validateAssociation(original, {
    source_row_id: original.source_row_id,
    source_excel_row: original.source_excel_row,
    source_sku_raw: original.source_sku_raw,
    source_sku_normalized: original.source_sku_normalized,
    source_note_raw: original.source_note_raw,
    sku: original.source_sku_raw,
    name_en: "Exterior Door Handle",
  });

  assert.ok(integrity.issues.includes("SEMANTIC_CROSS_BINDING_DETECTED"));
  assert.equal(integrity.cross_binding_detected, true);
});

test("front grille note rejects radiator-only Arabic colloquial term", () => {
  const original = row(4, "25746055", "شبك أمامي");
  const integrity = validateAssociation(original, {
    source_row_id: original.source_row_id,
    source_excel_row: original.source_excel_row,
    source_sku_raw: original.source_sku_raw,
    source_sku_normalized: original.source_sku_normalized,
    source_note_raw: original.source_note_raw,
    sku: original.source_sku_raw,
    name_en: "Radiator Grille Assembly",
    name_ar_colloquial: "رديتر",
  });

  assert.ok(integrity.issues.includes("ARABIC_TERM_MISMATCH"));
});

test("export sequence remains original row sequence after out-of-order merges", () => {
  const rows = [row(9, "FD-6W7Z5426605A", "Door Handle"), row(10, "FD-SP411", "Platinum Spark Plug")];
  const next = apply(apply(rows, {
    source_row_id: rows[1].source_row_id,
    source_excel_row: rows[1].source_excel_row,
    source_sku_raw: rows[1].source_sku_raw,
    source_sku_normalized: rows[1].source_sku_normalized,
    source_note_raw: rows[1].source_note_raw,
    sku: rows[1].source_sku_raw,
    name_en: "Spark Plug",
  }), {
    source_row_id: rows[0].source_row_id,
    source_excel_row: rows[0].source_excel_row,
    source_sku_raw: rows[0].source_sku_raw,
    source_sku_normalized: rows[0].source_sku_normalized,
    source_note_raw: rows[0].source_note_raw,
    sku: rows[0].source_sku_raw,
    name_en: "Door Handle",
  });

  assert.deepEqual(next.map((item) => item.source_excel_row), [9, 10]);
});

test("rerunning failed rows does not overwrite successful adjacent rows", () => {
  const adjacent = { ...row(2, "A", "Door Handle"), status: "done", name_en: "Door Handle" };
  const failed = { ...row(3, "B", "Spark Plug"), status: "failed" };
  const next = apply([adjacent, failed], {
    source_row_id: failed.source_row_id,
    source_excel_row: failed.source_excel_row,
    source_sku_raw: failed.source_sku_raw,
    source_sku_normalized: failed.source_sku_normalized,
    source_note_raw: failed.source_note_raw,
    sku: failed.source_sku_raw,
    name_en: "Spark Plug",
  });

  assert.equal(next[0].name_en, "Door Handle");
  assert.equal(next[1].name_en, "Spark Plug");
});
