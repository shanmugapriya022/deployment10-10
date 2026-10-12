import fs from "fs";
import path from "path";
import crypto from "crypto";
import mammoth from "mammoth";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { worksheetToCsv } from "../utils/spreadsheetUtils";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { centralRateController, aiJobManager, classifyGeminiError, getGeminiClient, AI_CONFIG, logAIOperation } from "./centralGeminiService";
import { logger } from "./appLogger";

export interface LargeFileConfig {
  MAX_UPLOAD_SIZE: number;
  MAX_EXTRACTED_TEXT: number;
  CHUNK_SIZE: number;
  CHUNK_OVERLAP: number;
  MAX_CHUNKS: number;
  MAX_PROCESSING_TIME: number;
  STORAGE_DIR: string;
}

export const LARGE_FILE_CONFIG: LargeFileConfig = {
  MAX_UPLOAD_SIZE: 150 * 1024 * 1024, // 150 MB max upload limit (fully supports ~120 MB files)
  MAX_EXTRACTED_TEXT: 50 * 1024 * 1024, // 50 MB extracted text limit
  CHUNK_SIZE: 10000, // ~2,500 tokens per chunk
  CHUNK_OVERLAP: 800, // 800 chars overlap for semantic continuity
  MAX_CHUNKS: 60, // Maximum chunks to process safely in one job
  MAX_PROCESSING_TIME: 600000, // 10 minutes max job execution
  STORAGE_DIR: path.join(process.cwd(), "data", "uploads"),
};

// Ensure upload directory exists
try {
  if (!fs.existsSync(LARGE_FILE_CONFIG.STORAGE_DIR)) {
    fs.mkdirSync(LARGE_FILE_CONFIG.STORAGE_DIR, { recursive: true });
  }
} catch (e) {
  console.warn("[LargeFileService] Upload directory check notice:", e);
}

export interface UploadedFileMetadata {
  fileId: string;
  projectId: string;
  userId: string;
  fileName: string;
  fileSize: number;
  contentType: string;
  storagePath: string;
  status: "UPLOADED" | "PARSED" | "FAILED";
  createdAt: string;
}

export interface ParentTestCaseJob {
  jobId: string;
  projectId: string;
  userId: string;
  fileId: string;
  fileName: string;
  feature: "AI_TEST_CASES" | "AI_SCENARIOS";
  creditFeatureName?: string;
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";
  totalChunks: number;
  completedChunks: number;
  failedChunks: number;
  idempotencyKey: string;
  creditDeducted: boolean;
  stage?: string;
  errorMessage?: string;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
  mergedScenarios?: any[];
}

export interface ChildTestCaseChunk {
  chunkId: string;
  chunkIndex: number;
  sectionTitle: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  attemptCount: number;
  resultLocation?: string;
  results?: any[];
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

const JOBS_FILE_PATH = path.join(process.cwd(), "data", "ai_testcase_jobs.json");
const localJobsStore = new Map<string, ParentTestCaseJob>();

try {
  if (fs.existsSync(JOBS_FILE_PATH)) {
    const raw = fs.readFileSync(JOBS_FILE_PATH, "utf-8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      arr.forEach((j: ParentTestCaseJob) => {
        if (j && j.jobId) localJobsStore.set(j.jobId, j);
      });
    }
  }
} catch (e) {
  console.warn("[LargeFileService] Disk jobs load notice:", e);
}

