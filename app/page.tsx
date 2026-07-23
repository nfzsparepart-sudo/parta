"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { Download, FileSpreadsheet, Loader2, RotateCcw, UploadCloud } from "lucide-react";
import { createSourceIdentity, mergeResultBySourceRowId, type SourceIdentity } from "./lib/integrity";

type RowStatus = "pending" | "searching" | "done" | "failed";

type EnrichedPart = {
  sku: string;
  price: string;
  manufacturer: string;
  name_en: string;
  name_ar: string;
  name_ar_colloquial: string;
  description: string;
  installation_location: string;
  compatibility: string;
  alternative_names: string;
  side: string;
  superseded_by: string;
  manufacturer_country: string;
  country: string;
  vehicle_brand: string;
  vehicle_model: string;
  vehicle_year: string;
  image_url: string;
  image_format: string;
  image_confidence: string;
  translation_confidence: string;
  overall_confidence: string;
  issues: string;
  review_required: boolean;
  sources: string;
  weight_unit: string;
  weight: string;
  confidence: string;
  source_urls: string;
  missing_fields: string;
  needs_review: boolean;
  quality_notes: string;
  source_row_id: string;
  source_excel_row: number;
  source_sku_raw: string;
  source_sku_normalized: string;
  source_note_raw: string;
  source_file_id: string;
  import_batch_id: string;
  oem_candidate: string;
  search_variants: string;
  note_parsed_hints: string;
  association_confidence: string;
  association_checks: string;
  image_status: string;
  review_reason: string;
  cross_binding_detected: boolean;
};

type PartRow = EnrichedPart & {
  status: RowStatus;
  error?: string;
  retry_count?: number;
  error_code?: string;
};

const EMPTY_ENRICHED: Omit<EnrichedPart, "sku"> = {
  price: "",
  manufacturer: "",
  name_en: "",
  name_ar: "",
  name_ar_colloquial: "",
  description: "",
  installation_location: "",
  compatibility: "",
  alternative_names: "",
  side: "",
  superseded_by: "",
  manufacturer_country: "",
  country: "",
  vehicle_brand: "",
  vehicle_model: "",
  vehicle_year: "",
  image_url: "",
  image_format: "",
  image_confidence: "",
  translation_confidence: "",
  overall_confidence: "",
  issues: "",
  review_required: false,
  sources: "",
  weight_unit: "",
  weight: "",
  confidence: "",
  source_urls: "",
  missing_fields: "",
  needs_review: false,
  quality_notes: "",
  source_row_id: "",
  source_excel_row: 0,
  source_sku_raw: "",
  source_sku_normalized: "",
  source_note_raw: "",
  source_file_id: "",
  import_batch_id: "",
  oem_candidate: "",
  search_variants: "",
  note_parsed_hints: "",
  association_confidence: "",
  association_checks: "",
  image_status: "",
  review_reason: "",
  cross_binding_detected: false,
};

const STATUS_STYLES: Record<RowStatus, string> = {
  pending: "bg-zinc-800 text-zinc-200",
  searching: "bg-red-900 text-red-200",
  done: "bg-red-800 text-red-100",
  failed: "bg-black text-red-300",
};

const MAX_CONCURRENT_REQUESTS = Math.max(1, Number(process.env.NEXT_PUBLIC_MAX_CONCURRENT_GEMINI ?? "2") || 2);
const PRICE_COLUMN_CANDIDATES = ["price", "part_price", "unit_price", "selling_price", "cost", "amount"];
const NOTE_COLUMN_CANDIDATES = ["reviewer note", "reviewer_note", "note", "notes", "al", "ملاحظة", "ملاحظات"];

type InputRow = SourceIdentity & {
  sku: string;
  price: string;
};
type SavedSession = {
  id: string;
  name: string;
  createdAt: string;
  rows: PartRow[];
};

const DRAFT_STORAGE_KEY = "nfzalik_draft_rows_v1";
const SESSIONS_STORAGE_KEY = "nfzalik_saved_sessions_v1";

