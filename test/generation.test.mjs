import { test } from "node:test";
import assert from "node:assert/strict";
import { generate, generationIds, generationReply, replay } from "../benchmark.mjs";
import { assertBenchmarkAgent, describeLimit, generateTimeoutMs } from "../agent.mjs";

test("the app recreates only a container labelled as the benchmark agent", () => {
  assert.doesNotThrow(() => assertBenchmarkAgent({ Config: { Labels: { "benchmark.role": "agent" } } }, "claude-agent-benchmark"));
  // The production agent on the same server has no such label.
  assert.throws(() => assertBenchmarkAgent({ Config: { Labels: {} } }, "claude-agent"), /refusing to recreate claude-agent/);
  assert.throws(() => assertBenchmarkAgent({ Config: {} }, "x"), /benchmark\.role=agent/);
  assert.throws(() => assertBenchmarkAgent({ Config: { Labels: { "benchmark.role": "other" } } }, "x"));
});

test("the app waits up to 6 hours for /from-pdf unless GENERATE_TIMEOUT_S says otherwise", () => {
  const saved = process.env.GENERATE_TIMEOUT_S;
  try {
    delete process.env.GENERATE_TIMEOUT_S;
    assert.equal(generateTimeoutMs(), 6 * 60 * 60 * 1000);
    process.env.GENERATE_TIMEOUT_S = "4200";
    assert.equal(generateTimeoutMs(), 4200 * 1000);
  } finally {
    if (saved === undefined) delete process.env.GENERATE_TIMEOUT_S; else process.env.GENERATE_TIMEOUT_S = saved;
  }
  assert.equal(describeLimit(6 * 60 * 60 * 1000), "6 hours");
  assert.equal(describeLimit(10 * 60 * 1000), "10 minutes");
});

const PROMPT = [
  "Use the labelizer skill to convert a label PDF into a best-effort CheckNet Labelizer template plus demo data.",
  "INPUT PDF: the attached file label.pdf (its path is in the note below)",
  "Target LabelId: 1234",
  "Target RetailerId: 56",
  "OUTPUT DIR: /tmp/out",
].join("\n");

const PDF = { fileName: "label.pdf", contentType: "application/pdf", dataBase64: "JVBERi0=" };

const TEMPLATE = JSON.stringify({
  Pages: [{
    Objects: [
      { $type: "CheckNet.Labelizer.Engine.Template.Objects.TextObject", Text: "a" },
      { $type: "CheckNet.Labelizer.Engine.Template.Objects.TextObject", Text: "b" },
      { $type: "CheckNet.Labelizer.Engine.Template.Objects.BoxObject",
        Children: [{ $type: "CheckNet.Labelizer.Engine.Template.Objects.ImageBarcodeObject" }] },
    ],
  }],
});

const OUT = {
  template: TEMPLATE,
  demoData: "rec_type\n0",
  result: { labelSizeMm: "50x30", dpi: 300, objectCount: 4, caveats: ["font guessed"] },
};

test("generationIds reads the target label and retailer ids", () => {
  assert.deepEqual(generationIds(PROMPT), { labelId: 1234, retailerId: 56 });
  assert.deepEqual(generationIds("Target LabelId: 7"), { labelId: 7, retailerId: undefined });
  assert.deepEqual(generationIds("no ids"), { labelId: undefined, retailerId: undefined });
});

test("generationReply summarises result.json and the template's objects", () => {
  assert.equal(generationReply(OUT), [
    "Labelizer template generated (/from-pdf).",
    "result.json: label size 50x30 mm, 300 dpi, objectCount 4",
    "Caveats:",
    "- font guessed",
    "Template: 4 objects (TextObject 2, BoxObject 1, ImageBarcodeObject 1)",
  ].join("\n"));
  assert.match(generationReply({ template: "{", result: {} }), /Caveats: none\nTemplate: not valid JSON$/);
});

test("generationReply counts barcode objects from every engine namespace", () => {
  // Run 1793950764: barcodes typed CheckNet.Labelizer.Engine.EAN13Object were left out of the line.
  const template = JSON.stringify({
    $type: "CheckNet.Labelizer.Engine.Template.TemplateDocument",
    Objects: [
      { $type: "CheckNet.Labelizer.Engine.Template.Objects.TextObject" },
      { $type: "CheckNet.Labelizer.Engine.EAN13Object" },
      { $type: "CheckNet.Labelizer.Engine.QRObject, CheckNet.Labelizer.Engine" },
      { $type: "CheckNet.Labelizer.Engine.Template.BarcodeObject" },
      { $type: "CheckNet.Labelizer.Engine.Template.Group",
        Children: [{ $type: "CheckNet.Labelizer.Engine.DataMatrixObject" }] },
    ],
  });
  assert.match(generationReply({ template, result: {} }),
    /Template: 5 objects \(TextObject 1, EAN13Object 1, QRObject 1, BarcodeObject 1, DataMatrixObject 1\)$/);
});

test("a generation row goes to postFromPdf with the PDF and ids, not to /chat", async () => {
  const calls = [];
  const agent = {
    postChat: async () => { throw new Error("must not call /chat"); },
    postFromPdf: async (body) => { calls.push(body); return OUT; },
  };
  const result = await replay({ question: PROMPT, sessionId: "s-1", attachments: [PDF] }, agent);
  assert.deepEqual(calls, [{ pdfBase64: PDF.dataBase64, filename: "label.pdf", labelId: 1234, retailerId: 56 }]);
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, "");
  assert.equal(result.reply, generationReply(OUT));
});

test("a normal question still goes to /chat", async () => {
  const agent = {
    postChat: async (q, sid) => ({ ok: true, reply: `chat:${q}`, sessionId: sid }),
    postFromPdf: async () => { throw new Error("must not call /from-pdf"); },
  };
  const result = await replay({ question: "what is label 5?", sessionId: "s-1" }, agent);
  assert.equal(result.reply, "chat:what is label 5?");
});

test("a failed /from-pdf call is saved as an error", async () => {
  const result = await generate(PROMPT, [PDF], async () => { throw new Error("HTTP 500: boom"); });
  assert.equal(result.ok, false);
  assert.equal(result.error, "HTTP 500: boom");
  assert.equal(result.reply, "");
  assert.equal(result.tokenLimit, false);
});

test("a /from-pdf call that passed the output token maximum is saved as a token limit", async () => {
  const message = "HTTP 500: Claude Code returned an error result: API Error: Claude's response exceeded the 42000 output token maximum.";
  const result = await generate(PROMPT, [PDF], async () => { throw new Error(message); });
  assert.equal(result.ok, false);
  assert.equal(result.tokenLimit, true);
  assert.equal(result.error, message);
});

test("without a PDF there is nothing to send", async () => {
  const result = await generate(PROMPT, [], async () => { throw new Error("must not be called"); });
  assert.equal(result.ok, false);
  assert.match(result.error, /no PDF/);
});