function persistJobsToDisk() {
  try {
    const dataDir = path.dirname(JOBS_FILE_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const arr = Array.from(localJobsStore.values());
    fs.writeFileSync(JOBS_FILE_PATH, JSON.stringify(arr.slice(-500), null, 2));
  } catch (e) {}
}

export async function saveJobRecord(adminDb: any, parentJob: ParentTestCaseJob): Promise<void> {
  localJobsStore.set(parentJob.jobId, { ...parentJob });
  persistJobsToDisk();

  if (adminDb) {
    try {
      await adminDb.collection("ai_testcase_jobs").doc(parentJob.jobId).set(parentJob, { merge: true });
    } catch (err: any) {
      console.warn(`[LargeFileService] Firestore job save notice (${err?.message || err}): using memory/disk store`);
    }
  }
}

export async function getJobRecord(adminDb: any, jobId: string): Promise<ParentTestCaseJob | null> {
  if (adminDb) {
    try {
      const docSnap = await adminDb.collection("ai_testcase_jobs").doc(jobId).get();
      if (docSnap.exists) {
        const data = docSnap.data() as ParentTestCaseJob;
        localJobsStore.set(jobId, data);
        return data;
      }
    } catch (err: any) {
      console.warn(`[LargeFileService] Firestore job fetch notice (${err?.message || err}): using memory/disk store`);
    }
  }
  return localJobsStore.get(jobId) || null;
}

export async function findJobByIdempotencyKey(adminDb: any, activeKey: string): Promise<ParentTestCaseJob | null> {
  if (adminDb) {
    try {
      const snap = await adminDb.collection("ai_testcase_jobs")
        .where("idempotencyKey", "==", activeKey)
        .limit(1)
        .get();
      if (!snap.empty) {
        const job = snap.docs[0].data() as ParentTestCaseJob;
        localJobsStore.set(job.jobId, job);
        return job;
      }
    } catch (err: any) {
      console.warn(`[LargeFileService] Firestore idempotency query notice (${err?.message || err}): checking memory/disk store`);
    }
  }
  for (const job of localJobsStore.values()) {
    if (job.idempotencyKey === activeKey) {
      return job;
    }
  }
  return null;
}

const UPLOADED_FILES_PATH = path.join(process.cwd(), "data", "uploaded_files.json");
const localUploadedFilesStore = new Map<string, UploadedFileMetadata>();

try {
  if (fs.existsSync(UPLOADED_FILES_PATH)) {
    const raw = fs.readFileSync(UPLOADED_FILES_PATH, "utf-8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      arr.forEach((f: UploadedFileMetadata) => {
        if (f && f.fileId) localUploadedFilesStore.set(f.fileId, f);
      });
    }
  }
} catch (e) {
  console.warn("[LargeFileService] Disk uploaded files load notice:", e);
}

