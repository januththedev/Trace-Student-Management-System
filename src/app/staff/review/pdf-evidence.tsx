"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist/types/src/display/api";
import { Alert, Button } from "@/components/ui";

const MAX_CANVAS_PIXELS = 8_000_000;

export function PdfEvidence({ src, zoom, rotation, fit, label }: { src: string; zoom: number; rotation: number; fit: boolean; label: string }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderRef = useRef<RenderTask | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [frameWidth, setFrameWidth] = useState(0);
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(([entry]) => setFrameWidth(entry.contentRect.width));
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset the viewer while the new evidence loads
    setDoc(null);
    setPageNumber(1);
    setLoading(true);
    setError(null);
    renderRef.current?.cancel();

    void (async () => {
      try {
        const response = await fetch(src, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("The PDF could not be loaded. Use Open original to view it.");
        if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/pdf")) {
          throw new Error("The evidence response is not a PDF. Use Open original to inspect it.");
        }
        const contentLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > 20 * 1024 * 1024) throw new Error("This PDF exceeds the review viewer's size limit. Use Open original to view it.");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("This PDF exceeds the review viewer's size limit. Use Open original to view it.");
        if (controller.signal.aborted) return;

        const pdfjs = await import("pdfjs-dist");
        if (controller.signal.aborted) return;
        pdfjs.GlobalWorkerOptions.workerSrc = `/vendor/pdfjs/${pdfjs.version}/pdf.worker.min.mjs`;
        loadingTask = pdfjs.getDocument({
          data: bytes,
          cMapUrl: `/vendor/pdfjs/${pdfjs.version}/cmaps/`,
          standardFontDataUrl: `/vendor/pdfjs/${pdfjs.version}/standard_fonts/`,
          wasmUrl: `/vendor/pdfjs/${pdfjs.version}/wasm/`,
          cMapPacked: true,
          enableXfa: false,
          stopAtErrors: true,
          canvasMaxAreaInBytes: MAX_CANVAS_PIXELS * 4,
          disableWorkerRendering: true,
        });
        const documentProxy = await loadingTask.promise;
        if (!alive) {
          await loadingTask.destroy();
          return;
        }
        setDoc(documentProxy);
      } catch (cause) {
        if (alive && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not display this PDF. Use Open original to view it.");
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
      controller.abort();
      renderRef.current?.cancel();
      if (loadingTask) void loadingTask.destroy();
    };
  }, [src]);

  useEffect(() => {
    if (!doc || !canvasRef.current || frameWidth <= 0) return;
    let alive = true;
    let page: PDFPageProxy | null = null;
    let task: RenderTask | null = null;
    const canvas = canvasRef.current;
    const priorRender = renderRef.current;
    priorRender?.cancel();
    setRendering(true);
    setError(null);

    void (async () => {
      try {
        if (priorRender) await priorRender.promise.catch(() => undefined);
        if (!alive) return;
        page = await doc.getPage(pageNumber);
        if (!alive) return;
        const pageRotation = ((page.rotate + rotation) % 360 + 360) % 360;
        const unitViewport = page.getViewport({ scale: 1, rotation: pageRotation });
        const fitScale = frameWidth / unitViewport.width;
        const scale = fit ? fitScale : fitScale * zoom;
        const viewport = page.getViewport({ scale, rotation: pageRotation });
        const outputScale = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
        canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
        canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("This browser cannot render the PDF canvas.");
        task = page.render({ canvas, canvasContext: context, viewport, transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0], background: "#ffffff" });
        renderRef.current = task;
        await task.promise;
        if (alive) setRendering(false);
      } catch (cause) {
        if (alive && !(cause instanceof Error && cause.name === "RenderingCancelledException")) {
          setError(cause instanceof Error ? cause.message : "Could not render this PDF page. Use Open original to view it.");
          setRendering(false);
        }
      } finally {
        if (renderRef.current === task) renderRef.current = null;
      }
    })();

    return () => {
      alive = false;
      task?.cancel();
      if (task) void task.promise.catch(() => undefined).finally(() => page?.cleanup());
      else page?.cleanup();
    };
  }, [doc, pageNumber, frameWidth, zoom, rotation, fit]);

  return (
    <section aria-label={label} className="min-w-0">
      <div className="flex flex-wrap items-center justify-center gap-2 border-b border-line bg-surface px-3 py-2">
        <Button variant="secondary" className="min-h-11 min-w-11" onClick={() => setPageNumber((n) => Math.max(1, n - 1))} disabled={!doc || pageNumber <= 1} aria-label="Previous PDF page">Previous</Button>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <span className="sr-only">PDF page</span>
          <input aria-label="PDF page number" className="h-11 w-16 rounded-md border border-line bg-card text-center font-mono" type="number" min={1} max={doc?.numPages ?? 1} value={pageNumber} disabled={!doc} onChange={(event) => {
            const value = Number(event.currentTarget.value);
            if (Number.isInteger(value) && value >= 1 && value <= (doc?.numPages ?? 1)) setPageNumber(value);
          }} />
          <span>of {doc?.numPages ?? "…"}</span>
        </label>
        <Button variant="secondary" className="min-h-11 min-w-11" onClick={() => setPageNumber((n) => Math.min(doc?.numPages ?? n, n + 1))} disabled={!doc || pageNumber >= doc.numPages} aria-label="Next PDF page">Next</Button>
      </div>
      <div ref={frameRef} tabIndex={0} className="relative flex h-[50vh] min-w-0 overflow-auto bg-[#2a3a41] lg:h-[min(65vh,680px)]" aria-busy={loading || rendering}>
        <canvas ref={canvasRef} aria-label={`${label}, PDF page ${pageNumber} of ${doc?.numPages ?? "loading"}`} className={`mx-auto my-3 shrink-0 bg-white shadow-md ${rendering || loading || error ? "invisible" : ""}`} />
        {(loading || (doc && rendering)) && !error ? <p role="status" className="absolute inset-0 flex items-center justify-center p-4 text-sm text-white">{loading ? "Loading PDF…" : `Rendering page ${pageNumber} of ${doc?.numPages}…`}</p> : null}
        {error ? <div className="absolute inset-0 flex items-center justify-center p-4"><Alert tone="bad">{error}</Alert></div> : null}
      </div>
    </section>
  );
}
