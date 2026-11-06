// Recovers the files a QA message was sent with, from that session's transcript
// on the QA host (the Node port of get-session.sh). Only used for messages that
// name a file. Transcripts hold customer data: everything stays in memory and
// only file metadata is saved.
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { SshTarget } from "./ssh.mjs";

// The agent's limits (cnu-claude-agent attachments.mjs).
export const MAX_ATTACHMENTS = 5;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const PREAMBLE = /\n*The person attached \d+ files? to this message\. They are on disk and you can read them:\n((?:- .+\n?)+)(?:Read what you need from them before answering\.[^\n]*?sheet\.py\.)?/;
const INPUT_PDF = /^INPUT PDF: (.+)$/m;
const IMAGE_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** Files a question names: the agent's attachment note, or the labelizer prompt's INPUT PDF. */
export function attachmentRefs(question) {
  const refs = [];
  const pre = PREAMBLE.exec(question);
  if (pre) {
    for (const line of pre[1].split("\n")) {
      const m = /^- (.+) \(\d+ KB\) at (.+)$/.exec(line.trim());
      if (m) refs.push({ name: m[1], path: m[2] });
    }
  }
  const pdf = INPUT_PDF.exec(question);
  if (pdf) refs.push({ name: pdf[1].trim().split("/").pop(), path: pdf[1].trim() });
  return refs;
}

/**
 * The question as it is replayed with the files attached: the old note goes
 * (the agent writes its own with the new paths), and the labelizer prompt
 * points at the attachment instead of the old /tmp path.
 */
export function replayQuestion(question) {
  return question
    .replace(PREAMBLE, "")
    .replace(INPUT_PDF, (_, p) => `INPUT PDF: the attached file ${p.trim().split("/").pop()} (its path is in the note below)`)
    .trimEnd();
}

/** Regular files of a (ustar/GNU) tar archive: [{ name, data }]. */
export function untar(buf) {
  const files = [];
  let longName = null;
  for (let off = 0; off + 512 <= buf.length;) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const str = (a, b) => header.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(str(124, 136).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = str(257, 263).startsWith("ustar") ? str(345, 500) : "";
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = data.toString("utf8").replace(/\0.*$/s, ""); continue; }
    if (type === "x") {
      const path = /\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
      if (path) longName = path[1];
      continue;
    }
    const name = longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    longName = null;
    if (type === "0" || type === "\0") files.push({ name, data });
  }
  return files;
}

/** Parsed transcript entries of the main session and its subagents. */
export function transcriptEntries(tgz) {
  return untar(gunzipSync(tgz))
    .filter((f) => f.name.endsWith(".jsonl"))
    .flatMap((f) => f.data.toString("utf8").split(/\r?\n/).flatMap((line) => {
      try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
    }));
}

const contentOf = (entry) => (Array.isArray(entry?.message?.content) ? entry.message.content : []);

/** Every base64 source block inside a value (the get-session.sh walk). */
function base64Blocks(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => base64Blocks(v, out));
  else if (value && typeof value === "object") {
    const s = value.source;
    if (s?.type === "base64" && s.data) out.push({ mediaType: s.media_type, data: s.data });
    Object.values(value).forEach((v) => base64Blocks(v, out));
  }
  return out;
}

