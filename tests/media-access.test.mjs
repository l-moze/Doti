import assert from "node:assert/strict";
import test from "node:test";

import { loadTsModule } from "./helpers/load-ts-module.mjs";

function loadMediaAccess(env = {}) {
  const processStub = {
    ...process,
    env: {
      ...process.env,
      MEDIA_TOKEN_SECRET: undefined,
      MEDIA_URL_SIGNING_SECRET: undefined,
      NEXTAUTH_SECRET: undefined,
      MEDIA_TOKEN_TTL_SECONDS: undefined,
      PUBLIC_DEPLOYMENT: undefined,
      ...env,
    },
  };

  return loadTsModule("src/lib/media-access.ts", { process: processStub });
}

test("public deployment mode is read from a truthy environment flag", () => {
  for (const value of ["1", "true", "YES", "on"]) {
    assert.equal(loadMediaAccess({ PUBLIC_DEPLOYMENT: value }).isPublicDeploymentMode(), true, value);
  }

  for (const value of ["0", "false", "", undefined]) {
    assert.equal(loadMediaAccess({ PUBLIC_DEPLOYMENT: value }).isPublicDeploymentMode(), false, String(value));
  }
});

test("signed media access is required exactly in public deployment mode", () => {
  assert.equal(loadMediaAccess().requiresSignedMediaAccess(), false);
  assert.equal(loadMediaAccess({ PUBLIC_DEPLOYMENT: "1" }).requiresSignedMediaAccess(), true);
});

test("token ttl falls back to fifteen minutes for missing or invalid values", () => {
  assert.equal(loadMediaAccess().getMediaTokenTtlSeconds(), 900);
  assert.equal(loadMediaAccess({ MEDIA_TOKEN_TTL_SECONDS: "abc" }).getMediaTokenTtlSeconds(), 900);
  assert.equal(loadMediaAccess({ MEDIA_TOKEN_TTL_SECONDS: "-30" }).getMediaTokenTtlSeconds(), 900);
  assert.equal(loadMediaAccess({ MEDIA_TOKEN_TTL_SECONDS: "60" }).getMediaTokenTtlSeconds(), 60);
});

test("media paths are normalized to forward slashed relative segments", () => {
  const { normalizeMediaRelativePath } = loadMediaAccess();

  assert.equal(normalizeMediaRelativePath("images\\fig1.png"), "images/fig1.png");
  assert.equal(normalizeMediaRelativePath("/images//fig1.png"), "images/fig1.png");
});

test("media paths reject traversal and empty values", () => {
  const { normalizeMediaRelativePath } = loadMediaAccess();

  assert.throws(() => normalizeMediaRelativePath("   "), /empty/i);
  assert.throws(() => normalizeMediaRelativePath("../secrets.env"), /traversal/i);
  assert.throws(() => normalizeMediaRelativePath("images/../../secrets.env"), /traversal/i);
});

test("raw media urls percent-encode each path segment", () => {
  const { buildRawMediaUrl, buildRawMediaPrefix } = loadMediaAccess();

  assert.equal(buildRawMediaUrl("hash1", "images/fig 1.png"), "/api/media/hash1/images/fig%201.png");
  assert.equal(buildRawMediaPrefix("hash 1"), "/api/media/hash%201");
});

test("local deployments deliver unsigned media urls", () => {
  const { buildMediaDeliveryUrl } = loadMediaAccess();

  assert.equal(buildMediaDeliveryUrl("hash1", "images/fig1.png"), "/api/media/hash1/images/fig1.png");
});

test("public deployments deliver signed media urls that verify", () => {
  const media = loadMediaAccess({ PUBLIC_DEPLOYMENT: "1", MEDIA_TOKEN_SECRET: "test-secret" });
  const url = media.buildMediaDeliveryUrl("hash1", "images/fig1.png");
  const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));

  assert.ok(url.startsWith("/api/media/hash1/images/fig1.png?"));
  assert.equal(
    media.verifyMediaAccessToken({
      fileHash: "hash1",
      relativePath: "images/fig1.png",
      token: query.get("token"),
      expiresAt: query.get("expires"),
    }),
    true
  );
});

