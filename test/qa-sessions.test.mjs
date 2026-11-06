import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  attachmentRefs, replayQuestion, untar, transcriptEntries, filesFor, limitReason, attachmentMeta, QaSessionSource,
  MAX_IMAGE_BYTES,
} from "../qa-sessions.mjs";
import { SshTarget } from "../ssh.mjs";
import { labelRefs, sslOption } from "../.claude/skills/benchmark-report/scripts/label-ri.mjs";

// Synthetic data only: no real transcript or customer file.
const PDF = Buffer.from("%PDF-1.4 synthetic");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const DIR = "/tmp/cnu-chat/abc/attachments/1234";
const note = (...files) => `\n\nThe person attached ${files.length} file${files.length === 1 ? "" : "s"} to this message. `
  + `They are on disk and you can read them:\n${files.map(([n, p]) => `- ${n} (1 KB) at ${p}`).join("\n")}\n`
  + "Read what you need from them before answering. A spreadsheet is not readable directly -- convert it first with the cnu-backoffice skill's sheet.py.";

function tarFile(name, data) {
  const h = Buffer.alloc(512);
  h.write(name, 0);
  h.write("0000644\0", 100);
  h.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
  h.write("0", 156);
  h.write("ustar\0", 257);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
const tgz = (files) => gzipSync(Buffer.concat([...files.map(([n, d]) => tarFile(n, Buffer.from(d))), Buffer.alloc(1024)]));
const jsonl = (entries) => entries.map((e) => JSON.stringify(e)).join("\n") + "\n";

const question = "why does this fail?" + note(["order (1).pdf", `${DIR}/order (1).pdf`]);
const transcript = [
  { type: "user", message: { role: "user", content: [
    { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } },
    { type: "text", text: question },
  ] } },
  { type: "assistant", message: { role: "assistant", content: [
    { type: "tool_use", id: "t1", name: "Read", input: { file_path: `${DIR}/order (1).pdf` } },
  ] } },
  { type: "user", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "t1", content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF.toString("base64") } },
    ] },
  ] } },
];

test("attachmentRefs reads the agent's note and the labelizer INPUT PDF", () => {
  assert.deepEqual(attachmentRefs(question), [{ name: "order (1).pdf", path: `${DIR}/order (1).pdf` }]);
  assert.deepEqual(attachmentRefs("Use the labelizer skill…\n\nINPUT PDF: /tmp/labelizer-x/1up.pdf\nTarget LabelId: 5."),
    [{ name: "1up.pdf", path: "/tmp/labelizer-x/1up.pdf" }]);
  assert.deepEqual(attachmentRefs("which vendor is it?"), []);
});

test("replayQuestion drops the old note and points INPUT PDF at the attachment", () => {
  assert.equal(replayQuestion(question), "why does this fail?");
  assert.equal(replayQuestion("x\nINPUT PDF: /tmp/labelizer-x/1up.pdf\nTarget LabelId: 5."),
    "x\nINPUT PDF: the attached file 1up.pdf (its path is in the note below)\nTarget LabelId: 5.");
});

test("untar and transcriptEntries read the main session and its subagents", () => {
  const archive = tgz([["s1.jsonl", jsonl(transcript)], ["s1/subagents/a.jsonl", jsonl([{ type: "x" }])], ["s1/notes.txt", "n"]]);
  assert.deepEqual(untar(Buffer.from([...tarFile("a.txt", Buffer.from("hi")), ...Buffer.alloc(1024)])).map((f) => f.name), ["a.txt"]);
  assert.equal(transcriptEntries(archive).length, 4);
});

test("filesFor takes the Read result of the named path and the message's screenshots", () => {
  const { files, missing } = filesFor(transcript, attachmentRefs(question));
  assert.deepEqual(missing, []);
  assert.deepEqual(files.map((f) => [f.fileName, f.contentType, f.bytes]),
    [["order (1).pdf", "application/pdf", PDF.length], ["image-1.png", "image/png", PNG.length]]);
  assert.equal(Buffer.from(files[0].dataBase64, "base64").toString(), PDF.toString());
  assert.deepEqual(Object.keys(attachmentMeta(files)[0]), ["fileName", "contentType", "bytes", "sha256"]);
});

test("filesFor reads Claude Code's toolUseResult.file and the isMeta document entry", () => {
  const refs = attachmentRefs(question);
  const read = { type: "assistant", message: { content: [{ type: "tool_use", id: "t9", name: "Read", input: { file_path: refs[0].path } }] } };
  const result = { type: "user", uuid: "u1", message: { content: [{ type: "tool_result", tool_use_id: "t9", content: "PDF file read" }] } };
  const meta = { type: "user", isMeta: true, parentUuid: "u1",
    message: { content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF.toString("base64") } }] } };
  // Current shape: the file is in toolUseResult.
  const withFile = { ...result, toolUseResult: { type: "pdf", file: { filePath: refs[0].path, base64: PDF.toString("base64"), originalSize: PDF.length } } };
  assert.deepEqual(filesFor([read, withFile], refs).files.map((f) => [f.fileName, f.contentType]), [["order (1).pdf", "application/pdf"]]);
  // Without toolUseResult, the isMeta entry under the tool_result still gives it.
  assert.deepEqual(filesFor([read, result, meta], refs).files.map((f) => f.bytes), [PDF.length]);
});

