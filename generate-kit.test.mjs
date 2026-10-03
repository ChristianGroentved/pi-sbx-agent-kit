import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildKit, generateKit } from "./generate-kit.mjs";

function config() {
  return {
    providers: {
      "gcp-oss-maas": {
        baseUrl: "https://aiplatform.googleapis.com/v1/projects/example/locations/global/endpoints/openapi",
        api: "openai-completions",
        apiKey: "!/opt/homebrew/bin/gcloud auth application-default print-access-token",
        authHeader: true,
        models: [
          { id: "qwen/qwen3-next-80b-a3b-thinking-maas", displayName: "Qwen Thinking" },
          { id: "zai-org/glm-5.2-maas", displayName: "GLM 5.2" },
          { id: "zai-org/glm-5-maas", displayName: "GLM 5" },
        ],
      },
    },
  };
}

test("existing gcloud config becomes a host secret and sandbox sentinel without mutation", () => {
  const input = config();
  const snapshot = structuredClone(input);
  const { spec, models, secrets } = buildKit(input);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(secrets, [{
    service: "gcp-oss-maas",
    command: "/opt/homebrew/bin/gcloud auth application-default print-access-token",
  }]);
  assert.equal(models.providers["gcp-oss-maas"].apiKey, "${PI_KIT_GCP_OSS_MAAS_API_KEY}");
  assert.deepEqual(models.providers["gcp-oss-maas"].models.map((model) => model.name),
    ["Qwen Thinking", "GLM 5.2", "GLM 5"]);
  assert.equal(spec.credentials[0].apiKey.proxyManaged, true);
  assert.deepEqual(spec.credentials[0].apiKey.inject, [{
    domain: "aiplatform.googleapis.com", header: "Authorization", scheme: "bearer",
  }]);
  assert.deepEqual(spec.permissions.network.allow, ["registry.npmjs.org", "aiplatform.googleapis.com"]);
  assert.equal(JSON.stringify(models).includes("gcloud"), false);
});

test("providers coexist with adapter-specific credentials and unchanged metadata", () => {
  const input = config();
  for (const [provider, api, host, key] of [
    ["anthropic", "anthropic-messages", "api.anthropic.com", "${ANTHROPIC_API_KEY}"],
    ["openai", "openai-responses", "api.openai.com", "$OPENAI_API_KEY"],
    ["google", "google-generative-ai", "generativelanguage.googleapis.com", "${GEMINI_API_KEY}"],
  ]) {
    input.providers[provider] = {
      baseUrl: `https://${host}`, api, apiKey: key,
      models: [{ id: "example", name: "Example", contextWindow: 32000, compat: { supportsStore: false } }],
      modelOverrides: { example: { maxTokens: 4000 } },
    };
  }
  const { spec, models } = buildKit(input);
  assert.equal(spec.credentials.length, 4);
  assert.deepEqual(spec.credentials.map(({ apiKey }) => apiKey.inject[0].header),
    ["Authorization", "x-api-key", "Authorization", "x-goog-api-key"]);
  assert.deepEqual(models.providers.openai.models, input.providers.openai.models);
  assert.deepEqual(models.providers.openai.modelOverrides, input.providers.openai.modelOverrides);
  assert.equal(models.providers.openai.apiKey, "${OPENAI_API_KEY}");
});

test("model endpoints are allowed and receive the same credential", () => {
  const input = config();
  input.providers["gcp-oss-maas"].models[1].baseUrl = "https://us-central1-aiplatform.googleapis.com/v1";
  const { spec } = buildKit(input);
  assert.equal(spec.credentials[0].apiKey.inject.length, 2);
  assert.equal(spec.permissions.network.allow.includes("us-central1-aiplatform.googleapis.com"), true);
});

test("unsafe or unsupported configurations fail before generation", () => {
  const changes = [
    (provider) => { provider.apiKey = "literal-key"; },
    (provider) => { provider.apiKey = "! "; },
    (provider) => { provider.apiKey = "${SBX_TOKEN}"; },
    (provider) => { provider.baseUrl = "http://api.example.com"; },
    (provider) => { provider.baseUrl = `https://${["user", "password"].join(":")}@api.example.com`; },
    (provider) => { provider.baseUrl += "?key=secret"; },
    (provider) => { provider.api = "google-vertex"; },
    (provider) => { provider.models = []; },
    (provider) => { provider.models[0].id = ""; },
    (provider) => { provider.headers = { Authorization: "******" }; },
    (provider) => { provider.models[0].headers = { "X-Api-Key": "literal" }; },
    (provider) => { provider.modelOverrides = { example: { baseUrl: "https://other.example.com" } }; },
  ];
  for (const change of changes) {
    const input = config();
    change(input.providers["gcp-oss-maas"]);
    assert.throws(() => buildKit(input));
  }
  for (const input of [null, {}, { providers: [] }, { providers: {} }]) {
    assert.throws(() => buildKit(input));
  }
});

test("conflicting host, env, or authentication mappings are rejected", () => {
  const input = config();
  input.providers.other = structuredClone(input.providers["gcp-oss-maas"]);
  assert.throws(() => buildKit(input), /already bound/);
  input.providers.other.baseUrl = "https://other.example.com";
  input.providers.other.apiKey = "${SHARED_KEY}";
  input.providers["gcp-oss-maas"].apiKey = "${SHARED_KEY}";
  assert.throws(() => buildKit(input), /must be unique/);
  delete input.providers.other;
  input.providers["gcp-oss-maas"].authHeader = false;
  input.providers["gcp-oss-maas"].models[0].api = "anthropic-messages";
  assert.throws(() => buildKit(input), /same authentication format/);
});

test("generation writes a usable kit without running host commands", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-kit-"));
  try {
    const source = join(dir, "models.json");
    const input = config();
    input.providers["gcp-oss-maas"].apiKey = `!touch ${join(dir, "must-not-exist")}`;
    writeFileSync(source, JSON.stringify(input));
    const output = join(dir, "kit");
    const kit = generateKit(source, output);
    assert.deepEqual(JSON.parse(readFileSync(join(output, "spec.yaml"), "utf8")), kit.spec);
    assert.deepEqual(JSON.parse(readFileSync(join(output, "files/home/.pi/agent/models.json"), "utf8")), kit.models);
    assert.throws(() => readFileSync(join(dir, "must-not-exist")));
    assert.equal(readFileSync(source, "utf8"), JSON.stringify(input));
    generateKit(source, output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("credential registration passes the host command verbatim to sbx with refresh enabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-secrets-"));
  try {
    const stub = join(dir, "sbx");
    const log = join(dir, "args.json");
    writeFileSync(stub, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(process.env.ARG_LOG, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
    const source = join(dir, "models.json");
    writeFileSync(source, JSON.stringify(config()));
    const result = spawnSync(process.execPath, [
      new URL("./generate-kit.mjs", import.meta.url).pathname, source, join(dir, "kit"), "--configure-secrets",
    ], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ARG_LOG: log }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), [
      "secret", "set", "gcp-oss-maas", "--command",
      "/opt/homebrew/bin/gcloud auth application-default print-access-token", "--refresh", "30m",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