const toFile = (fileName, block) => {
  const bytes = Buffer.from(block.data, "base64");
  return {
    fileName, contentType: block.mediaType, dataBase64: block.data,
    bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};

/**
 * The files for one message's refs. A named file is the base64 block the agent
 * got back when it Read that path; images sent with the message are the image
 * blocks of the user turn that carries the note. Text files (CSV, XML) and
 * spreadsheets come back as text or not at all, so they are `missing`.
 */
export function filesFor(entries, refs) {
  const readPaths = new Map(); // tool_use id -> file_path
  const results = new Map();   // tool_use id -> base64 blocks
  const readFiles = new Map(); // file path -> base64 block, from Claude Code's toolUseResult.file
  const metaBlocks = new Map(); // parent entry uuid -> base64 blocks of an isMeta entry (where the PDF goes)
  for (const entry of entries) {
    const file = entry?.toolUseResult?.file;
    if (file?.filePath && file.base64) {
      const mediaType = entry.toolUseResult.type === "pdf" ? "application/pdf" : file.type;
      readFiles.set(file.filePath, { mediaType, data: file.base64 });
    }
    if (entry?.isMeta && entry.parentUuid) metaBlocks.set(entry.parentUuid, base64Blocks(contentOf(entry)));
  }
  for (const entry of entries) {
    for (const c of contentOf(entry)) {
      if (c?.type === "tool_use" && c.name === "Read" && c.input?.file_path) readPaths.set(c.id, c.input.file_path);
      if (c?.type === "tool_result") {
        results.set(c.tool_use_id, [...base64Blocks(c.content), ...(metaBlocks.get(entry.uuid) ?? [])]);
      }
    }
  }
  const usable = (b) => b && (b.mediaType === "application/pdf" || IMAGE_EXT[b.mediaType]);
  const files = [], missing = [], seen = new Set();
  const add = (file) => { if (!seen.has(file.sha256)) { seen.add(file.sha256); files.push(file); } };
  for (const ref of refs) {
    const direct = readFiles.get(ref.path);
    const block = usable(direct) ? direct : [...readPaths].filter(([, p]) => p === ref.path)
      .flatMap(([id]) => results.get(id) ?? []).find(usable);
    if (block) add(toFile(ref.name, block));
    else missing.push(ref.name);
  }
  // Screenshots sent along with the named files.
  const turn = refs.length && entries.find((e) => e.type === "user" && contentOf(e).some((c) => c?.type === "text" && c.text?.includes(refs[0].path)));
  if (turn) {
    contentOf(turn).filter((c) => c?.type === "image").flatMap((c) => base64Blocks(c))
      .filter((b) => IMAGE_EXT[b.mediaType])
      .forEach((b, i) => add(toFile(`image-${i + 1}.${IMAGE_EXT[b.mediaType]}`, b)));
  }
  return { files, missing };
}

/** Why the agent would refuse these files, or "". */
export function limitReason(files) {
  if (files.length > MAX_ATTACHMENTS) return `${files.length} attachments: the agent takes at most ${MAX_ATTACHMENTS}`;
  for (const f of files) {
    const cap = IMAGE_EXT[f.contentType] ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES;
    if (f.bytes > cap) return `${f.fileName}: ${(f.bytes / 1048576).toFixed(1)} MB is over the agent's ${cap / 1048576} MB limit`;
  }
  const total = files.reduce((n, f) => n + f.bytes, 0);
  return total > MAX_TOTAL_BYTES ? `the attachments total more than ${MAX_TOTAL_BYTES / 1048576} MB` : "";
}

/** File metadata kept with a result: no content. */
export const attachmentMeta = (files) => files.map(({ fileName, contentType, bytes, sha256 }) => ({ fileName, contentType, bytes, sha256 }));

/** QA session transcripts over SSH (QA_SESSIONS_SSH_*), one fetch per session per run. */
export class QaSessionSource {
  constructor(target = new SshTarget("QA_SESSIONS_SSH")) {
    this.target = target;
    this.cache = new Map();
  }

  /** Transcript entries of a session; rejects with a reason fit for skip_reason. */
  entries(sessionId) {
    if (!this.cache.has(sessionId)) this.cache.set(sessionId, this.#fetch(sessionId));
    return this.cache.get(sessionId);
  }

  async #fetch(sessionId) {
    if (!this.target.configured) throw new Error("qa-session: QA_SESSIONS_SSH_HOST is not set");
    // The id ends up in a remote command line, so only a plain session id gets through.
    if (!/^[0-9a-f][0-9a-f-]{7,35}$/i.test(sessionId ?? "")) throw new Error(`qa-session: not a session id: ${sessionId}`);
    let tgz;
    try {
      tgz = await this.target.exec(`sudo /usr/local/bin/claude-session get ${sessionId}`);
    } catch (err) {
      throw new Error(`qa-session: could not fetch ${sessionId}: ${err.message}`);
    }
    try {
      return transcriptEntries(tgz);
    } catch (err) {
      throw new Error(`qa-session: could not read the transcript of ${sessionId}: ${err.message}`);
    }
  }

  /**
   * The message as it is replayed: `{ question, attachments }`, or `{ skip }`
   * with the reason. A message that names no file is returned as it is.
   */
  async prepare(sessionId, question) {
    const refs = attachmentRefs(question);
    if (!refs.length) return { question, attachments: [] };
    let entries;
    try { entries = await this.entries(sessionId); } catch (err) { return { skip: err.message }; }
    const { files, missing } = filesFor(entries, refs);
    if (missing.length) return { skip: `attachment not recoverable from the QA session: ${missing.join(", ")}` };
    const limit = limitReason(files);
    if (limit) return { skip: `attachment over the agent's limits: ${limit}` };
    return { question: replayQuestion(question), attachments: files };
  }
}
