# logiccMagpiePlugin

An unofficial, dependency-free Logicc provider plugin for [Magpie](https://usemagpie.ai/docs/plugins). Use only an account you are authorized to use and comply with the service's terms, limits and policies. This is an experimental adapter for Logicc's web API, not a vendor-supported OAuth grant or API.

## Install and sign in

1. `magpie plugin add github:reed6868/logiccMagpiePlugin` (or add the absolute path of a local clone).
2. `magpie plugin login logicc`
3. Choose **Logicc browser sign-in (private window)** and sign in yourself in the isolated Chrome/Chromium/Edge window. If the browser is not found, set `LOGICC_BROWSER` to its executable path. A graphical desktop is required. The plugin closes the window and removes its temporary profile after sign-in, cancellation or timeout. It never attaches to the user's normal browser.
4. Alternatively, choose **Logicc manual sign-in** and provide your own authorized Logicc client credential and, if necessary, its session ID. When no session ID is provided, the plugin accepts only an unambiguous active session (or the active session explicitly identified by Clerk). Treat the credential as a password: do not share it, enter it in chat, or put it into shell commands.
5. `magpie models | grep logicc` lists discovered models. The initial `logicc/default` entry resolves to the account's upstream default model (or its first model) when discovery succeeds.

## API and compatibility

- The gateway uses OpenAI Chat Completions (`@ai-sdk/openai-compatible`). Both streaming and non-streaming requests are supported. No separate adapter server is required.
- Logicc chat creation and generation use the account's actual model IDs. A temporary catalogue failure preserves Magpie's previous model list; unknown context/output limits use conservative 32,768/4,096 defaults, not vendor claims.
- AI SDK v6 SSE text and reasoning deltas are forwarded as OpenAI `content` and `reasoning_content`. Reported token usage is forwarded when available; unknown usage is not fabricated.
- Logicc's web chat API does not natively register arbitrary client functions. Client tools use the structured-prompt bridge adapted from logicc2api, and recognized upstream native tool events are also supported. Tool-mode text is buffered until completion so the JSON envelope and arguments can be validated before emitting indexed `tool_calls`. A provider-executed tool is not handed back to the client to repeat. The adapter does not execute client tools. This is not native constrained decoding or a complete JSON Schema validator.
- Text messages and function tools only. Images, file/audio inputs and unsupported tool kinds are rejected. Token limits are prompt instructions, not hard upstream sampling controls. Availability, output quality and quotas depend on Logicc and the signed-in account.

## Credential and request handling

Credentials are kept only in Magpie's account-scoped authentication store (`plugin-auth.json`, documented as mode 0600). They are sensitive plaintext secrets, not public configuration. The JWT expiry is read from the returned token, refresh occurs shortly before expiry, and rotated client credentials are saved through the Magpie auth contract. A 401 triggers one refresh/retry; revoked credentials mark the account expired. Rate limits return 429 and preserve Retry-After without retries or bypasses. A 403 model refusal is not treated as an expired account.

The plugin only sends sign-in credentials to the fixed Logicc Clerk origin and JWTs to the fixed Logicc application API. Redirects are refused. Browser sign-in uses a newly created profile with local process-pipe communication, not an open remote debugging port. Browser cookies, tokens, upstream private error bodies and user prompts are not logged or committed. For a revoked or compromised sign-in, revoke the vendor session and run `magpie plugin logout logicc`.

## Development

```sh
bun scripts/check.mjs
bun test
```

The tests use synthetic credentials, mock responses and fragmented SSE, and never contact a real account. GitHub Actions runs the checks on pull requests and main.

For an isolated Magpie installation, use the official sandbox procedure:

```sh
sb=$(mktemp -d)
m() { env HOME="$sb" XDG_CONFIG_HOME="$sb/.config" XDG_CACHE_HOME="$sb/.cache" MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add "$PWD"
m plugin
```

After real sign-in on a running local gateway, use the discovered model name to run two smoke requests (one text, one required function tool). The script reports HTTP status, time to first useful delta/text, output, finish reason, tool arguments and completion time without printing account credentials.

```sh
bun scripts/e2e.mjs logicc/<discovered-model-id>
```

The default gateway is `http://127.0.0.1:3425`; override it with `MAGPIE_URL` for a sandbox. If your local gateway requires a custom access key, use `MAGPIE_API_KEY` via your local secret environment.

## Acknowledgements

MIT-licensed upstream references and adapted logic:

- [JamesZhaoY/logicc2api](https://github.com/JamesZhaoY/logicc2api/tree/4e505ed): Clerk refresh, model discovery, AI SDK v6 parser and tool prompt/validation.
- [magpie-community/plugins](https://github.com/magpie-community/plugins/tree/e77dec9): Agnes, Gemini Web and MClaw isolated browser sign-in patterns and plugin hook checks.

Original copyright notices and the MIT license are preserved in LICENSE. Neither upstream project nor Logicc endorses this plugin.