test("signed tokens do not verify for another file, path or expiry", () => {
  const media = loadMediaAccess({ PUBLIC_DEPLOYMENT: "1", MEDIA_TOKEN_SECRET: "test-secret" });
  const url = media.buildSignedMediaUrl({ fileHash: "hash1", relativePath: "images/fig1.png" });
  const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));
  const token = query.get("token");
  const expires = query.get("expires");

  assert.equal(
    media.verifyMediaAccessToken({ fileHash: "hash2", relativePath: "images/fig1.png", token, expiresAt: expires }),
    false
  );
  assert.equal(
    media.verifyMediaAccessToken({ fileHash: "hash1", relativePath: "images/fig2.png", token, expiresAt: expires }),
    false
  );
  assert.equal(
    media.verifyMediaAccessToken({
      fileHash: "hash1",
      relativePath: "images/fig1.png",
      token,
      expiresAt: String(Number(expires) + 1000),
    }),
    false
  );
});

test("expired, missing and forged tokens are rejected", () => {
  const media = loadMediaAccess({ PUBLIC_DEPLOYMENT: "1", MEDIA_TOKEN_SECRET: "test-secret" });
  const expiredUrl = media.buildSignedMediaUrl({
    fileHash: "hash1",
    relativePath: "images/fig1.png",
    expiresAt: Date.now() - 1000,
  });
  const expiredQuery = new URLSearchParams(expiredUrl.slice(expiredUrl.indexOf("?") + 1));

  assert.equal(
    media.verifyMediaAccessToken({
      fileHash: "hash1",
      relativePath: "images/fig1.png",
      token: expiredQuery.get("token"),
      expiresAt: expiredQuery.get("expires"),
    }),
    false
  );
  assert.equal(
    media.verifyMediaAccessToken({ fileHash: "hash1", relativePath: "images/fig1.png", token: null, expiresAt: "1" }),
    false
  );
  assert.equal(
    media.verifyMediaAccessToken({
      fileHash: "hash1",
      relativePath: "images/fig1.png",
      token: "forged.token",
      expiresAt: String(Date.now() + 1000),
    }),
    false
  );
});

test("tokens signed with another secret are rejected", () => {
  const signer = loadMediaAccess({ PUBLIC_DEPLOYMENT: "1", MEDIA_TOKEN_SECRET: "secret-a" });
  const verifier = loadMediaAccess({ PUBLIC_DEPLOYMENT: "1", MEDIA_TOKEN_SECRET: "secret-b" });
  const url = signer.buildSignedMediaUrl({ fileHash: "hash1", relativePath: "images/fig1.png" });
  const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));

  assert.equal(
    verifier.verifyMediaAccessToken({
      fileHash: "hash1",
      relativePath: "images/fig1.png",
      token: query.get("token"),
      expiresAt: query.get("expires"),
    }),
    false
  );
});

test("signing without any configured secret fails loudly", () => {
  const media = loadMediaAccess({ PUBLIC_DEPLOYMENT: "1" });

  assert.throws(
    () => media.buildSignedMediaUrl({ fileHash: "hash1", relativePath: "images/fig1.png" }),
    /Media signing secret is missing/
  );
});

test("markdown media links are rewritten to signed urls in public mode only", () => {
  const markdown = "![fig](/api/media/hash1/images/fig%201.png) and ![other](/api/media/other/x.png)";
  const local = loadMediaAccess();
  const publicMode = loadMediaAccess({ PUBLIC_DEPLOYMENT: "1", MEDIA_TOKEN_SECRET: "test-secret" });

  assert.equal(local.signInternalMediaUrlsInMarkdown(markdown, "hash1"), markdown);

  const signed = publicMode.signInternalMediaUrlsInMarkdown(markdown, "hash1");
  assert.ok(signed.includes("/api/media/hash1/images/fig%201.png?expires="));
  assert.ok(signed.includes("![other](/api/media/other/x.png)"), "other documents should be untouched");
});
