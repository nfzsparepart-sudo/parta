"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { Download, FileSpreadsheet, Loader2, UploadCloud } from "lucide-react";

type RowStatus = "pending" | "searching" | "done" | "failed";

type EnrichedPart = {
  sku: string;
  name_en: string;
  name_ar: string;
  name_ar_colloquial: string;
  description: string;
  vehicle_brand: string;
  vehicle_model: string;
  vehicle_year: string;
  image_url: string;
  image_format: string;
  weight_unit: string;
  weight: string;
};

type PartRow = EnrichedPart & {
  status: RowStatus;
  error?: string;
  retry_count?: number;
  error_code?: string;
};

const EMPTY_ENRICHED: Omit<EnrichedPart, "sku"> = {
  name_en: "",
  name_ar: "",
  name_ar_colloquial: "",
  description: "",
  vehicle_brand: "",
  vehicle_model: "",
  vehicle_year: "",
  image_url: "",
  image_format: "",
  weight_unit: "",
  weight: "",
};

const STATUS_STYLES: Record<RowStatus, string> = {
  pending: "bg-zinc-800 text-zinc-200",
  searching: "bg-red-900 text-red-200",
  done: "bg-red-800 text-red-100",
  failed: "bg-black text-red-300",
};

const MAX_CONCURRENT_REQUESTS = Math.max(1, Number(process.env.NEXT_PUBLIC_MAX_CONCURRENT_GEMINI ?? "8") || 8);

export default function Page() {
  const [rows, setRows] = useState<PartRow[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const doneCount = useMemo(() => rows.filter((r) => r.status === "done").length, [rows]);
  const failedCount = useMemo(() => rows.filter((r) => r.status === "failed").length, [rows]);
  const allProcessed = rows.length > 0 && rows.every((r) => r.status === "done" || r.status === "failed");

  const normalizeSku = (value: unknown) => String(value ?? "").trim();

  const parseCsvWithPapa = (text: string): string[] => {
    const parsed = Papa.parse<Record<string, unknown>>(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase(),
    });

    if (parsed.errors.length) {
      throw new Error(parsed.errors[0].message);
    }

    return parsed.data
      .map((r) => normalizeSku(r.sku))
      .filter(Boolean);
  };

  const parseExcelWithXlsx = (arrayBuffer: ArrayBuffer): string[] => {
    const workbook = XLSX.read(arrayBuffer, { type: "array" });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) return [];

    const sheet = workbook.Sheets[firstSheetName];
    const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: "",
    });

    return data
      .map((r) => {
        const matchedKey = Object.keys(r).find((k) => k.trim().toLowerCase() === "sku");
        return matchedKey ? normalizeSku(r[matchedKey]) : "";
      })
      .filter(Boolean);
  };

  const handleFile = useCallback(async (file: File) => {
    const lower = file.name.toLowerCase();
    let skus: string[] = [];

    if (lower.endsWith(".csv")) {
      const text = await file.text();
      skus = parseCsvWithPapa(text);
    } else if (lower.endsWith(".xls") || lower.endsWith(".xlsx")) {
      const buf = await file.arrayBuffer();
      skus = parseExcelWithXlsx(buf);
    } else {
      throw new Error("Unsupported file type. Please upload CSV, XLS, or XLSX.");
    }

    if (!skus.length) {
      throw new Error("No SKU values found in a column named 'sku'.");
    }

    const uniqueSkus = Array.from(new Set(skus));

    setRows(uniqueSkus.map((sku) => ({ sku, ...EMPTY_ENRICHED, status: "pending" })));
  }, []);

  const processRows = useCallback(async () => {
    setIsProcessing(true);
    const queue = rows.map((row, index) => ({ sku: row.sku, index }));
    let cursor = 0;

    const worker = async () => {
      while (true) {
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
                }
              : r
          )
        );

        try {
          const res = await fetch("/api/enrich", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sku }),
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
                    status: "done",
                    error: undefined,
                    retry_count: Number(data?.retryCount ?? 0),
                    error_code: undefined,
                  }
                : r
            )
          );
        } catch (err) {
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
    setIsProcessing(false);
  }, [rows]);

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
              <input type="file" accept=".csv,.xls,.xlsx" className="hidden" onChange={onFileInput} />
            </label>
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-700 bg-black/50 p-4 md:p-6">
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="text-sm text-red-200">
              Total: <span className="font-semibold text-red-100">{rows.length}</span> | Done:{" "}
              <span className="font-semibold text-red-300">{doneCount}</span> | Failed:{" "}
              <span className="font-semibold text-red-400">{failedCount}</span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={processRows}
                disabled={!rows.length || isProcessing}
                className="inline-flex items-center gap-2 rounded-xl bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {isProcessing ? "Processing..." : "Start Enrichment"}
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
            </div>
          </div>

          <div className="overflow-auto rounded-xl border border-zinc-700">
            <table className="min-w-[1500px] table-auto text-left text-sm">
              <thead className="bg-zinc-900 text-red-200">
                <tr>
                  <th className="px-3 py-2">SKU</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Name (EN)</th>
                  <th className="px-3 py-2">Name (AR)</th>
                  <th className="px-3 py-2">Saudi Colloquial (AR)</th>
                  <th className="px-3 py-2">Description</th>
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
                    <td colSpan={13} className="px-3 py-8 text-center text-red-300">
                      Upload a file to begin enrichment.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
