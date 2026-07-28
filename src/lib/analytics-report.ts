/**
 * Gera o PDF do relatório de Analytics + Insights IA.
 *
 * Monta o `AnalyticsReportDocument` fora da tela, captura com html2canvas e
 * pagina em A4 quebrando entre blocos (`[data-report-block]`) para não cortar
 * um card ao meio.
 */

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import { AnalyticsReportDocument, type ReportData } from "@/components/analytics/AnalyticsReportDocument";

const A4_W = 794;   // px @96dpi
const A4_H = 1123;  // px @96dpi
const SCALE = 2;

function slugify(value: string): string {
  return (value || "empresa")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "empresa";
}

async function nextFrame() {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
}

export async function downloadAnalyticsReportPdf(data: ReportData): Promise<void> {
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-20000px;top:0;width:${A4_W}px;background:#ffffff;z-index:-1;`;
  document.body.appendChild(host);

  const root = createRoot(host);
  try {
    root.render(createElement(AnalyticsReportDocument, { data }));
    await nextFrame();
    try { await (document as unknown as { fonts?: { ready?: Promise<unknown> } }).fonts?.ready; } catch { /* noop */ }
    await nextFrame();

    const canvas = await html2canvas(host, {
      scale: SCALE,
      backgroundColor: "#ffffff",
      useCORS: true,
      logging: false,
      windowWidth: A4_W,
    });

    // Quebras de página: nunca cortar um bloco ao meio.
    const hostTop = host.getBoundingClientRect().top;
    const blocks = Array.from(host.querySelectorAll<HTMLElement>("[data-report-block]")).map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top - hostTop, bottom: r.bottom - hostTop };
    });

    const totalHeight = host.scrollHeight;
    const breaks: number[] = [0];
    let cursor = 0;
    while (cursor < totalHeight - 1) {
      const limit = cursor + A4_H;
      if (limit >= totalHeight) break;
      const fitting = blocks.filter((b) => b.bottom <= limit && b.bottom > cursor);
      const next = fitting.length ? fitting[fitting.length - 1].bottom : limit;
      cursor = next > cursor ? next : limit;
      breaks.push(cursor);
    }

    const pdf = new jsPDF({ unit: "px", format: [A4_W, A4_H], orientation: "portrait" });

    for (let i = 0; i < breaks.length; i++) {
      const start = breaks[i];
      const end = i + 1 < breaks.length ? breaks[i + 1] : totalHeight;
      const sliceH = Math.max(1, Math.round((end - start) * SCALE));
      const page = document.createElement("canvas");
      page.width = canvas.width;
      page.height = sliceH;
      const ctx = page.getContext("2d");
      if (!ctx) continue;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, page.width, page.height);
      ctx.drawImage(canvas, 0, Math.round(start * SCALE), canvas.width, sliceH, 0, 0, canvas.width, sliceH);

      if (i > 0) pdf.addPage([A4_W, A4_H], "portrait");
      pdf.addImage(page.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, A4_W, sliceH / SCALE);
    }

    const d = data.generatedAt;
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    pdf.save(`analytics-${slugify(data.companyName)}-${stamp}.pdf`);
  } finally {
    root.unmount();
    host.remove();
  }
}
