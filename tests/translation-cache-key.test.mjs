import assert from "node:assert/strict";
import test from "node:test";

import { loadTsModule } from "./helpers/load-ts-module.mjs";

const {
  DEFAULT_TRANSLATE_MODE,
  DEFAULT_TRANSLATION_OUTPUT_MODE,
  TRANSLATION_CACHE_KEY_SCHEMA_VERSION,
  TRANSLATION_CHUNKER_VERSION,
  TRANSLATION_PROMPT_VERSION,
  buildTranslationArtifactBaseName,
  buildTranslationCacheDescriptor,
  buildTranslationCacheKey,
  buildTranslationCacheKeyInputFromRuntime,
  parseTargetLangFromTranslationArtifactName,
  resolveTranslationProviderBaseUrl,
} = loadTsModule("src/lib/translation-cache-key.ts");

const baseInput = {
  fileHash: "abc123",
  targetLang: "Chinese",
  provider: "openai",
  model: "gpt-4o-mini",
};

test("cache keys are stable hex digests for identical inputs", () => {
  const key = buildTranslationCacheKey(baseInput);

  assert.match(key, /^[0-9a-f]{16}$/);
  assert.equal(key, buildTranslationCacheKey({ ...baseInput }));
});

test("cache keys ignore casing and padding of the file hash but not real inputs", () => {
  const key = buildTranslationCacheKey(baseInput);

  assert.equal(buildTranslationCacheKey({ ...baseInput, fileHash: "  ABC123 " }), key);
  assert.notEqual(buildTranslationCacheKey({ ...baseInput, targetLang: "English" }), key);
  assert.notEqual(buildTranslationCacheKey({ ...baseInput, model: "gpt-4o" }), key);
  assert.notEqual(buildTranslationCacheKey({ ...baseInput, provider: "claude" }), key);
});

test("cache keys change with the endpoint, prompt, chunker and output settings", () => {
  const key = buildTranslationCacheKey(baseInput);

  assert.notEqual(buildTranslationCacheKey({ ...baseInput, baseUrl: "https://proxy.test/v1" }), key);
  assert.notEqual(buildTranslationCacheKey({ ...baseInput, promptVersion: "translation-prompt-v2" }), key);
  assert.notEqual(buildTranslationCacheKey({ ...baseInput, chunkerVersion: "chunker-v2" }), key);
  assert.notEqual(buildTranslationCacheKey({ ...baseInput, outputMode: "bilingual" }), key);
  assert.notEqual(buildTranslationCacheKey({ ...baseInput, translateMode: "deeplx" }), key);
});

test("trailing slashes on the base url do not fragment the cache", () => {
  assert.equal(
    buildTranslationCacheKey({ ...baseInput, baseUrl: "https://proxy.test/v1" }),
    buildTranslationCacheKey({ ...baseInput, baseUrl: "https://proxy.test/v1///" })
  );
});

test("glossary term order and formatting do not change the cache key", () => {
  const first = buildTranslationCacheKey({
    ...baseInput,
    glossaryTerms: [
      { source: "model", target: "模型" },
      { source: " GPU ", target: " 显卡 " },
    ],
  });
  const second = buildTranslationCacheKey({
    ...baseInput,
    glossaryTerms: [
      { source: "GPU", target: "显卡" },
      { source: "model", target: "模型" },
    ],
  });

  assert.equal(first, second);
  assert.notEqual(first, buildTranslationCacheKey(baseInput));
});

test("incomplete glossary entries are ignored", () => {
  assert.equal(
    buildTranslationCacheKey({ ...baseInput, glossaryTerms: [{ source: "GPU", target: "  " }] }),
    buildTranslationCacheKey(baseInput)
  );
});

test("the descriptor exposes the versioned inputs behind the key", () => {
  const descriptor = buildTranslationCacheDescriptor(baseInput);

  assert.equal(descriptor.version, TRANSLATION_CACHE_KEY_SCHEMA_VERSION);
  assert.equal(descriptor.fileHash, "abc123");
  assert.equal(descriptor.promptVersion, TRANSLATION_PROMPT_VERSION);
  assert.equal(descriptor.chunkerVersion, TRANSLATION_CHUNKER_VERSION);
  assert.equal(descriptor.translateMode, DEFAULT_TRANSLATE_MODE);
  assert.equal(descriptor.outputMode, DEFAULT_TRANSLATION_OUTPUT_MODE);
  assert.match(descriptor.endpointHash, /^[0-9a-f]{16}$/);
  assert.match(descriptor.glossaryHash, /^[0-9a-f]{16}$/);
});

test("runtime inputs prefer the provider profile model, endpoint and glossary", () => {
  const input = buildTranslationCacheKeyInputFromRuntime({
    fileHash: "hash",
    targetLang: "Chinese",
    providerId: "openai",
    model: "fallback-model",
    providerProfile: {
      model: "profile-model",
      baseUrl: "https://profile.test/v1",
      glossaryId: "glossary-1",
      sourceLang: "en",
    },
  });

  assert.equal(input.model, "profile-model");
  assert.equal(input.baseUrl, "https://profile.test/v1");
  assert.equal(input.glossaryId, "glossary-1");
  assert.equal(input.glossarySourceLang, "en");
  assert.equal(input.translateMode, DEFAULT_TRANSLATE_MODE);
});

test("deeplx provider profiles switch the translate mode", () => {
  const input = buildTranslationCacheKeyInputFromRuntime({
    fileHash: "hash",
    targetLang: "Chinese",
    providerId: "deeplx",
    model: "deeplx",
    providerProfile: { providerType: "deeplx" },
  });

  assert.equal(input.translateMode, "deeplx");
});

test("provider base urls fall back to the built-in provider definition", () => {
  assert.equal(resolveTranslationProviderBaseUrl("deepseek"), "https://api.deepseek.com/v1");
  assert.equal(
    resolveTranslationProviderBaseUrl("openai", " https://proxy.test/v1/ "),
    "https://proxy.test/v1"
  );
  assert.equal(resolveTranslationProviderBaseUrl("not-a-provider"), "");
});

test("artifact names embed a filesystem safe target language and the cache key", () => {
  const name = buildTranslationArtifactBaseName({ ...baseInput, targetLang: "Simplified Chinese" });

  assert.match(name, /^translation-Simplified_Chinese--[0-9a-f]{16}$/);
});

test("target languages round trip through artifact file names", () => {
  const name = `${buildTranslationArtifactBaseName({ ...baseInput, targetLang: "Simplified Chinese" })}.md`;

  assert.equal(parseTargetLangFromTranslationArtifactName(name), "Simplified Chinese");
  assert.equal(
    parseTargetLangFromTranslationArtifactName(name.replace(/\.md$/, ".partial.md")),
    "Simplified Chinese"
  );
});

test("legacy artifact names without a cache key are still parsed", () => {
  assert.equal(parseTargetLangFromTranslationArtifactName("translation-Chinese.md"), "Chinese");
  assert.equal(parseTargetLangFromTranslationArtifactName("translation-Chinese.partial.md"), "Chinese");
  assert.equal(parseTargetLangFromTranslationArtifactName("source.md"), null);
});
