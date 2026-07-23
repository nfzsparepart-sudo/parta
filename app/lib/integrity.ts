export type NoteHints = {
  part_hint_ar: string;
  vehicle_make_hint: string;
  vehicle_model_hint: string;
  year_from_hint: number | null;
  year_to_hint: number | null;
  side_hint: "LEFT" | "RIGHT" | null;
  image_expected: boolean | null;
};

export type AssociationChecks = {
  row_id_match: boolean;
  raw_sku_match: boolean;
  normalized_sku_match: boolean;
  note_preserved: boolean;
  excel_row_preserved: boolean;
  category_match: boolean;
  vehicle_match: boolean;
  side_match: boolean;
};

export type SourceIdentity = {
  source_row_id: string;
  source_excel_row: number;
  source_sku_raw: string;
  source_sku_normalized: string;
  source_note_raw: string;
  source_file_id: string;
  import_batch_id: string;
  oem_candidate: string;
  search_variants: string[];
  note_parsed_hints: NoteHints;
};

export type IntegrityResult = {
  accepted: boolean;
  issues: string[];
  association_confidence: number;
  association_checks: AssociationChecks;
  review_reason: string;
  cross_binding_detected: boolean;
};

const PREFIX_PATTERN = /^(?:GG|JJ|FD)[-\s]+/i;