function persistUploadedFilesToDisk() {
  try {
    const dataDir = path.dirname(UPLOADED_FILES_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const arr = Array.from(localUploadedFilesStore.values());
    fs.writeFileSync(UPLOADED_FILES_PATH, JSON.stringify(arr.slice(-500), null, 2));
  } catch (e) {}
}

export async function saveUploadedFileMetadata(adminDb: any, metadata: UploadedFileMetadata): Promise<void> {
  localUploadedFilesStore.set(metadata.fileId, metadata);
  persistUploadedFilesToDisk();
  if (adminDb) {
    try {
      await adminDb.collection("uploaded_files").doc(metadata.fileId).set(metadata);
    } catch (err: any) {
      console.warn(`[LargeFileService] Firestore file metadata save notice (${err?.message || err}): using memory/disk store`);
    }
  }
}

export async function getUploadedFileMetadata(adminDb: any, fileId: string): Promise<UploadedFileMetadata | null> {
  if (adminDb) {
    try {
      const doc = await adminDb.collection("uploaded_files").doc(fileId).get();
      if (doc.exists) {
        const data = doc.data() as UploadedFileMetadata;
        localUploadedFilesStore.set(fileId, data);
        return data;
      }
    } catch (err: any) {
      console.warn(`[LargeFileService] Firestore file metadata fetch notice (${err?.message || err}): checking memory/disk store`);
    }
  }
  return localUploadedFilesStore.get(fileId) || null;
}

/**
 * Validates file extension, size, and content type before processing
 */
export function validateUploadedFile(fileName: string, fileSize: number, contentType?: string): { valid: boolean; error?: string } {
  if (!fileName || typeof fileName !== "string") {
    return { valid: false, error: "Invalid or missing file name." };
  }

  const formattedSize = fileSize < 1024 * 1024
    ? `${(fileSize / 1024).toFixed(1)} KB`
    : `${(fileSize / (1024 * 1024)).toFixed(1)} MB`;

  if (fileSize > LARGE_FILE_CONFIG.MAX_UPLOAD_SIZE) {
    const maxSizeMB = Math.round(LARGE_FILE_CONFIG.MAX_UPLOAD_SIZE / (1024 * 1024));
    return {
      valid: false,
      error: `This file exceeds the supported processing limit (${maxSizeMB} MB max). Your file is ${formattedSize}.`
    };
  }

  const ext = path.extname(fileName).toLowerCase().replace(".", "");
  const allowedExtensions = ["txt", "pdf", "doc", "docx", "xlsx", "csv", "tsv", "md", "json", "log"];

  if (!allowedExtensions.includes(ext)) {
    return {
      valid: false,
      error: `Unsupported file format: .${ext}. Please upload a supported document (.pdf, .docx, .xlsx, .txt, .csv, .md, .json).`
    };
  }

  return { valid: true };
}

/**
 * Server-side controlled text extraction from durable file path
 * Safely handles .pdf, .docx, .xlsx, .txt, .csv, .md, .json
 */
export async function extractTextFromDurableFile(filePath: string, fileName: string): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Uploaded file not found on disk: ${filePath}`);
  }

  const ext = path.extname(fileName).toLowerCase().replace(".", "");
  let extractedText = "";

  try {
    if (["txt", "md", "csv", "tsv", "json", "log"].includes(ext)) {
      // Memory safe streaming or bounded buffer read
      const stats = fs.statSync(filePath);
      if (stats.size > LARGE_FILE_CONFIG.MAX_EXTRACTED_TEXT) {
        // Read first MAX_EXTRACTED_TEXT bytes
        const fd = fs.openSync(filePath, "r");
        const buffer = Buffer.alloc(LARGE_FILE_CONFIG.MAX_EXTRACTED_TEXT);
        fs.readSync(fd, buffer, 0, LARGE_FILE_CONFIG.MAX_EXTRACTED_TEXT, 0);
        fs.closeSync(fd);
        extractedText = buffer.toString("utf-8");
      } else {
        extractedText = fs.readFileSync(filePath, "utf-8");
      }
    } else if (ext === "pdf") {
      const dataBuffer = fs.readFileSync(filePath);
      if (typeof (pdfParse as any).PDFParse === "function") {
        const parser = new (pdfParse as any).PDFParse({ data: dataBuffer });
        const res = await parser.getText();
        extractedText = res?.text || "";
        if (typeof parser.destroy === "function") {
          try { await parser.destroy(); } catch (_) {}
        }
      } else if (typeof pdfParse === "function") {
        const pdfData = await pdfParse(dataBuffer, { max: 0 });
        extractedText = pdfData?.text || "";
      } else if (typeof (pdfParse as any).default === "function") {
        const pdfData = await (pdfParse as any).default(dataBuffer, { max: 0 });
        extractedText = pdfData?.text || "";
      } else {
        extractedText = dataBuffer.toString("utf-8");
      }
    } else if (ext === "docx" || ext === "doc") {
      try {
        const result = await mammoth.extractRawText({ path: filePath });
        extractedText = result?.value || "";
      } catch (pathErr) {
        console.warn(`[LargeFileService] mammoth path extraction notice for ${fileName}, trying buffer:`, pathErr);
        const dataBuffer = fs.readFileSync(filePath);
        const result = await mammoth.extractRawText({ buffer: dataBuffer });
        extractedText = result?.value || "";
      }
      // If mammoth returns empty, use JSZip fallback to parse word/document.xml
      if (!extractedText.trim()) {
        try {
          const dataBuffer = fs.readFileSync(filePath);
          const zip = await JSZip.loadAsync(dataBuffer);
          const docXml = zip.file("word/document.xml");
          if (docXml) {
            const xmlText = await docXml.async("text");
            const textMatches = xmlText.match(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g) || [];
            extractedText = textMatches
              .map(m => m.replace(/<[^>]+>/g, ""))
              .join(" ");
          }
        } catch (zipErr) {
          console.warn(`[LargeFileService] JSZip fallback notice for ${fileName}:`, zipErr);
        }
      }
    } else if (ext === "xlsx") {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(filePath);
      const sheetTexts: string[] = [];
      for (const sheet of workbook.worksheets) {
        const csvContent = worksheetToCsv(sheet);
        if (csvContent && csvContent.trim()) {
          sheetTexts.push(`--- Sheet: ${sheet.name} ---\n${csvContent}`);
        }
      }
      extractedText = sheetTexts.join("\n\n");
    } else {
      // Fallback text read
      extractedText = fs.readFileSync(filePath, "utf-8");
    }
  } catch (extractErr: any) {
    console.error(`[LargeFileService] Content extraction error for ${fileName}:`, extractErr?.message || extractErr);
    throw new Error(`Unable to extract content from the uploaded file (${fileName}): ${extractErr?.message || "File parser encountered an error"}`);
  }

  // Sanitize and clean whitespace
  extractedText = extractedText
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/\0/g, "");

  if (!extractedText.trim()) {
    throw new Error(`Unable to extract content from the uploaded file (${fileName}). The file appears to be empty or contains no extractable text.`);
  }

  // Guard against extreme extracted text
  if (extractedText.length > LARGE_FILE_CONFIG.MAX_EXTRACTED_TEXT) {
    extractedText = extractedText.substring(0, LARGE_FILE_CONFIG.MAX_EXTRACTED_TEXT);
  }

  return extractedText;
}

export interface DocumentChunk {
  chunkIndex: number;
  totalChunks: number;
  sectionTitle: string;
  contextHeader: string;
  content: string;
  fullChunkText: string;
}

/**
 * Intelligent, token-aware chunking with context preservation
 */
export function chunkDocumentText(extractedText: string, fileName: string): DocumentChunk[] {
  const chunkSize = LARGE_FILE_CONFIG.CHUNK_SIZE;
  const chunkOverlap = LARGE_FILE_CONFIG.CHUNK_OVERLAP;

  // Split into raw sections by markdown headers, user story markers, or major paragraph breaks
  const rawSections = extractedText.split(/(?=\n#{1,3}\s+|\n(?:\*{3,}|-{3,}|={3,})\n|\nUser Story\s*[:#-]?|\nUS-\d+|\nSection\s*[:#-]?)/i);

  const mergedBlocks: { title: string; text: string }[] = [];
  let currentBlockText = "";
  let currentTitle = "General Requirements";

  for (const sec of rawSections) {
    const trimmed = sec.trim();
    if (!trimmed) continue;

    // Detect section title
    const firstLine = trimmed.split("\n")[0].replace(/^[#\*\-=\s]+/, "").trim();
    const candidateTitle = firstLine.length < 80 && firstLine.length > 3 ? firstLine : currentTitle;

    if (currentBlockText.length + trimmed.length <= chunkSize) {
      currentBlockText += (currentBlockText ? "\n\n" : "") + trimmed;
    } else {
      if (currentBlockText) {
        mergedBlocks.push({ title: currentTitle, text: currentBlockText });
      }
      // If a single section is larger than chunkSize, break it by paragraph or sentence
      if (trimmed.length > chunkSize) {
        let start = 0;
        while (start < trimmed.length) {
          let end = Math.min(start + chunkSize, trimmed.length);
          if (end < trimmed.length) {
            // Find nearest paragraph or sentence break
            const lastBreak = trimmed.lastIndexOf("\n\n", end);
            const lastPeriod = trimmed.lastIndexOf(". ", end);
            if (lastBreak > start + chunkSize * 0.6) {
              end = lastBreak + 2;
            } else if (lastPeriod > start + chunkSize * 0.6) {
              end = lastPeriod + 1;
            }
          }
          const slice = trimmed.slice(start, end).trim();
          if (slice) {
            mergedBlocks.push({ title: candidateTitle, text: slice });
          }
          start = Math.max(end - chunkOverlap, end);
          if (start >= trimmed.length) break;
        }
        currentBlockText = "";
      } else {
        currentBlockText = trimmed;
      }
      currentTitle = candidateTitle;
    }
  }

  if (currentBlockText.trim()) {
    mergedBlocks.push({ title: currentTitle, text: currentBlockText.trim() });
  }

  // Safety fallback if no blocks created
  if (mergedBlocks.length === 0) {
    mergedBlocks.push({ title: "Requirements", text: extractedText.slice(0, chunkSize) });
  }

  if (mergedBlocks.length > LARGE_FILE_CONFIG.MAX_CHUNKS) {
    throw new Error(
      `This document contains ${mergedBlocks.length} sections, exceeding the current processing limit of ${LARGE_FILE_CONFIG.MAX_CHUNKS}. Split the document into smaller files so every section can be analyzed.`
    );
  }

  const finalBlocks = mergedBlocks;
  const totalChunks = finalBlocks.length;

  return finalBlocks.map((b, idx) => {
    const contextHeader = `[DOCUMENT CONTEXT]
Document: ${fileName}
Chunk: ${idx + 1} of ${totalChunks}
Section: ${b.title || "Requirements Section"}
Total Chunks: ${totalChunks}
`;
    const fullChunkText = `${contextHeader}\n[CONTENT]\n${b.text}`;
    return {
      chunkIndex: idx,
      totalChunks,
      sectionTitle: b.title || `Section ${idx + 1}`,
      contextHeader,
      content: b.text,
      fullChunkText
    };
  });
}

/**
 * Creates parent job and child chunks in Firestore
 */
export async function createTestCaseJobRecord(
  adminDb: any,
  jobParams: {
    projectId: string;
    userId: string;
    fileId: string;
    fileName: string;
    chunks: DocumentChunk[];
    idempotencyKey?: string;
    creditFeatureName?: string;
  }
): Promise<ParentTestCaseJob> {
  const { projectId, userId, fileId, fileName, chunks, idempotencyKey, creditFeatureName } = jobParams;
  const key = idempotencyKey || `job_${projectId}_${fileId}_${crypto.createHash("md5").update(fileName).digest("hex")}`;
  const jobId = `job_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const now = new Date().toISOString();

  const parentJob: ParentTestCaseJob = {
    jobId,
    projectId,
    userId,
    fileId,
    fileName,
    feature: creditFeatureName === 'AI Test Scenario generation' ? 'AI_SCENARIOS' : 'AI_TEST_CASES',
    creditFeatureName: creditFeatureName || 'AI Test Cases generation',
    status: "QUEUED",
    totalChunks: chunks.length,
    completedChunks: 0,
    failedChunks: 0,
    idempotencyKey: key,
    creditDeducted: false,
    stage: `Ready to process ${chunks.length} document sections`,
    createdAt: now,
    updatedAt: now,
  };

  // Crucial: Always store in local memory/disk store first so job is immediately available
  localJobsStore.set(jobId, { ...parentJob });
  persistJobsToDisk();

  if (adminDb) {
    try {
      await adminDb.collection("ai_testcase_jobs").doc(jobId).set(parentJob);

      // Create child chunk records in subcollection
      const batch = adminDb.batch();
      for (const chunk of chunks) {
        const chunkId = `chunk_${chunk.chunkIndex}`;
        const chunkDocRef = adminDb.collection("ai_testcase_jobs").doc(jobId).collection("chunks").doc(chunkId);
        const childChunk: ChildTestCaseChunk = {
          chunkId,
          chunkIndex: chunk.chunkIndex,
          sectionTitle: chunk.sectionTitle,
          status: "PENDING",
          attemptCount: 0,
          createdAt: now,
          updatedAt: now,
        };
        batch.set(chunkDocRef, childChunk);
      }
      await batch.commit();
      console.log(`[LargeFileService] Created parent job ${jobId} with ${chunks.length} chunks in Firestore.`);
    } catch (dbErr: any) {
      console.warn(`[LargeFileService] Firestore parent job creation warning:`, dbErr?.message || dbErr);
    }
  }

  return parentJob;
}

