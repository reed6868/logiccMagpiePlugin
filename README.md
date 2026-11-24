# logiccMagpiePlugin

An unofficial, dependency-free Logicc provider plugin for [Magpie](https://usemagpie.ai/docs/plugins). Use only credentials and accounts you are authorized to use and comply with the service's terms, limits and policies. The web API adapter remains experimental; live end-to-end verification is required before merging the refactor.

## Install and sign in

1. `magpie plugin add github:reed6868/logiccMagpiePlugin` (or add the absolute path of a local clone).
2. `magpie plugin login logicc`
3. Choose **Logicc authorized credential import (optional session ID)** if you already have a client credential explicitly authorized for this use. The masked prompt accepts the existing credential value or an explicitly supplied Cookie header containing one unambiguous `__client` value. Other cookies are discarded; conflicting values and multiline headers are rejected. The session ID is optional: use the active session designated by Clerk, otherwise prefer the most recent active session (last-active timestamp, then update timestamp; deterministic ID order breaks ties). An explicit session ID overrides selection. Treat credentials as passwords; never share them, enter them in chat, or pass them on a command line.
4. `magpie models | grep logicc` lists discovered models. `logicc/default` pins the account's selected upstream model during successful sign-in. If the upstream does not identify a default, the initial selection is deterministic by model ID.

### Authentication status

The incompatible Device Grant login method has been removed. An authorized Clerk frontend-session credential is exchanged for a session JWT and model access is checked before the account is saved. Old device-grant accounts must sign in again. The plugin does not inspect browser profiles or extract browser sessions, and automatic browser sign-in is not implemented: no supported Logicc-to-plugin authorization handoff has been verified. It does not claim that opening the Logicc login page alone authorizes Magpie. No Logicc API key or end-user OAuth client ID is required by the remaining import method.

## API and compatibility

- The gateway uses OpenAI Chat Completions (`@ai-sdk/openai-compatible`). Both streaming and non-streaming requests are supported. No separate adapter server is required.
- Logicc chat creation and generation use the account's actual model IDs. Temporary catalogue failures retain the last successful per-session snapshot in the running host. Default model selection is persisted at sign-in and does not change with list order or upstream default flags; if it disappears, select an explicit model. Limits use actual upstream fields, exact host metadata, then conservative model-family estimates (e.g. Claude 200k context, Opus/Sonnet 32k output). These estimates are not vendor-guaranteed limits. Only unrecognized models fall back to 32,768/4,096.
- AI SDK v6 SSE text and reasoning deltas are forwarded as OpenAI `content` and `reasoning_content`. Reported token usage is forwarded when available; unknown usage is not fabricated.
- Logicc's web chat API does not natively register arbitrary client functions. Client tools use a structured-prompt bridge: normal answers are plain text; tool calls start with a JSON `tool_calls` envelope. A 256-character prefix probe releases ordinary text immediately once it diverges, while actual tool blocks are buffered for validation and indexed `tool_calls` emission. Reasoning is forwarded independently, including while a prefix or tool block is pending. Native tool events are supported; provider-executed tools are not returned for repetition. The adapter does not execute client tools. This is not native constrained decoding or a complete JSON Schema validator.
- Unsupported non-function tool definitions are ignored; image/file/audio/video content parts are replaced with explicit text placeholders, not forwarded. Unsupported token limits (`max_tokens`, `max_completion_tokens`) are ignored without altering the user's prompt. The request budget is 32 MiB before normalization, 16 MiB for forwarded text, 8 MiB for generated output, and a 15-minute total generation ceiling. Availability, output quality and quotas depend on Logicc and the signed-in account.

## Credential and request handling

Credentials are kept only in Magpie's account-scoped authentication store (`plugin-auth.json`, documented as mode 0600). They are sensitive plaintext secrets, not public configuration. Session JWT expiry and rotated client credentials are saved through the Magpie auth contract. A 401 triggers one refresh/retry; revoked credentials mark the account expired. Rate limits return 429 and preserve Retry-After without retries or bypasses. A 403 model refusal is not treated as an expired account.

The plugin sends sign-in credentials only to the fixed Logicc Clerk origin, and session JWTs only to the fixed Logicc application API. Redirects are refused. Tokens, upstream private error bodies and user prompts are not logged or committed. For a revoked or compromised sign-in, revoke the vendor session and run `magpie plugin logout logicc`.

## Development

```sh
bun scripts/check.mjs
bun test
```

The tests use synthetic credentials, mock responses and fragmented SSE, and never contact a real account. GitHub Actions runs the checks on pull requests and main.

For isolated native Ubuntu Linux testing (use a checkout of the PR branch, not the live plugin directory):

```sh
sb=$(mktemp -d)
m() {
  env HOME="$sb" XDG_CONFIG_HOME="$sb/.config" XDG_CACHE_HOME="$sb/.cache" \
    MAGPIE_NO_ACCOUNTS=1 MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"
}
m plugin add "$PWD" </dev/null
m plugin list
m plugin login logicc
m models | grep '^logicc/'
```

After real sign-in succeeds, start the isolated gateway and run three live smoke requests (ordinary text, ordinary text with tools enabled, required function tool). The script records first content/reasoning/delta timing, finish timing, content chunk count, tool arguments and HTTP status. A tool-enabled response with no early content or only one content chunk is not counted as a streaming pass. Reasoning may be absent for non-reasoning models. The script does not execute the requested tool.

```sh
env HOME="$sb" XDG_CONFIG_HOME="$sb/.config" XDG_CACHE_HOME="$sb/.cache" \
  MAGPIE_NO_ACCOUNTS=1 MAGPIE_ADDR=127.0.0.1:3499 magpie serve &
gateway_pid=$!
for i in $(seq 1 30); do
  m healthcheck --addr 127.0.0.1:3499 >/dev/null 2>&1 && break
  sleep 1
done
m healthcheck --addr 127.0.0.1:3499
MAGPIE_URL=http://127.0.0.1:3499 bun scripts/e2e.mjs logicc/default
# Repeat after the session JWT expires to exercise renewal, then clean up:
m plugin logout logicc
kill "$gateway_pid"
```

The default gateway is `http://127.0.0.1:3425`; override it with `MAGPIE_URL` for a sandbox. If your local gateway requires a custom access key, use `MAGPIE_API_KEY` via your local secret environment. This is a local gateway key, not a Logicc API key. Do not use the pre-login default model listing as proof of authentication. Real account login, model access, reasoning/streaming, tool calls and refresh are pending local verification; keep the PR open until these pass.

## Acknowledgements

MIT-licensed upstream references and adapted logic:

- [JamesZhaoY/logicc2api](https://github.com/JamesZhaoY/logicc2api/tree/4e505ed): Clerk refresh, model discovery, AI SDK v6 parser and tool prompt/validation.
- [magpie-community/plugins](https://github.com/magpie-community/plugins/tree/e77dec9): Agnes, Gemini Web and MClaw isolated browser sign-in patterns and plugin hook checks.

Original copyright notices and the MIT license are preserved in LICENSE. Neither upstream project nor Logicc endorses this plugin.
