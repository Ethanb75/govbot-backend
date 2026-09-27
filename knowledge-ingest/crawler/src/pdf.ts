import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { extractText } from "unpdf";

const run = promisify(execFile);

// Pages are rasterised at this DPI before OCR - tesseract is most accurate around 300.
const OCR_DPI = 300;
const OCR_LANGUAGE = "eng";

export type TextExtraction = "text_layer" | "ocr" | "none";

export interface PdfText {
    text: string;
    extraction: TextExtraction;
}

const normalizePage = (text: string): string =>
    text
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map(line => line.replace(/\s+$/, ""))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

const joinPages = (pages: string[]): string =>
    pages
        .map(normalizePage)
        .filter(page => page.length > 0)
        .join("\n\n");

const extractTextLayer = async (pdf: Uint8Array): Promise<string> => {
    // pdf.js takes ownership of (and detaches) the buffer it is given, so hand it a copy.
    const { text } = await extractText(new Uint8Array(pdf), { mergePages: false });
    return joinPages(text);
};

// Renders every page with poppler's pdftoppm, then OCRs each image with tesseract.
const ocr = async (pdf: Uint8Array, signal: AbortSignal): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "crawler-ocr-"));

    try {
        const pdfPath = join(dir, "document.pdf");
        await writeFile(pdfPath, pdf);
        await run("pdftoppm", ["-r", String(OCR_DPI), "-gray", "-png", pdfPath, join(dir, "page")], { signal });

        // pdftoppm zero-pads page numbers to the page count's width, but sort numerically anyway.
        const images = (await readdir(dir))
            .filter(name => name.endsWith(".png"))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

        const pages: string[] = [];
        for (const image of images) {
            const { stdout } = await run("tesseract", [join(dir, image), "stdout", "-l", OCR_LANGUAGE], {
                signal,
                maxBuffer: 16 * 1024 * 1024,
            });
            pages.push(stdout);
        }

        return joinPages(pages);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
};

// Most government PDFs are scans with no text layer, so fall back to OCR when pdf.js finds nothing.
// TODO - do pdfs sometimes have embedded text and image text together
export const extractPdfText = async (pdf: Uint8Array, signal: AbortSignal): Promise<PdfText> => {
    const text = await extractTextLayer(pdf);
    if (text) return { text, extraction: "text_layer" };

    const ocrText = await ocr(pdf, signal);
    return { text: ocrText, extraction: ocrText ? "ocr" : "none" };
};

// Fail the run up front rather than once per scanned document when the OCR tools are missing.
export const checkOcrTools = async (): Promise<void> => {
    for (const [command, args] of [["pdftoppm", ["-v"]], ["tesseract", ["--version"]]] as const) {
        try {
            await run(command, [...args]);
        } catch (error) {
            throw new Error(`OCR needs ${command} on the PATH (poppler-utils / tesseract-ocr): ${error}`);
        }
    }
};