/**
 * Executes a single chunk through the central Gemini rate controller and job manager
 */
async function processSingleChunkWithRetry(
  adminDb: any,
  jobId: string,
  chunk: DocumentChunk,
  loginContext?: string,
  aiInstructions?: string
): Promise<any[]> {
  const chunkId = `chunk_${chunk.chunkIndex}`;
  const chunkDocRef = adminDb?.collection("ai_testcase_jobs").doc(jobId).collection("chunks").doc(chunkId);

  // Check if chunk is already completed (resumable processing support!)
  if (chunkDocRef) {
    try {
      const docSnap = await chunkDocRef.get();
      if (docSnap.exists) {
        const data = docSnap.data();
        if (data?.status === "COMPLETED" && Array.isArray(data?.results) && data.results.length > 0) {
          console.log(`[LargeFileService] Chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks} already completed. Resuming without re-executing.`);
          return data.results;
        }
      }
      await chunkDocRef.update({
        status: "PROCESSING",
        attemptCount: (docSnap.data()?.attemptCount || 0) + 1,
        updatedAt: new Date().toISOString()
      });
    } catch (snapErr) {
      console.warn(`[LargeFileService] Chunk check notice for ${chunkId}:`, snapErr);
    }
  }

  const prompt = `You are a Principal QA Automation and Manual Test Architect.
Analyze the following PRD/document section and generate concise, accurate, executable test cases that collectively cover every testable requirement in this section.

SOURCE-OF-TRUTH REQUIREMENTS:
- Treat the supplied document text as the sole source of product behavior. Do not invent features, user roles, UI controls, API endpoints, business rules, error messages, integrations, or expected outcomes.
- First identify each distinct functional requirement, user workflow, acceptance criterion, validation rule, and explicitly stated non-functional requirement in this section. Ensure each one is covered by at least one test case; do not stop after a small sample.
- Create a separate, focused test case for each independently verifiable behavior or acceptance criterion. Keep related steps together only when they verify the same behavior; do not merge unrelated requirements into a generic test.
- Base each test on a specific requirement and make its title, steps, and expected result traceable to that requirement.
- Cover the documented happy paths. Add negative cases only for validations or failure behavior stated or necessarily implied by the requirements.
- Add boundary/edge cases only when the document specifies a limit, range, or boundary; do not make up numeric thresholds or unsupported edge behavior.
- Include security, accessibility, performance, and other non-functional scenarios only when the PRD specifies them.
- Use placeholders for unspecified accounts, credentials, and test data. State any necessary assumptions in preconditions rather than presenting them as requirements.
- Keep coverage limited to the document: no duplicate, boilerplate, speculative, or unrelated tests. Prefer the minimum complete set, not an arbitrary fixed number.
- This is section ${chunk.chunkIndex + 1} of ${chunk.totalChunks}. Analyze all of its content, not just its opening paragraphs. Do not omit requirements because they appear near the end.

${aiInstructions ? `========================================
CRITICAL SPECIFIC QA INSTRUCTIONS / REFINE DIRECTIVES:
========================================
${aiInstructions}
MANDATORY: You MUST strictly adhere to and incorporate all SPECIFIC QA INSTRUCTIONS / REFINE DIRECTIVES above into the generated scenarios and test cases.
========================================

` : ""}${chunk.fullChunkText}

${loginContext ? `[LOGIN CONTEXT]\n${loginContext}\n` : ""}

CRITICAL OUTPUT FORMAT REQUIREMENTS:
Output MUST be a valid JSON array of test scenario objects. Do NOT include markdown code blocks, backticks (\`\`\`json), comments, or conversational commentary.
Each scenario object MUST adhere to this exact schema:
[
  {
    "scenarioId": "TS-${chunk.chunkIndex + 1}-01",
    "title": "Clear descriptive scenario title",
    "type": "Functional",
    "scenarioCategory": "Positive",
    "description": "Thorough description of what is being tested in this scenario",
    "expectedResults": "Precise verification assertion and expected behavior",
    "moduleName": "${chunk.sectionTitle.replace(/["\\]/g, "") || "Requirements"}",
    "priority": "High",
    "testCases": [
      {
        "testCaseId": "TC-${chunk.chunkIndex + 1}-01",
        "title": "Step by step test case title",
        "preconditions": "Preconditions required before test execution",
        "steps": [
          "1. Navigate to...",
          "2. Enter valid...",
          "3. Click submit button..."
        ],
        "expectedResult": "Immediate UI or API response verification"
      }
    ]
  }
]

Ensure every distinct requirement identified above is covered by at least one executable test case. Include Positive, Negative, or Edge categories only when supported by the document.`;

  const primaryModel = AI_CONFIG.PRIMARY_MODEL || "gemini-3.1-flash-lite";
  const fallbackModel = AI_CONFIG.FALLBACK_MODEL || "gemini-flash-latest";

  let scenarios: any[] = [];
  let executionError: any = null;

  // Use Central AI Queue and Rate Controller
  const executeCall = async (modelToUse: string) => {
    const ai = getGeminiClient();
    const releaseSlot = await centralRateController.acquire();
    const startTime = Date.now();

    logger.logOperation('TestCaseGenerator', `Chunk_${chunk.chunkIndex}`, 'STARTED', `[TestCaseGenerator] Starting AI generation for chunk ${chunk.chunkIndex}`, { jobId, chunkIndex: chunk.chunkIndex, model: modelToUse });

    try {
      const response = await ai.models.generateContent({
        model: modelToUse,
        contents: prompt,
        config: {
          temperature: 0.15,
          topP: 0.8,
          responseMimeType: "application/json"
        }
      });

      releaseSlot();
      const durationMs = Date.now() - startTime;
      const rawText = response.text || "";
      const cleaned = rawText
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      const parsed = JSON.parse(cleaned);
      const result = Array.isArray(parsed) ? parsed : (parsed.scenarios || parsed.testScenarios || [parsed]);

      logger.logOperation('TestCaseGenerator', `Chunk_${chunk.chunkIndex}`, 'SUCCESS', `[TestCaseGenerator] Successfully generated test cases for chunk ${chunk.chunkIndex}`, { jobId, chunkIndex: chunk.chunkIndex, model: modelToUse, scenarioCount: result.length }, durationMs);
      if (durationMs > 3000) {
        logger.logPerformance('TestCaseGenerator', `Chunk_${chunk.chunkIndex}`, durationMs, 3000, { jobId, chunkIndex: chunk.chunkIndex, model: modelToUse });
      }

      return result;
    } catch (err: any) {
      releaseSlot();
      const durationMs = Date.now() - startTime;
      const classification = classifyGeminiError(err);
      logAIOperation("AI_JOB_FAILED", {
        jobId,
        chunkIndex: chunk.chunkIndex,
        model: modelToUse,
        category: classification.category,
        diagnosticCode: classification.diagnosticCode,
        message: classification.userFriendlyMessage,
        durationMs
      });
      logger.logOperation('TestCaseGenerator', `Chunk_${chunk.chunkIndex}`, 'FAILED', `[TestCaseGenerator] Failed chunk ${chunk.chunkIndex}: ${classification.userFriendlyMessage}`, { jobId, chunkIndex: chunk.chunkIndex, model: modelToUse, error: err?.message || err }, durationMs);
      throw err;
    }
  };

  // Attempt with primary model, then controlled fallback if transient/429
  try {
    scenarios = await executeCall(primaryModel);
  } catch (err1: any) {
    const class1 = classifyGeminiError(err1);
    if (class1.is403) {
      // 403 Forbidden - do not retry blindly
      throw new Error(`Gemini Authentication Error (403): ${class1.userFriendlyMessage}`);
    }
    console.warn(`[LargeFileService] Chunk ${chunk.chunkIndex + 1} primary model error, trying fallback model ${fallbackModel}:`, err1?.message);
    try {
      // Short backoff before fallback
      await new Promise(r => setTimeout(r, 1200));
      scenarios = await executeCall(fallbackModel);
    } catch (err2: any) {
      executionError = err2;
      const class2 = classifyGeminiError(err2);
      if (chunkDocRef) {
        await chunkDocRef.update({
          status: "FAILED",
          errorCode: class2.diagnosticCode,
          errorMessage: class2.userFriendlyMessage,
          updatedAt: new Date().toISOString()
        }).catch(() => {});
      }
      throw new Error(`Chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks} processing failed: ${class2.userFriendlyMessage}`);
    }
  }

  // Persist successful chunk results in Firestore immediately
  if (chunkDocRef) {
    try {
      await chunkDocRef.update({
        status: "COMPLETED",
        results: scenarios,
        updatedAt: new Date().toISOString()
      });
    } catch (upErr) {
      console.warn(`[LargeFileService] Chunk result update notice:`, upErr);
    }
  }

  return scenarios;
}