test("filesFor reports a file the agent never got back whole as missing", () => {
  const csv = "check this" + note(["ORDER.csv", `${DIR}/ORDER.csv`]);
  const entries = [{ type: "user", message: { content: [{ type: "text", text: csv }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: `${DIR}/ORDER.csv` } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "1\ta;b" }] } }];
  assert.deepEqual(filesFor(entries, attachmentRefs(csv)).missing, ["ORDER.csv"]);
});

test("limitReason follows the agent's limits", () => {
  const f = (bytes, contentType = "application/pdf") => ({ fileName: "f", contentType, bytes });
  assert.equal(limitReason([f(10)]), "");
  assert.match(limitReason(Array.from({ length: 6 }, () => f(1))), /at most 5/);
  assert.match(limitReason([f(MAX_IMAGE_BYTES + 1, "image/png")]), /5 MB limit/);
  assert.match(limitReason([f(9e6), f(9e6), f(9e6)]), /more than 20 MB/);
});

const fakeTarget = (result, env = { QA_SESSIONS_SSH_HOST: "qa" }) => {
  const calls = [];
  const target = new SshTarget("QA_SESSIONS_SSH", env);
  target.exec = async (cmd) => { calls.push(cmd); if (result instanceof Error) throw result; return result; };
  return { target, calls };
};

test("QaSessionSource fetches only for messages with a file, once per session", async () => {
  const { target, calls } = fakeTarget(tgz([["s1.jsonl", jsonl(transcript)]]));
  const qa = new QaSessionSource(target);
  assert.deepEqual(await qa.prepare("0123abcd-0000", "no file here"), { question: "no file here", attachments: [] });
  assert.equal(calls.length, 0);
  const one = await qa.prepare("0123abcd-0000", question);
  await qa.prepare("0123abcd-0000", question);
  assert.equal(one.question, "why does this fail?");
  assert.equal(one.attachments.length, 2);
  assert.deepEqual(calls, ["sudo /usr/local/bin/claude-session get 0123abcd-0000"]);
});

test("QaSessionSource skips with a reason instead of asking without the file", async () => {
  assert.match((await new QaSessionSource(fakeTarget(null, {}).target).prepare("0123abcd", question)).skip, /QA_SESSIONS_SSH_HOST is not set/);
  assert.match((await new QaSessionSource(fakeTarget(new Error("exited 1: denied")).target).prepare("0123abcd", question)).skip,
    /could not fetch 0123abcd: exited 1: denied/);
  assert.match((await new QaSessionSource(fakeTarget(null).target).prepare("x; rm -rf /", question)).skip, /not a session id/);
  const empty = new QaSessionSource(fakeTarget(tgz([["s1.jsonl", jsonl([])]])).target);
  assert.match((await empty.prepare("0123abcd", question)).skip, /not recoverable from the QA session: order \(1\)\.pdf/);
});

test("SshTarget prefers a key file over a password", () => {
  const t = new SshTarget("X", { X_HOST: "h", X_USER: "u", X_PASSWORD: "p" });
  assert.equal(t.connectOptions().password, "p");
  assert.equal(t.connectOptions().port, 22);
  assert.throws(() => new SshTarget("X", { X_HOST: "h", X_KEY_FILE: "/no/such/key" }).connectOptions(), /ENOENT/);
});

test("labelRefs finds generation calls and label ids named in questions", () => {
  assert.deepEqual(labelRefs("INPUT PDF: /tmp/x.pdf\nTarget LabelId: 45194701. Target RetailerId: 245474."),
    [{ labelId: "45194701", source: "generation" }]);
  assert.deepEqual(labelRefs("layout of label id 127, and Labelid 103, again label-id: 127"),
    [{ labelId: "127", source: "question" }, { labelId: "103", source: "question" }]);
  assert.deepEqual(labelRefs("labelid1"), [{ labelId: "1", source: "question" }]);
  assert.deepEqual(labelRefs("het layout van labelid voor deze klant"), []);
});

test("sslOption maps libpq modes", () => {
  assert.equal(sslOption(""), false);
  assert.deepEqual(sslOption("require"), { rejectUnauthorized: false });
  assert.equal(sslOption("verify-full"), true);
  assert.throws(() => sslOption("maybe"), /unknown mode/);
});
