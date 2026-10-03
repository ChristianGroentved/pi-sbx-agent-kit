import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const authFormats = {
  "anthropic-messages": { header: "x-api-key", format: "%s" },
  "openai-completions": { header: "Authorization", scheme: "bearer" },
  "openai-responses": { header: "Authorization", scheme: "bearer" },
  "google-generative-ai": { header: "x-goog-api-key", format: "%s" },
};

function endpointHost(value, provider) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${provider}: baseUrl must be an HTTPS URL without credentials, query, or fragment`);
  }
  return url.host;
}

export function buildKit(config) {
  const models = structuredClone(config);
  if (!models?.providers || Array.isArray(models.providers) ||
      typeof models.providers !== "object" || !Object.keys(models.providers).length) {
    throw new Error("models.json must contain a non-empty providers object");
  }
  const credentials = [];
  const secrets = [];
  const hosts = new Map();
  const variables = new Set();
  for (const [provider, settings] of Object.entries(models.providers)) {
    if (!/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/.test(provider)) {
      throw new Error(`${provider}: provider IDs must be lowercase alphanumeric with hyphens (1–64 characters)`);
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings) ||
        !Array.isArray(settings.models) || !settings.models.length) {
      throw new Error(`${provider}: a non-empty models array is required`);
    }
    const key = settings.apiKey;
    const command = typeof key === "string" && key.startsWith("!") ? key.slice(1).trim() : null;
    const env = typeof key === "string" && key.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/);
    if (!command && !env) {
      throw new Error(`${provider}: apiKey must be an environment reference (\${NAME}) or a !host command, never a literal secret`);
    }
    const variable = command ? `PI_KIT_${provider.replaceAll("-", "_").toUpperCase()}_API_KEY` : env[1] || env[2];
    if (/^(SBX_|DOCKER_|DASH_)/.test(variable) || variables.has(variable)) {
      throw new Error(`${provider}: credential environment variables must be unique and not runtime-reserved`);
    }
    variables.add(variable);
    settings.apiKey = `\${${variable}}`;
    const injections = new Map();
    for (const model of settings.models) {
      if (!model || typeof model !== "object" || typeof model.id !== "string" || !model.id) {
        throw new Error(`${provider}: every model needs a non-empty id`);
      }
      if (model.displayName !== undefined) {
        model.name ??= model.displayName;
        delete model.displayName;
      }
      const host = endpointHost(model.baseUrl ?? settings.baseUrl, provider);
      const api = model.api ?? settings.api;
      const auth = authFormats[api];
      if (!auth) {
        throw new Error(`${provider}: unsupported API ${api}; use an Anthropic, OpenAI, or Google-compatible endpoint`);
      }
      if (settings.authHeader === true && auth.header !== "Authorization") {
        throw new Error(`${provider}: authHeader:true is only supported for bearer-authenticated APIs`);
      }
      for (const headers of [settings.headers, model.headers]) {
        if (headers && Object.keys(headers).some((name) => /^(authorization|x-api-key|x-goog-api-key)$/i.test(name))) {
          throw new Error(`${provider}: authentication headers must be supplied by apiKey, not headers`);
        }
      }
      if (hosts.has(host) && hosts.get(host) !== provider) {
        throw new Error(`${provider}: ${host} is already bound to ${hosts.get(host)}; use one provider per endpoint host`);
      }
      if (injections.has(host) && injections.get(host).header !== auth.header) {
        throw new Error(`${provider}: models on ${host} must use the same authentication format`);
      }
      hosts.set(host, provider);
      injections.set(host, { domain: host, ...auth });
    }
    if (settings.modelOverrides && Object.values(settings.modelOverrides).some(
      (override) => override?.baseUrl || override?.api || override?.headers,
    )) {
      throw new Error(`${provider}: endpoint, API, and header overrides must be declared in models instead`);
    }
    credentials.push({
      service: provider,
      apiKey: { name: variable, proxyManaged: true, inject: [...injections.values()] },
    });
    secrets.push({ service: provider, command });
  }
  return {
    models,
    secrets,
    spec: {
      schemaVersion: "2",
      kind: "sandbox",
      name: "pi-multi",
      displayName: "Pi (multi-provider)",
      description: "Pi with proxy-managed providers configured from models.json",
      sandbox: { image: "docker.io/sbx/pi-image:latest", entrypoint: ["pi"] },
      agentInstructions: { filename: "AGENTS.md" },
      permissions: { network: { allow: ["registry.npmjs.org", ...hosts.keys()] } },
      credentials,
      setup: {
        install: [{
          command: 'if [ -n "${HTTP_PROXY:-}" ]; then npm config set proxy="$HTTP_PROXY" https-proxy="${HTTPS_PROXY:-$HTTP_PROXY}"; fi',
          user: "1000",
          description: "Configure npm to use the sandbox proxy",
        }],
      },
    },
  };
}

export function generateKit(input, output, configureSecrets = false) {
  const kit = buildKit(JSON.parse(readFileSync(input, "utf8")));
  if (configureSecrets) {
    for (const { service, command } of kit.secrets) {
      const args = ["secret", "set", service];
      if (command) args.push("--command", command, "--refresh", "30m");
      const result = spawnSync("sbx", args, { stdio: "inherit" });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`sbx secret set ${service} failed`);
    }
  }
  const home = resolve(output, "files/home/.pi/agent");
  mkdirSync(home, { recursive: true });
  writeFileSync(resolve(home, "models.json"), `${JSON.stringify(kit.models, null, 2)}\n`);
  // JSON is valid YAML, so no YAML dependency is needed for the v2 manifest.
  writeFileSync(resolve(output, "spec.yaml"), `${JSON.stringify(kit.spec, null, 2)}\n`);
  return kit;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const configureSecrets = args.includes("--configure-secrets");
    const positional = args.filter((arg) => arg !== "--configure-secrets");
    if (positional.length > 2 || positional.some((arg) => arg.startsWith("--"))) {
      throw new Error("Usage: node generate-kit.mjs [models.json] [output-directory] [--configure-secrets]");
    }
    const root = dirname(fileURLToPath(import.meta.url));
    const output = resolve(positional[1] ?? resolve(root, ".generated/pi"));
    const kit = generateKit(resolve(positional[0] ?? resolve(root, "models.json")), output, configureSecrets);
    console.log(`Generated kit: ${output}`);
    console.log(`Credential services: ${kit.secrets.map(({ service }) => service).join(", ")}`);
    if (!configureSecrets) console.log("Use --configure-secrets to register host-side credentials (review !commands first).");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