export function createUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export function normalizeSkuForAssociation(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(PREFIX_PATTERN, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
}

export function makeOemCandidate(value: unknown): string {
  const raw = String(value ?? "").trim().replace(PREFIX_PATTERN, "");
  const compact = raw.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  const fordMatch = compact.match(/^([A-Z0-9]{4})([A-Z0-9]{5,8})([A-Z])$/);
  if (fordMatch) return `${fordMatch[1]}-${fordMatch[2]}-${fordMatch[3]}`;
  return raw || compact;
}

export function makeSearchVariants(sourceSkuRaw: string, oemCandidate: string): string[] {
  const compact = normalizeSkuForAssociation(sourceSkuRaw);
  const noPrefix = sourceSkuRaw.trim().replace(PREFIX_PATTERN, "");
  const spaced = oemCandidate.replace(/-/g, " ");
  return Array.from(new Set([sourceSkuRaw.trim(), noPrefix, compact, oemCandidate, `"${spaced}"`].filter(Boolean)));
}

export function parseReviewerNote(value: unknown): NoteHints {
  const note = String(value ?? "").trim();
  const years = note.match(/\b(?:19|20)\d{2}\b/g)?.map(Number) ?? [];
  const lower = note.toLowerCase();
  const right = /(?:\bRH\b|\bright\b|يمين|اليمنى|يميني)/i.test(note);
  const left = /(?:\bLH\b|\bleft\b|يسار|اليسرى|يساري)/i.test(note);
  const noImage = /لا توجد صورة|بدون صورة|no image|no photo/i.test(note);
  const savana = /سفانا|savana/i.test(note);
  const gmcChevy = /سفانا|savana|gmc|chevrolet|chevy/i.test(note);

  return {
    part_hint_ar: note.replace(/\b(?:19|20)\d{2}\b/g, "").replace(/لا توجد صورة|بدون صورة/gi, "").trim(),
    vehicle_make_hint: gmcChevy ? "GMC/Chevrolet" : "",
    vehicle_model_hint: savana ? "Savana" : "",
    year_from_hint: years[0] ?? null,
    year_to_hint: years.length > 1 ? years[years.length - 1] : years[0] ?? null,
    side_hint: right && !left ? "RIGHT" : left && !right ? "LEFT" : null,
    image_expected: noImage ? false : null,
  };
}

export function createSourceIdentity(args: {
  sourceExcelRow: number;
  sourceSkuRaw: string;
  sourceNoteRaw: string;
  sourceFileId: string;
  importBatchId: string;
  sourceRowId?: string;
}): SourceIdentity {
  const oemCandidate = makeOemCandidate(args.sourceSkuRaw);
  return {
    source_row_id: args.sourceRowId || createUuid(),
    source_excel_row: args.sourceExcelRow,
    source_sku_raw: args.sourceSkuRaw,
    source_sku_normalized: normalizeSkuForAssociation(args.sourceSkuRaw),
    source_note_raw: args.sourceNoteRaw,
    source_file_id: args.sourceFileId,
    import_batch_id: args.importBatchId,
    oem_candidate: oemCandidate,
    search_variants: makeSearchVariants(args.sourceSkuRaw, oemCandidate),
    note_parsed_hints: parseReviewerNote(args.sourceNoteRaw),
  };
}

function includesAny(haystack: string, needles: string[]): boolean {
  const normalized = haystack.toLowerCase();
  return needles.some((needle) => needle && normalized.includes(needle.toLowerCase()));
}

export function validateAssociation(
  original: SourceIdentity,
  result: Record<string, unknown>
): IntegrityResult {
  const resultRowId = String(result.source_row_id ?? "");
  const resultRawSku = String(result.source_sku_raw ?? result.sku ?? "");
  const resultNormalizedSku = String(result.source_sku_normalized ?? normalizeSkuForAssociation(resultRawSku));
  const resultNote = String(result.source_note_raw ?? original.source_note_raw);
  const resultExcelRow = Number(result.source_excel_row ?? original.source_excel_row);
  const note = original.source_note_raw;
  const combinedResultText = [
    result.name_en,
    result.name_ar,
    result.name_ar_colloquial,
    result.description,
    result.installation_location,
    result.compatibility,
    result.vehicle_brand,
    result.vehicle_model,
    result.side,
  ]
    .map((part) => String(part ?? ""))
    .join(" ");

  const categoryConflict =
    includesAny(note, ["بلاتينيوم", "بواجي", "spark plug"]) &&
    includesAny(combinedResultText, ["door handle", "handle", "مقبض"]);
  const grilleConflict =
    includesAny(note, ["شبك"]) &&
    ((/\bRadiator\b/i.test(String(result.name_en ?? "")) && !/grille/i.test(String(result.name_en ?? ""))) ||
      (includesAny(String(result.name_ar_colloquial ?? ""), ["رديتر"]) &&
        !includesAny(String(result.name_ar_colloquial ?? ""), ["شبك"])));
  const vehicleConflict =
    Boolean(original.note_parsed_hints.vehicle_model_hint) &&
    !includesAny(combinedResultText, [original.note_parsed_hints.vehicle_model_hint]);
  const sideConflict =
    Boolean(original.note_parsed_hints.side_hint) &&
    /\b(?:LEFT|RIGHT)\b/i.test(combinedResultText) &&
    !includesAny(combinedResultText, [original.note_parsed_hints.side_hint || ""]);

  const association_checks: AssociationChecks = {
    row_id_match: resultRowId === original.source_row_id,
    raw_sku_match: resultRawSku === original.source_sku_raw,
    normalized_sku_match: resultNormalizedSku === original.source_sku_normalized,
    note_preserved: resultNote === original.source_note_raw,
    excel_row_preserved: resultExcelRow === original.source_excel_row,
    category_match: !categoryConflict && !grilleConflict,
    vehicle_match: !vehicleConflict,
    side_match: !sideConflict,
  };

  const issues: string[] = [];
  if (!association_checks.row_id_match || !association_checks.raw_sku_match || !association_checks.normalized_sku_match) {
    issues.push("CROSS_BOUND_RESULT_REJECTED");
  }
  if (!association_checks.note_preserved || !association_checks.excel_row_preserved) {
    issues.push("WRONG_RECORD_ASSOCIATION");
  }
  if (categoryConflict) issues.push("SEMANTIC_CROSS_BINDING_DETECTED");
  if (grilleConflict) issues.push("ARABIC_TERM_MISMATCH");
  if (vehicleConflict) issues.push("REVIEW_NOTE_CONFLICT");
  if (sideConflict) issues.push("SIDE_MISMATCH");

  const failedChecks = Object.values(association_checks).filter((passed) => !passed).length;
  const association_confidence = Math.max(0, 100 - failedChecks * 18 - issues.length * 8);
  const cross_binding_detected = issues.includes("CROSS_BOUND_RESULT_REJECTED") || issues.includes("SEMANTIC_CROSS_BINDING_DETECTED");

  return {
    accepted: !issues.includes("CROSS_BOUND_RESULT_REJECTED"),
    issues,
    association_confidence,
    association_checks,
    review_reason: issues.join(", "),
    cross_binding_detected,
  };
}

export function mergeResultBySourceRowId<T extends {
  source_row_id: string;
  source_excel_row: number;
  source_sku_raw: string;
  source_sku_normalized: string;
  source_note_raw: string;
  source_file_id: string;
  import_batch_id: string;
  oem_candidate: string;
  search_variants: string | string[];
  note_parsed_hints: NoteHints | string;
  status?: string;
  issues?: string;
  error?: string;
}>(
  rows: T[],
  result: Record<string, unknown>,
  applyResult: (row: T, result: Record<string, unknown>, integrity: IntegrityResult) => T
): T[] {
  const rowId = String(result.source_row_id ?? "");
  return rows.map((row) => {
    if (row.source_row_id !== rowId) return row;
    let noteHints = row.note_parsed_hints as NoteHints;
    if (typeof row.note_parsed_hints === "string") {
      try {
        noteHints = JSON.parse(row.note_parsed_hints || "{}") as NoteHints;
      } catch {
        noteHints = parseReviewerNote(row.source_note_raw);
      }
    }
    const integrity = validateAssociation(
      {
        source_row_id: row.source_row_id,
        source_excel_row: row.source_excel_row,
        source_sku_raw: row.source_sku_raw,
        source_sku_normalized: row.source_sku_normalized,
        source_note_raw: row.source_note_raw,
        source_file_id: row.source_file_id,
        import_batch_id: row.import_batch_id,
        oem_candidate: row.oem_candidate,
        search_variants: Array.isArray(row.search_variants) ? row.search_variants : row.search_variants.split(" | "),
        note_parsed_hints: noteHints,
      },
      result
    );
    if (!integrity.accepted) {
      return {
        ...row,
        status: "failed",
        error: "CROSS_BOUND_RESULT_REJECTED",
        issues: [row.issues, ...integrity.issues].filter(Boolean).join(", "),
      };
    }
    return applyResult(row, result, integrity);
  });
}
