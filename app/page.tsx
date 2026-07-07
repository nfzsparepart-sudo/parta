"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { Download, FileSpreadsheet, Loader2, RotateCcw, UploadCloud } from "lucide-react";

type RowStatus = "pending" | "searching" | "done" | "failed";

type EnrichedPart = {
  sku: string;
  price: string;
  name_en: string;
  name_ar: string;
  name_ar_colloquial: string;
  description: string;
  manufacturer_country: string;
  vehicle_brand: string;
  vehicle_model: string;
  vehicle_year: string;
  image_url: string;
  image_format: string;
  weight_unit: string;
  weight: string;
  confidence: string;
  source_urls: string;
  missing_fields: string;
  needs_review: boolean;
  quality_notes: string;
};

type PartRow = EnrichedPart & {
  status: RowStatus;
  error?: string;
  retry_count?: number;
  error_code?: string;
};

const EMPTY_ENRICHED: Omit<EnrichedPart, "sku"> = {
  price: "",
  name_en: "",
  name_ar: "",
  name_ar_colloquial: "",
  description: "",
  manufacturer_country: "",
  vehicle_brand: "",
  vehicle_model: "",
  vehicle_year: "",
  image_url: "",
  image_format: "",
  weight_unit: "",
  weight: "",
  confidence: "",
  source_urls: "",
  missing_fields: "",
  needs_review: false,
  quality_notes: "",
};

const STATUS_STYLES: Record<RowStatus, string> = {
  pending: "bg-zinc-800 text-zinc-200",
  searching: "bg-red-900 text-red-200",
  done: "bg-red-800 text-red-100",
  failed: "bg-black text-red-300",
};

const MAX_CONCURRENT_REQUESTS = Math.max(1, Number(process.env.NEXT_PUBLIC_MAX_CONCURRENT_GEMINI ?? "3") || 3);
const PRICE_COLUMN_CANDIDATES = ["price", "part_price", "unit_price", "selling_price", "cost", "amount"];

type InputRow = {
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
        if (Array.isArray(parsed) && parsed.length) setRows(parsed);
      }

      const sessionsRaw = localStorage.getItem(SESSIONS_STORAGE_KEY);
      if (sessionsRaw) {
        const parsed = JSON.parse(sessionsRaw) as SavedSession[];
        if (Array.isArray(parsed)) setSavedSessions(parsed);
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

  const parseCsvWithPapa = (text: string): InputRow[] => {
    const parsed = Papa.parse<Record<string, unknown>>(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase(),
    });

    if (parsed.errors.length) {
      throw new Error(parsed.errors[0].message);
    }

    return parsed.data
      .map((r) => {
        const sku = normalizeSku(r.sku);
        if (!sku) return null;

        const priceKey = Object.keys(r).find((k) => PRICE_COLUMN_CANDIDATES.includes(k.trim().toLowerCase()));
        const price = priceKey ? normalizePrice(r[priceKey]) : "";
        return { sku, price };
      })
      .filter((row): row is InputRow => Boolean(row));
  };

  const parseExcelWithXlsx = (arrayBuffer: ArrayBuffer): InputRow[] => {
    const workbook = XLSX.read(arrayBuffer, { type: "array" });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) return [];

    const sheet = workbook.Sheets[firstSheetName];
    const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: "",
    });

    return data
      .map((r) => {
        const skuKey = Object.keys(r).find((k) => k.trim().toLowerCase() === "sku");
        const sku = skuKey ? normalizeSku(r[skuKey]) : "";
        if (!sku) return null;

        const priceKey = Object.keys(r).find((k) => PRICE_COLUMN_CANDIDATES.includes(k.trim().toLowerCase()));
        const price = priceKey ? normalizePrice(r[priceKey]) : "";
        return { sku, price };
      })
      .filter((row): row is InputRow => Boolean(row));
  };

  const handleFile = useCallback(async (file: File) => {
    const lower = file.name.toLowerCase();
    let inputRows: InputRow[] = [];

    if (lower.endsWith(".csv")) {
      const text = await file.text();
      inputRows = parseCsvWithPapa(text);
    } else if (lower.endsWith(".xls") || lower.endsWith(".xlsx")) {
      const buf = await file.arrayBuffer();
      inputRows = parseExcelWithXlsx(buf);
    } else {
      throw new Error("Unsupported file type. Please upload CSV, XLS, or XLSX.");
    }

    if (!inputRows.length) {
      throw new Error("No SKU values found in a column named 'sku'.");
    }

    const deduped = new Map<string, InputRow>();
    for (const row of inputRows) {
      const existing = deduped.get(row.sku);
      if (!existing) {
        deduped.set(row.sku, row);
      } else if (!existing.price && row.price) {
        deduped.set(row.sku, row);
      }
    }

    setRows(Array.from(deduped.values()).map((row) => ({ sku: row.sku, ...EMPTY_ENRICHED, price: row.price, status: "pending" })));
  }, []);

  const processRows = useCallback(async (mode: "all" | "weak" = "all") => {
    stopRequestedRef.current = false;
    setIsStopping(false);
    setIsProcessing(true);
    const queue = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => mode === "all" || row.status === "failed" || row.needs_review)
      .map(({ row, index }) => ({ sku: row.sku, index }));
    let cursor = 0;

    const worker = async () => {
      while (true) {
        if (stopRequestedRef.current) return;
        const current = cursor;
        cursor += 1;
        if (current >= queue.length) return;

        const { sku, index } = queue[current];

        setRows((prev) =>
          prev.map((r, idx) =>
            idx === index
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
            body: JSON.stringify({ sku }),
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
            prev.map((r, idx) =>
              idx === index
                ? {
                    ...r,
                    ...data,
                    price: r.price,
                    status: "done",
                    error: undefined,
                    retry_count: Number(data?.retryCount ?? 0),
                    error_code: undefined,
                    confidence: String(data?.confidence ?? ""),
                    source_urls: String(data?.source_urls ?? ""),
                    missing_fields: String(data?.missing_fields ?? ""),
                    needs_review: Boolean(data?.needs_review),
                    quality_notes: String(data?.quality_notes ?? ""),
                  }
                : r
            )
          );
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            setRows((prev) =>
              prev.map((r, idx) =>
                idx === index
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
            prev.map((r, idx) =>
              idx === index
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
            <table className="min-w-[2100px] table-auto text-left text-sm">
              <thead className="bg-zinc-900 text-red-200">
                <tr>
                  <th className="px-3 py-2">SKU</th>
                  <th className="px-3 py-2">Price</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Confidence</th>
                  <th className="px-3 py-2">Review</th>
                  <th className="px-3 py-2">Missing Fields</th>
                  <th className="px-3 py-2">Quality Notes</th>
                  <th className="px-3 py-2">Sources</th>
                  <th className="px-3 py-2">Name (EN)</th>
                  <th className="px-3 py-2">Name (AR)</th>
                  <th className="px-3 py-2">Saudi Colloquial (AR)</th>
                  <th className="px-3 py-2">Description</th>
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
                  <tr key={`${row.sku}-${idx}`} className="border-t border-zinc-800 align-top">
                    <td className="px-3 py-2 font-medium text-red-100">{row.sku}</td>
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
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
                          row.needs_review ? "bg-yellow-900 text-yellow-100" : "bg-emerald-950 text-emerald-200"
                        }`}
                      >
                        {row.needs_review ? "Needs review" : "OK"}
                      </span>
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
                    <td colSpan={20} className="px-3 py-8 text-center text-red-300">
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