const stringifyList = (value: unknown): string => {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          return [obj.name, obj.title, obj.url].map((part) => String(part ?? "").trim()).filter(Boolean).join(" - ");
        }
        return String(item ?? "");
      })
      .filter(Boolean)
      .join(" | ");
  }

  return String(value ?? "");
};

const ensureRowIdentity = (row: PartRow, index: number): PartRow => {
  if (row.source_row_id && row.source_sku_raw && row.source_sku_normalized) return row;
  const identity = createSourceIdentity({
    sourceExcelRow: row.source_excel_row || index + 2,
    sourceSkuRaw: row.source_sku_raw || row.sku,
    sourceNoteRaw: row.source_note_raw || "",
    sourceFileId: row.source_file_id || "legacy-local-storage",
    importBatchId: row.import_batch_id || "legacy-import",
  });
  return {
    ...row,
    ...identity,
    search_variants: identity.search_variants.join(" | "),
    note_parsed_hints: JSON.stringify(identity.note_parsed_hints),
  };
};

export default function Page() {
  const [rows, setRows] = useState<PartRow[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllersRef = useRef<Set<AbortController>>(new Set());
  const stopRequestedRef = useRef(false);

  const doneCount = useMemo(() => rows.filter((r) => r.status === "done").length, [rows]);
  const failedCount = useMemo(() => rows.filter((r) => r.status === "failed").length, [rows]);
  const reviewCount = useMemo(() => rows.filter((r) => r.needs_review).length, [rows]);
  const allProcessed = rows.length > 0 && rows.every((r) => r.status === "done" || r.status === "failed");

  const normalizeSku = (value: unknown) => String(value ?? "").trim();

  useEffect(() => {
    try {
      const draftRaw = localStorage.getItem(DRAFT_STORAGE_KEY);
      if (draftRaw) {
        const parsed = JSON.parse(draftRaw) as PartRow[];
        if (Array.isArray(parsed) && parsed.length) setRows(parsed.map(ensureRowIdentity));
      }

      const sessionsRaw = localStorage.getItem(SESSIONS_STORAGE_KEY);
      if (sessionsRaw) {
        const parsed = JSON.parse(sessionsRaw) as SavedSession[];
        if (Array.isArray(parsed)) {
          setSavedSessions(parsed.map((session) => ({ ...session, rows: session.rows.map(ensureRowIdentity) })));
        }
      }
    } catch {
      // Ignore invalid persisted storage
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(rows));
    } catch {
      // Ignore storage failures
    }
  }, [rows]);

  const persistSessions = useCallback((next: SavedSession[]) => {
    setSavedSessions(next);
    try {
      localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Ignore storage failures
    }
  }, []);

  const normalizePrice = (value: unknown) => String(value ?? "").trim();
  const normalizeHeader = (value: unknown) => String(value ?? "").trim().toLowerCase();
  const findColumnValue = (row: Record<string, unknown>, candidates: string[]) => {
    const key = Object.keys(row).find((k) => candidates.includes(normalizeHeader(k)));
    return key ? row[key] : "";
  };
  const createFileId = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;
  const createImportBatchId = () => `batch-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const parseCsvWithPapa = (text: string, fileId: string, importBatchId: string): InputRow[] => {
    const parsed = Papa.parse<Record<string, unknown>>(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase(),
    });

    if (parsed.errors.length) {
      throw new Error(parsed.errors[0].message);
    }

    return parsed.data
      .map((r, index) => {
        const sku = normalizeSku(r.sku);
        if (!sku) return null;

        const price = normalizePrice(findColumnValue(r, PRICE_COLUMN_CANDIDATES));
        const note = String(findColumnValue(r, NOTE_COLUMN_CANDIDATES) ?? "").trim();
        const identity = createSourceIdentity({
          sourceExcelRow: index + 2,
          sourceSkuRaw: sku,
          sourceNoteRaw: note,
          sourceFileId: fileId,
          importBatchId,
        });
        return { ...identity, sku, price };
      })
      .filter((row): row is InputRow => Boolean(row));
  };

  const parseExcelWithXlsx = (arrayBuffer: ArrayBuffer, fileId: string, importBatchId: string): InputRow[] => {
    const workbook = XLSX.read(arrayBuffer, { type: "array" });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) return [];

    const sheet = workbook.Sheets[firstSheetName];
    const range = XLSX.utils.decode_range(sheet["!ref"] || "A1:A1");
    const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: "",
    });

    return data
      .map((r) => {
        const skuKey = Object.keys(r).find((k) => k.trim().toLowerCase() === "sku");
        const sku = skuKey ? normalizeSku(r[skuKey]) : "";
        if (!sku) return null;

        const rowNumber = Number((r as { __rowNum__?: number }).__rowNum__ ?? 0) + 1 || 0;
        const noteFromHeader = String(findColumnValue(r, NOTE_COLUMN_CANDIDATES) ?? "").trim();
        const noteCell = rowNumber
          ? sheet[XLSX.utils.encode_cell({ r: rowNumber - 1, c: 37 })]?.v
          : "";
        const note = String(noteFromHeader || noteCell || "").trim();
        const price = normalizePrice(findColumnValue(r, PRICE_COLUMN_CANDIDATES));
        const identity = createSourceIdentity({
          sourceExcelRow: rowNumber || range.s.r + 2,
          sourceSkuRaw: sku,
          sourceNoteRaw: note,
          sourceFileId: fileId,
          importBatchId,
        });
        return { ...identity, sku, price };
      })
      .filter((row): row is InputRow => Boolean(row));
  };

  const handleFile = useCallback(async (file: File) => {
    const lower = file.name.toLowerCase();
    const fileId = createFileId(file);
    const importBatchId = createImportBatchId();
    let inputRows: InputRow[] = [];

    if (lower.endsWith(".csv")) {
      const text = await file.text();
      inputRows = parseCsvWithPapa(text, fileId, importBatchId);
    } else if (lower.endsWith(".xls") || lower.endsWith(".xlsx")) {
      const buf = await file.arrayBuffer();
      inputRows = parseExcelWithXlsx(buf, fileId, importBatchId);
    } else {
      throw new Error("Unsupported file type. Please upload CSV, XLS, or XLSX.");
    }

    if (!inputRows.length) {
      throw new Error("No SKU values found in a column named 'sku'.");
    }

    const uniqueImportKeys = new Set<string>();
    for (const row of inputRows) {
      const key = `${row.import_batch_id}:${row.source_row_id}`;
      if (uniqueImportKeys.has(key)) {
        throw new Error("Duplicate source row identity detected in import batch.");
      }
      uniqueImportKeys.add(key);
    }

    setRows(inputRows.map((row) => ({
      ...EMPTY_ENRICHED,
      ...row,
      price: row.price,
      search_variants: row.search_variants.join(" | "),
      note_parsed_hints: JSON.stringify(row.note_parsed_hints),
      status: "pending",
    })));
  }, []);

  const processRows = useCallback(async (mode: "all" | "weak" = "all") => {
    stopRequestedRef.current = false;
    setIsStopping(false);
    setIsProcessing(true);
    const queue = rows
      .filter((row) => mode === "all" || row.status === "failed" || row.needs_review)
      .map((row) => ({
        source_row_id: row.source_row_id,
        source_excel_row: row.source_excel_row,
        source_sku_raw: row.source_sku_raw || row.sku,
        source_sku_normalized: row.source_sku_normalized,
        source_note_raw: row.source_note_raw,
        source_file_id: row.source_file_id,
        import_batch_id: row.import_batch_id,
        oem_candidate: row.oem_candidate,
        search_variants: row.search_variants,
        note_parsed_hints: row.note_parsed_hints,
      }));
    let cursor = 0;

    const worker = async () => {
      while (true) {
        if (stopRequestedRef.current) return;
        const current = cursor;
        cursor += 1;
        if (current >= queue.length) return;

        const job = queue[current];

        setRows((prev) =>
          prev.map((r, idx) =>
            r.source_row_id === job.source_row_id
              ? {
                  ...r,
                  status: "searching",
                  error: undefined,
                  retry_count: undefined,
                  error_code: undefined,
                  needs_review: false,
                  missing_fields: "",
                  quality_notes: "",
                }
              : r
          )
        );

        try {
          const controller = new AbortController();
          abortControllersRef.current.add(controller);
          const res = await fetch("/api/enrich", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(job),
            signal: controller.signal,
          }).finally(() => {
            abortControllersRef.current.delete(controller);
          });

          const data = await res.json();

          if (!res.ok) {
            const providerStatus = data?.providerStatus ? String(data.providerStatus) : "";
            const msg = data?.error || "Enrichment failed.";
            throw new Error(providerStatus ? `${msg} (provider status: ${providerStatus})` : msg);
          }

          setRows((prev) =>
            mergeResultBySourceRowId(prev, data, (r, result, integrity) => {
              const resultIssues = stringifyList(result?.issues);
              const integrityIssues = integrity.issues.join(", ");
              return {
                    ...r,
                    ...result,
                    price: r.price,
                    status: "done",
                    error: undefined,
                    retry_count: Number(result?.retryCount ?? 0),
                    error_code: undefined,
                    manufacturer: String(result?.manufacturer ?? ""),
                    installation_location: String(result?.installation_location ?? ""),
                    compatibility: stringifyList(result?.compatibility),
                    alternative_names: stringifyList(result?.alternative_names),
                    side: String(result?.side ?? ""),
                    superseded_by: String(result?.superseded_by ?? ""),
                    country: String(result?.country ?? result?.manufacturer_country ?? ""),
                    image_url: String(result?.image_url ?? ""),
                    image_format: String(result?.image_format ?? ""),
                    image_status: String(result?.image_status ?? ""),
                    image_confidence: String(result?.image_confidence ?? ""),
                    translation_confidence: String(result?.translation_confidence ?? ""),
                    overall_confidence: String(result?.overall_confidence ?? result?.confidence ?? ""),
                    issues: [resultIssues, integrityIssues].filter(Boolean).join(", "),
                    review_required: Boolean(result?.review_required) || !integrity.accepted || integrity.issues.length > 0,
                    sources: stringifyList(result?.sources),
                    confidence: String(result?.confidence ?? ""),
                    source_urls: String(result?.source_urls ?? ""),
                    missing_fields: String(result?.missing_fields ?? ""),
                    needs_review: Boolean(result?.needs_review) || integrity.issues.length > 0,
                    quality_notes: String(result?.quality_notes ?? ""),
                    association_confidence: String(integrity.association_confidence),
                    association_checks: JSON.stringify(integrity.association_checks),
                    review_reason: String(result?.review_reason || integrity.review_reason),
                    cross_binding_detected: Boolean(result?.cross_binding_detected) || integrity.cross_binding_detected,
                  };
            })
          );
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            setRows((prev) =>
              prev.map((r) =>
                r.source_row_id === job.source_row_id
                  ? {
                      ...r,
                      status: "pending",
                      error: "Stopped by user.",
                      error_code: "aborted",
                    }
                  : r
              )
            );
            return;
          }

          const message = err instanceof Error ? err.message : "Unknown error";
          const codeMatch = message.match(/provider status:\s*(\d+)/i);
          const errorCode = codeMatch ? codeMatch[1] : undefined;

          setRows((prev) =>
            prev.map((r) =>
              r.source_row_id === job.source_row_id
                ? {
                    ...r,
                    status: "failed",
                    error: message,
                    error_code: errorCode,
                  }
                : r
            )
          );
        }
      }
    };

    const workerCount = Math.min(MAX_CONCURRENT_REQUESTS, queue.length || 1);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    abortControllersRef.current.clear();
    setIsStopping(false);
    setIsProcessing(false);
  }, [rows]);

  const stopProcessing = useCallback(() => {
    stopRequestedRef.current = true;
    setIsStopping(true);
    abortControllersRef.current.forEach((controller) => controller.abort());
    abortControllersRef.current.clear();
  }, []);

  const exportExcel = useCallback(() => {
    const data = rows.map(({ status, error, ...rest }) => ({ ...rest, status, error: error ?? "" }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Enriched Parts");
    XLSX.writeFile(wb, "enriched_spare_parts.xlsx");
  }, [rows]);

  const exportExcelWithMergedVehicle = useCallback(() => {
    const data = rows.map(({ status, error, ...rest }) => {
      const vehicleMerged = [rest.vehicle_brand, rest.vehicle_model, rest.vehicle_year]
        .map((v) => String(v ?? "").trim())
        .filter(Boolean)
        .join(" ");

      return {
        ...rest,
        vehicle_brand_model_year: vehicleMerged,
        status,
        error: error ?? "",
      };
    });

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Enriched Parts");
    XLSX.writeFile(wb, "enriched_spare_parts_with_vehicle_column.xlsx");
  }, [rows]);

  const saveCurrentSession = useCallback(() => {
    if (!rows.length) return;
    const now = new Date();
    const session: SavedSession = {
      id: `${now.getTime()}`,
      name: `Session ${now.toLocaleString()}`,
      createdAt: now.toISOString(),
      rows,
    };
    persistSessions([session, ...savedSessions]);
  }, [persistSessions, rows, savedSessions]);

  const loadSession = useCallback((id: string) => {
    const selected = savedSessions.find((s) => s.id === id);
    if (!selected) return;
    setRows(selected.rows);
  }, [savedSessions]);

  const deleteSession = useCallback((id: string) => {
    persistSessions(savedSessions.filter((s) => s.id !== id));
  }, [persistSessions, savedSessions]);

  const resetAll = useCallback(() => {
    if (!rows.length && !savedSessions.length && !isProcessing) return;
    if (!window.confirm("Reset and clear all rows, saved outputs, and current progress?")) return;

    stopRequestedRef.current = true;
    abortControllersRef.current.forEach((controller) => controller.abort());
    abortControllersRef.current.clear();
    setRows([]);
    setSavedSessions([]);
    setIsProcessing(false);
    setIsStopping(false);
    if (fileInputRef.current) fileInputRef.current.value = "";

    try {
      localStorage.removeItem(DRAFT_STORAGE_KEY);
      localStorage.removeItem(SESSIONS_STORAGE_KEY);
    } catch {
      // Ignore storage failures
    }
  }, [isProcessing, rows.length, savedSessions.length]);

  const onDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);

    const file = e.dataTransfer.files?.[0];
    if (!file) return;

    try {
      await handleFile(file);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to parse file.");
    }
  };

  const onFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      await handleFile(file);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to parse file.");
    }
  };

  const updateRowField = useCallback(
    (index: number, field: keyof EnrichedPart, value: string) => {
      setRows((prev) =>
        prev.map((row, i) =>
          i === index
            ? {
                ...row,
                [field]: value,
              }
            : row
        )
      );
    },
    []
  );

  return (
    <main className="min-h-screen bg-gradient-to-br from-black via-zinc-950 to-red-900 p-6 md:p-10">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight text-red-100">Nefzalik</h1>
          <p className="text-red-200">Upload SKUs, enrich live with Gemini, and export a fresh Excel file.</p>
        </header>

        <section
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
          className={`rounded-2xl border-2 border-dashed p-8 transition ${
            isDragging ? "border-red-500 bg-red-950/40" : "border-zinc-700 bg-black/40"
          }`}
        >
          <div className="flex flex-col items-center justify-center gap-3 text-center">
            <UploadCloud className="h-10 w-10 text-red-200" />
            <div>
              <p className="text-lg font-semibold text-red-100">Drag and drop your file here</p>
              <p className="text-sm text-red-200">Supports `.csv`, `.xls`, `.xlsx` with a `sku` column</p>
            </div>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-600">
              <FileSpreadsheet className="h-4 w-4" />
              Choose file
              <input ref={fileInputRef} type="file" accept=".csv,.xls,.xlsx" className="hidden" onChange={onFileInput} />
            </label>
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-700 bg-black/50 p-4 md:p-6">
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="text-sm text-red-200">
              Total: <span className="font-semibold text-red-100">{rows.length}</span> | Done:{" "}
              <span className="font-semibold text-red-300">{doneCount}</span> | Failed:{" "}
              <span className="font-semibold text-red-400">{failedCount}</span> | Review:{" "}
              <span className="font-semibold text-yellow-200">{reviewCount}</span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => processRows()}
                disabled={!rows.length || isProcessing}
                className="inline-flex items-center gap-2 rounded-xl bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {isProcessing ? "Processing..." : "Start Enrichment"}
              </button>

              <button
                onClick={() => processRows("weak")}
                disabled={!rows.some((row) => row.status === "failed" || row.needs_review) || isProcessing}
                className="inline-flex items-center gap-2 rounded-xl bg-zinc-800 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Retry Review
              </button>

              <button
                onClick={stopProcessing}
                disabled={!isProcessing}
                className="inline-flex items-center gap-2 rounded-xl bg-zinc-800 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isStopping ? "Stopping..." : "Stop"}
              </button>

              <button
                onClick={exportExcel}
                disabled={!allProcessed}
                className="inline-flex items-center gap-2 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Download className="h-4 w-4" />
                Export Excel
              </button>

              <button
                onClick={exportExcelWithMergedVehicle}
                disabled={!allProcessed}
                className="inline-flex items-center gap-2 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Download className="h-4 w-4" />
                Export + Merged Vehicle
              </button>

              <button
                onClick={saveCurrentSession}
                disabled={!rows.length}
                className="inline-flex items-center gap-2 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Save Output
              </button>

              <button
                onClick={resetAll}
                disabled={!rows.length && !savedSessions.length && !isProcessing}
                className="inline-flex items-center gap-2 rounded-xl bg-black px-4 py-2 text-sm font-medium text-red-100 ring-1 ring-red-900 hover:bg-zinc-950 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <RotateCcw className="h-4 w-4" />
                Reset All
              </button>
            </div>
          </div>

          <div className="overflow-auto rounded-xl border border-zinc-700">
            <table className="min-w-[3600px] table-auto text-left text-sm">
              <thead className="bg-zinc-900 text-red-200">
                <tr>
                  <th className="px-3 py-2">SKU</th>
                  <th className="px-3 py-2">Row ID</th>
                  <th className="px-3 py-2">Excel Row</th>
                  <th className="px-3 py-2">Raw SKU</th>
                  <th className="px-3 py-2">Normalized SKU</th>
                  <th className="px-3 py-2">Reviewer Note</th>
                  <th className="px-3 py-2">Price</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Confidence</th>
                  <th className="px-3 py-2">Association Conf.</th>
                  <th className="px-3 py-2">Image Conf.</th>
                  <th className="px-3 py-2">Translation Conf.</th>
                  <th className="px-3 py-2">Image Status</th>
                  <th className="px-3 py-2">Review</th>
                  <th className="px-3 py-2">Review Reason</th>
                  <th className="px-3 py-2">Issues</th>
                  <th className="px-3 py-2">Missing Fields</th>
                  <th className="px-3 py-2">Quality Notes</th>
                  <th className="px-3 py-2">Sources</th>
                  <th className="px-3 py-2">Manufacturer</th>
                  <th className="px-3 py-2">Name (EN)</th>
                  <th className="px-3 py-2">Name (AR)</th>
                  <th className="px-3 py-2">Saudi Colloquial (AR)</th>
                  <th className="px-3 py-2">Description</th>
                  <th className="px-3 py-2">Install Location</th>
                  <th className="px-3 py-2">Compatibility</th>
                  <th className="px-3 py-2">Alt Names</th>
                  <th className="px-3 py-2">Side</th>
                  <th className="px-3 py-2">Superseded By</th>
                  <th className="px-3 py-2">Manufacturer Country</th>
                  <th className="px-3 py-2">Brand</th>
                  <th className="px-3 py-2">Model</th>
                  <th className="px-3 py-2">Vehicle Year</th>
                  <th className="px-3 py-2">Image URL</th>
                  <th className="px-3 py-2">Image Format</th>
                  <th className="px-3 py-2">Weight Unit</th>
                  <th className="px-3 py-2">Weight</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => (
                  <tr key={row.source_row_id || `${row.sku}-${idx}`} className="border-t border-zinc-800 align-top">
                    <td className="px-3 py-2 font-medium text-red-100">{row.sku}</td>
                    <td className="px-3 py-2 text-xs text-red-200">
                      <div className="w-48 break-words">{row.source_row_id}</div>
                    </td>
                    <td className="px-3 py-2 text-red-100">{row.source_excel_row || ""}</td>
                    <td className="px-3 py-2 text-red-100">{row.source_sku_raw}</td>
                    <td className="px-3 py-2 text-red-100">{row.source_sku_normalized}</td>
                    <td className="px-3 py-2 text-xs text-red-200">
                      <div className="w-56 whitespace-pre-wrap">{row.source_note_raw}</div>
                    </td>
                    <td className="px-3 py-2">
                      <input className="w-28 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-red-100" value={row.price} onChange={(e) => updateRowField(idx, "price", e.target.value)} />
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLES[row.status]}`}>
                        {row.status === "searching"
                          ? "Searching"
                          : row.status === "done"
                            ? "Done"
                            : row.status === "failed"
                              ? "Failed"
                              : "Pending"}
                      </span>
                      {row.error ? <p className="mt-1 text-xs text-red-300">{row.error}</p> : null}
                    </td>
                    <td className="px-3 py-2 text-red-100">{row.confidence || ""}</td>
                    <td className="px-3 py-2 text-red-100">{row.association_confidence || ""}</td>
                    <td className="px-3 py-2 text-red-100">{row.image_confidence || ""}</td>
                    <td className="px-3 py-2 text-red-100">{row.translation_confidence || ""}</td>
                    <td className="px-3 py-2 text-red-100">{row.image_status || ""}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
                          row.needs_review || row.review_required ? "bg-yellow-900 text-yellow-100" : "bg-emerald-950 text-emerald-200"
                        }`}
                      >
                        {row.needs_review || row.review_required ? "Needs review" : "OK"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-red-200">
                      <div className="w-64 whitespace-pre-wrap">{row.review_reason || ""}</div>
                    </td>
                    <td className="px-3 py-2 text-xs text-red-200">
                      <div className="w-56 whitespace-pre-wrap">{row.issues || ""}</div>
                    </td>
                    <td className="px-3 py-2 text-xs text-red-200">
                      <div className="w-48 whitespace-pre-wrap">{row.missing_fields || ""}</div>
                    </td>
                    <td className="px-3 py-2 text-xs text-red-200">
                      <div className="w-72 whitespace-pre-wrap">{row.quality_notes || ""}</div>
                    </td>
                    <td className="px-3 py-2 text-xs text-red-200">
                      <div className="w-80 whitespace-pre-wrap break-words">{row.source_urls || ""}</div>
                    </td>
                    <td className="px-3 py-2">
                      <input className="w-36 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-red-100" value={row.manufacturer} onChange={(e) => updateRowField(idx, "manufacturer", e.target.value)} />
                    </td>
                    <td className="px-3 py-2">
                      <input className="w-44 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-red-100" value={row.name_en} onChange={(e) => updateRowField(idx, "name_en", e.target.value)} />
                    </td>
                    <td className="px-3 py-2">
                      <input className="w-44 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-red-100" value={row.name_ar} onChange={(e) => updateRowField(idx, "name_ar", e.target.value)} />
                    </td>
                    <td className="px-3 py-2">
                      <input className="w-44 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-red-100" value={row.name_ar_colloquial} onChange={(e) => updateRowField(idx, "name_ar_colloquial", e.target.value)} />
                    </td>
                    <td className="px-3 py-2">
                      <textarea className="w-64 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-red-100" rows={2} value={row.description} onChange={(e) => updateRowField(idx, "description", e.target.value)} />
                    </td>
                    <td className="px-3 py-2">
                      <input className="w-44 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-red-100" value={row.installation_location} onChange={(e) => updateRowField(idx, "installation_location", e.target.value)} />
                    </td>
                    <td className="px-3 py-2">
                      <textarea className="w-64 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-red-100" rows={2} value={row.compatibility} onChange={(e) => updateRowField(idx, "compatibility", e.target.value)} />
                    </td>
                    <td className="px-3 py-2">
                      <input className="w-52 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-red-100" value={row.alternative_names} onChange={(e) => updateRowField(idx, "alternative_names", e.target.value)} />
                    </td>
                    <td className="px-3 py-2">
                      <input className="w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-red-100" value={row.side} onChange={(e) => updateRowField(idx, "side", e.target.value)} />
                    </td>
                    <td className="px-3 py-2">
                      <input className="w-36 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-red-100" value={row.superseded_by} onChange={(e) => updateRowField(idx, "superseded_by", e.target.value)} />
                    </td>
                    <td className="px-3 py-2">
                      <input className="w-40 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-red-100" value={row.manufacturer_country} onChange={(e) => updateRowField(idx, "manufacturer_country", e.target.value)} />
                    </td>
                    <td className="px-3 py-2">
                      <input className="w-36 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-red-100" value={row.vehicle_brand} onChange={(e) => updateRowField(idx, "vehicle_brand", e.target.value)} />
                    </td>
                    <td className="px-3 py-2">
                      <input className="w-36 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-red-100" value={row.vehicle_model} onChange={(e) => updateRowField(idx, "vehicle_model", e.target.value)} />
                    </td>
                    <td className="px-3 py-2">
                      <input className="w-28 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-red-100" value={row.vehicle_year} onChange={(e) => updateRowField(idx, "vehicle_year", e.target.value)} />
                    </td>
                    <td className="px-3 py-2">
                      <input className="w-72 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-red-100" value={row.image_url} onChange={(e) => updateRowField(idx, "image_url", e.target.value)} />
                    </td>
                    <td className="px-3 py-2">
                      <input className="w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-red-100" value={row.image_format} onChange={(e) => updateRowField(idx, "image_format", e.target.value)} />
                    </td>
                    <td className="px-3 py-2">
                      <input className="w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-red-100" value={row.weight_unit} onChange={(e) => updateRowField(idx, "weight_unit", e.target.value)} />
                    </td>
                    <td className="px-3 py-2">
                      <input className="w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-red-100" value={row.weight} onChange={(e) => updateRowField(idx, "weight", e.target.value)} />
                    </td>
                  </tr>
                ))}
                {!rows.length ? (
                  <tr>
                    <td colSpan={40} className="px-3 py-8 text-center text-red-300">
                      Upload a file to begin enrichment.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-700 bg-black/50 p-4 md:p-6">
          <h2 className="mb-3 text-lg font-semibold text-red-100">Saved Outputs</h2>
          {!savedSessions.length ? (
            <p className="text-sm text-red-300">No saved outputs yet.</p>
          ) : (
            <div className="space-y-2">
              {savedSessions.map((session) => (
                <div key={session.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-700 bg-zinc-900/40 p-3">
                  <div>
                    <p className="text-sm font-medium text-red-100">{session.name}</p>
                    <p className="text-xs text-red-300">{new Date(session.createdAt).toLocaleString()} | Rows: {session.rows.length}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => loadSession(session.id)}
                      className="rounded-lg bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600"
                    >
                      Load
                    </button>
                    <button
                      onClick={() => deleteSession(session.id)}
                      className="rounded-lg bg-zinc-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-600"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
