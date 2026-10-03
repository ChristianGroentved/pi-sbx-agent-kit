# pi-sbx-agent-kit

A multi-provider Docker sandbox kit for [pi](https://github.com/docker/sbx-kits-contrib/tree/main/pi),
using its upstream prebuilt image. **Edit only `models.json`**: the generator
derives the network allowlist, credential bindings, and pi configuration.
No image build or npm install is needed.

## Setup

Requires Node.js 22+ and the current [Docker Sandboxes `sbx` CLI](https://docs.docker.com/ai/sandboxes/install/).
These are schema-v2 kits, like the upstream pi kit; use `sbx`, not the legacy
`docker sandbox` CLI.

1. Edit `models.json`, or use your existing pi models file. The example includes
   Vertex MaaS models: replace `YOUR_PROJECT_ID` and check that the models are
   enabled in your project/location.
2. For GCP, authenticate **on the host** with `gcloud auth application-default login`.
3. Generate the kit and register host-side credentials:

   ```sh
   node /absolute/path/to/pi-sbx-agent-kit/generate-kit.mjs --configure-secrets
   ```

   To use your existing file without copying or maintaining a second one:

   ```sh
   node /absolute/path/to/pi-sbx-agent-kit/generate-kit.mjs \
     "$HOME/.pi/agent/models.json" --configure-secrets
   ```

4. Validate and launch the generated kit:

   ```sh
   sbx kit validate /absolute/path/to/pi-sbx-agent-kit/.generated/pi
   sbx run /absolute/path/to/pi-sbx-agent-kit/.generated/pi --name pi-multi
   ```

   Approve the kit's credential bindings when prompted. In pi, use `/model`
   to switch providers/models, or `/scoped-models` to configure cycling.

After changing models, endpoints, or credential commands, rerun the generator
and recreate the sandbox. Generated files are ignored by git; do not edit them.
An optional second positional argument chooses a different output directory.
Without `--configure-secrets`, generation does not invoke `sbx` or execute commands.

## Credentials and providers

Each provider ID becomes its host-side `sbx` secret service. `apiKey` accepts:

- **A host command**, such as your
  `!/opt/homebrew/bin/gcloud auth application-default print-access-token`.
  `--configure-secrets` registers it as a dynamic secret refreshed every 30 minutes:
  `sbx secret set gcp-oss-maas --command '…' --refresh 30m`.
  The command must be available to the **host daemon**, not installed in the sandbox.
- **An environment reference**, such as `${OPENAI_API_KEY}` or `$ANTHROPIC_API_KEY`.
  `--configure-secrets` invokes `sbx secret set <provider>` to store the key
  interactively; it does not copy your environment into the sandbox.

Real keys and GCP tokens remain on the host. The generated pi file replaces
command-based keys with environment references to proxy-managed sentinels.
`displayName` is translated to pi's `name`; other model metadata is preserved.
Review config files before registering `!commands`: they execute on the host.
Never put literal secrets in `models.json` or log in with pi's `/login` inside
the sandbox.

Add providers to the same `providers` object, for example:

```json
"openai": {
  "baseUrl": "https://api.openai.com/v1",
  "api": "openai-responses",
  "apiKey": "${OPENAI_API_KEY}",
  "models": [{ "id": "gpt-4.1" }]
},
"anthropic": {
  "baseUrl": "https://api.anthropic.com",
  "api": "anthropic-messages",
  "apiKey": "${ANTHROPIC_API_KEY}",
  "models": [{ "id": "claude-sonnet-4-5" }]
}
```

Supported adapters: `openai-completions`, `openai-responses` (bearer auth),
`anthropic-messages` (`x-api-key`), and `google-generative-ai` (`x-goog-api-key`).
Vertex IAM tokens use its **OpenAI-compatible endpoint**, not pi's native
`google-vertex`/ADC adapter. Claude subscription OAuth is not configured by this kit;
the Anthropic example uses an API key.

Every provider must declare an HTTPS `baseUrl`, `api`, `apiKey`, and nonempty
`models` list. Model-level `baseUrl`/`api` overrides are included in the generated
policy. Use one provider per endpoint host, with one authentication format per
host; proxy injection cannot distinguish providers by URL path. Authentication
headers must come from `apiKey`, not custom `headers`. Metadata-only
`modelOverrides` are preserved.

For a 401, check the host secret and approved binding. For blocked traffic,
check `sbx policy log pi-multi`. The image follows upstream `latest`; generation
does not pin the installed pi version.

## Local checks

```sh
node --test /absolute/path/to/pi-sbx-agent-kit/generate-kit.test.mjs
node --check /absolute/path/to/pi-sbx-agent-kit/generate-kit.mjs
```

The tests use Node's built-in runner and require no credentials or sandbox.
A live inference check requires `sbx` and authorized host credentials.
