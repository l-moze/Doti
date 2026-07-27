import assert from "node:assert/strict";
import test from "node:test";

import { loadTsModule } from "./helpers/load-ts-module.mjs";

const { Chunker } = loadTsModule("src/lib/agent/think/chunker.ts");
const { ThinkingTagStripper } = loadTsModule("src/lib/agent/act/thinking-stripper.ts");

test("hyphenation introduced by pdf line wrapping is repaired", () => {
  const chunker = new Chunker();

  assert.equal(chunker.clean("ex-\nample text"), "example text");
  assert.equal(chunker.clean("multi-\n   modal models"), "multimodal models");
  assert.equal(chunker.clean("well-known term"), "well-known term");
});

test("markdown is split on level one and two headings", () => {
  const chunker = new Chunker();
  const chunks = chunker.split("# Intro\nfirst\n\n## Method\nsecond\n\n### Detail\nthird");

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].metadata.title, "Intro");
  assert.equal(chunks[1].metadata.title, "Method");
  assert.ok(chunks[1].content.includes("### Detail"), "deeper headings stay inside their section");
});

test("content before the first heading is kept in a leading chunk", () => {
  const chunks = new Chunker().split("abstract text\n\n# Intro\nbody");

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].metadata.title, "Start");
  assert.ok(chunks[0].content.includes("abstract text"));
});

test("chunk ids are unique and offsets advance through the document", () => {
  const chunks = new Chunker().split("# One\nalpha\n\n# Two\nbeta\n\n# Three\ngamma");
  const ids = new Set([...chunks].map((chunk) => chunk.id));

  assert.equal(ids.size, chunks.length);
  for (const chunk of chunks) {
    assert.ok(chunk.metadata.endIndex > chunk.metadata.startIndex);
  }
  assert.ok(chunks[1].metadata.startIndex > chunks[0].metadata.startIndex);
});

test("reference sections are tagged so they can skip translation", () => {
  const chunker = new Chunker();

  for (const heading of ["References", "Bibliography", "参考文献"]) {
    const chunks = chunker.split(`# Body\ntext\n\n# ${heading}\n[1] A paper.`);
    assert.equal(chunks[0].type, "text");
    assert.equal(chunks[1].type, "references", heading);
  }
});

test("oversized sections are split by paragraph while references stay whole", () => {
  const paragraph = `${"word ".repeat(400)}\n\n`;
  const longBody = paragraph.repeat(6);
  const chunker = new Chunker();

  const bodyChunks = chunker.split(`# Method\n${longBody}`);
  assert.ok(bodyChunks.length > 1, "a long section should be broken into sub chunks");
  for (const chunk of bodyChunks) {
    assert.ok(chunk.content.length <= 12000);
    assert.ok(chunk.metadata.title.startsWith("Method"));
  }

  const referenceChunks = chunker.split(`# References\n${longBody}`);
  assert.equal(referenceChunks.length, 1, "reference sections are never sub-split");
  assert.equal(referenceChunks[0].type, "references");
});

test("empty input never produces content to translate", () => {
  for (const chunk of new Chunker().split("")) {
    assert.equal(chunk.content.trim(), "");
  }
});

test("thinking tags are stripped from a single complete response", () => {
  const stripper = new ThinkingTagStripper();

  assert.equal(stripper.consume("<think>reasoning</think>Answer", true), "Answer");
});

test("both think and thinking tag spellings are supported", () => {
  assert.equal(
    new ThinkingTagStripper().consume("<thinking>hidden</thinking>Visible", true),
    "Visible"
  );
});

test("tags split across streamed chunks are still stripped", () => {
  const stripper = new ThinkingTagStripper();
  const chunks = ["Hello <thi", "nk>secret rea", "soning</thi", "nk>\n\nWorld"];
  const output = chunks.map((chunk, index) => stripper.consume(chunk, index === chunks.length - 1)).join("");

  assert.equal(output, "Hello World");
});

test("partial tag prefixes are held back instead of leaking mid-stream", () => {
  const stripper = new ThinkingTagStripper();

  assert.equal(stripper.consume("text <thin"), "text ");
  assert.equal(stripper.consume("k>hidden</think>tail", true), "tail");
});

test("text without thinking tags streams through unchanged", () => {
  const stripper = new ThinkingTagStripper();

  assert.equal(stripper.consume("plain ") + stripper.consume("output", true), "plain output");
});

test("an unterminated thinking block never leaks its content on flush", () => {
  const stripper = new ThinkingTagStripper();

  assert.equal(stripper.consume("visible <think>still reasoning", true), "visible ");
});

test("multiple thinking blocks in one stream are all removed", () => {
  const stripper = new ThinkingTagStripper();

  assert.equal(
    stripper.consume("a<think>one</think>b<think>two</think>c", true),
    "abc"
  );
});