/**
 * Merges and deduplicates test scenarios from multiple chunk results
 */
export function mergeAndDeduplicateScenarios(chunksResults: any[][], fileName: string): any[] {
  const allRaw = chunksResults.flat().filter(Boolean);
  const seenTitles = new Set<string>();
  const merged: any[] = [];

  let counter = 1;
  for (const sc of allRaw) {
    const title = (sc.title || "").trim();
    if (!title) continue;

    const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (seenTitles.has(normalizedTitle)) {
      continue; // Skip duplicate
    }
    seenTitles.add(normalizedTitle);

    const scIndexStr = counter.toString().padStart(3, "0");
    const formattedId = `TS-${scIndexStr}`;
    const cleanCategory = sc.scenarioCategory ||
      (title.toLowerCase().includes("negative") || title.toLowerCase().includes("invalid") || title.toLowerCase().includes("fail") ? "Negative" :
       title.toLowerCase().includes("edge") || title.toLowerCase().includes("boundary") || title.toLowerCase().includes("limit") ? "Edge" : "Positive");

    const formattedTestCases = Array.isArray(sc.testCases) && sc.testCases.length > 0
      ? sc.testCases.map((tc: any, tcIdx: number) => ({
          id: `tc_${Date.now()}_${counter}_${tcIdx}`,
          testCaseId: tc.testCaseId || `TC-${scIndexStr}-${(tcIdx + 1).toString().padStart(2, "0")}`,
          title: tc.title || `Verification step for ${title}`,
          preconditions: tc.preconditions || "System is online and accessible.",
          steps: Array.isArray(tc.steps) ? tc.steps : [tc.steps || "Execute verification step"],
          expectedResult: tc.expectedResult || sc.expectedResults || "Success confirmation",
          status: "Draft",
          type: sc.type || "Functional"
        }))
      : [
          {
            id: `tc_${Date.now()}_${counter}_01`,
            testCaseId: `TC-${scIndexStr}-01`,
            title: `Verify ${title}`,
            preconditions: "System is online and accessible.",
            steps: Array.isArray(sc.steps) && sc.steps.length > 0 ? sc.steps : [sc.description || `Verify workflow: ${title}`],
            expectedResult: sc.expectedResults || "Action completed with verified state.",
            status: "Draft",
            type: sc.type || "Functional"
          }
        ];

    merged.push({
      id: `sc_${Date.now()}_${counter}_${Math.random().toString(36).substring(2, 7)}`,
      scenarioId: formattedId,
      title,
      type: sc.type || "Functional",
      scenarioCategory: cleanCategory,
      description: sc.description || `Generated test scenario for ${title}`,
      expectedResults: sc.expectedResults || "Action completed with verified state.",
      moduleName: sc.moduleName || fileName.replace(/\.[^/.]+$/, ""),
      isApproved: false,
      testCases: formattedTestCases,
      createdAt: new Date().toISOString(),
      saved: false,
      folderId: "",
      priority: sc.priority || "Medium",
      tags: [cleanCategory, sc.type || "Functional", "AI_GENERATED"]
    });

    counter++;
  }

  return merged;
}

/**
 * Full resumable execution orchestrator for large file AI test case generation
 */
export async function executeLargeFileTestCaseJob(
  adminDb: any,
  jobId: string,
  chunks: DocumentChunk[],
  options: {
    loginContext?: string;
    aiInstructions?: string;
    onProgress?: (progress: { completed: number; total: number; stage: string }) => void;
    onCompleteCreditDeduction?: (parentJob: ParentTestCaseJob) => Promise<void>;
  } = {}
): Promise<any[]> {
  const totalChunks = chunks.length;
  const parentRef = adminDb?.collection("ai_testcase_jobs").doc(jobId);

  const updateJobState = async (updates: Partial<ParentTestCaseJob>) => {
    const existing = await getJobRecord(adminDb, jobId);
    if (existing) {
      const merged = { ...existing, ...updates, updatedAt: new Date().toISOString() };
      await saveJobRecord(adminDb, merged);
    }
  };

  try {
    await updateJobState({
      status: "PROCESSING",
      stage: `Analyzing document: 0/${totalChunks} sections`
    });

    const allChunkResults: any[][] = [];
    let completedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < totalChunks; i++) {
      const chunk = chunks[i];
      const stageMsg = `Analyzing document: ${completedCount}/${totalChunks} sections`;

      if (options.onProgress) {
        options.onProgress({ completed: completedCount, total: totalChunks, stage: stageMsg });
      }

      await updateJobState({
        completedChunks: completedCount,
        stage: stageMsg
      });

      try {
        const chunkScenarios = await processSingleChunkWithRetry(
          adminDb,
          jobId,
          chunk,
          options.loginContext,
          options.aiInstructions
        );
        allChunkResults.push(chunkScenarios);
        completedCount++;
      } catch (chunkErr: any) {
        failedCount++;
        console.error(`[LargeFileService] Chunk ${i + 1}/${totalChunks} failure:`, chunkErr?.message || chunkErr);

        await updateJobState({
          status: "FAILED",
          completedChunks: completedCount,
          failedChunks: failedCount,
          errorMessage: `Section ${i + 1} of ${totalChunks} could not be analyzed. Resume the job to retry it. ${chunkErr?.message || ""}`.trim()
        });
        throw chunkErr;
      }
    }

    if (completedCount === 0) {
      const errMsg = "Failed to extract test scenarios from document sections.";
      await updateJobState({
        status: "FAILED",
        failedChunks: failedCount,
        errorMessage: errMsg
      });
      throw new Error(errMsg);
    }

    if (options.onProgress) {
      options.onProgress({
        completed: completedCount,
        total: totalChunks,
        stage: "Merging generated test cases..."
      });
    }

    await updateJobState({
      stage: "Merging generated test cases..."
    });

    // Merge and deduplicate all scenarios
    const mergedScenarios = mergeAndDeduplicateScenarios(allChunkResults, chunks[0]?.sectionTitle || "Requirements");

    // Deduct project credit ONCE upon successful completion (idempotent)
    try {
      const parentData = await getJobRecord(adminDb, jobId);
      if (parentData && !parentData.creditDeducted && options.onCompleteCreditDeduction) {
        await options.onCompleteCreditDeduction(parentData as ParentTestCaseJob);
      }
      await updateJobState({
        status: "COMPLETED",
        completedChunks: completedCount,
        failedChunks: failedCount,
        creditDeducted: true,
        stage: "Test cases generated successfully.",
        mergedScenarios
      });
    } catch (finalizeErr) {
      console.warn(`[LargeFileService] Parent job finalize notice:`, finalizeErr);
    }

    if (options.onProgress) {
      options.onProgress({
        completed: totalChunks,
        total: totalChunks,
        stage: "Test cases generated successfully."
      });
    }

    return mergedScenarios;
  } catch (jobTopErr: any) {
    console.error(`[LargeFileService] Job ${jobId} top-level execution error:`, jobTopErr);
    await updateJobState({
      status: "FAILED",
      errorMessage: jobTopErr?.message || "AI scenario generation failed."
    });
    throw jobTopErr;
  }
}
