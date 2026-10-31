# Zhongshuo DSH runtime

Original MIT implementation; no OpenDesign source is copied. Supports exactly
`@deepseek-ai/dsh@0.2.1-rc.5` (official npm latest/next inspected 2026-10-31).
Release metadata: https://registry.npmjs.org/@deepseek-ai%2fdsh/0.2.1-rc.5
Official source: https://github.com/deepseek-ai/deepseek-harness

The bundle adds a JSONL v1 surface to the official `dsh-base` profile. Official
agents, tools, model routing, session persistence and cancellation remain in use.
It accepts only `dsh --profile zhongshuo --zs-stdio`, `--zs-probe`, or `--zs-models`.
Normal work uses `full`. `readonly` is rejected before agent creation.
Version 0.1.2 also supports text-only `format-repair` with a required `outputSchema`
and a fresh session (no `sessionId`). It formats supplied content without doing
task work; it does not expand normal work permissions or provide general readonly execution.
This profile uses danger-full-access / never approval. It does not implement
interactive approvals. Images may contain base64 `data` and `mediaType`/`mimeType`;
the main application can decline images until separately certified.

Build: `node scripts/build-dsh-runtime.mjs` produces `dist/dsh-runtime/` containing
the npm-compatible tgz, SHA256 manifest, and standalone manual setup script.
Portable packaging should include those files and the launcher resolver below. No root dependency changes
or package-manager commands are needed to build. Nothing auto-installs on launch.

The setup directory also includes the shared `executable.mjs` launcher resolver.
It supports both npm DSH and the official Windows desktop installer (Electron
Node mode with its packaged ASAR entry); Pi's managed installer shim and npm
shim are resolved without a shell. Keep this file beside the setup script.

After the user separately installs official DSH **0.2.1-rc.5** and its profile
package manager, run the bundled `node setup-deepseek-harness.mjs --install`.
From source it defaults to `<source root>/dist/dsh-runtime` independently of cwd.
`--help` shows the required `--install` switch. Optional `--dsh PATH` selects a
CLI executable; `--dsh-js PATH` selects the official `dsh/lib/bin.js` for Node.
The script verifies version and archive hash, invokes only
`dsh plugin --profile zhongshuo add --save-exact <tgz>`, then verifies the probe.
It never installs DSH itself or targets the default or OpenDesign profile.

Resume is exact: missing logs or mismatched cwd fail, without new-session fallback.
Each new request receives a random session identity. One active request is allowed
per process; hosts start separate processes for concurrent agents. Cancellations
cover unpublished creation through AbortSignal, then call the official cancel API.
Only a durable `turn/end` with `completed` can succeed; `max-tokens`, absent
terminals and teardown/persistence errors fail. Output waits for flush and owned
agent disposal. Malformed JSONL terminates the transport; request IDs are unique.
`capabilities.outputSchema` means the complete literal schema and final-JSON rules
are installed in the actual agent system prompt. The host must still validate the
result; this is not provider-side constrained decoding. No TaskComplete is synthesized.
`capabilities.formatRepair` means setup applies agent-scoped native presentation,
an empty inherited-tool allowlist, a monotonic deny guard, and prepended
`tools/pre-execute`/`tools/execute` interceptors. Final prompt assembly removes all
tool schemas, including scoped, late and extension-added tools. Interceptors reject
stale names and `run_code` without delegating to execution hooks. Any unsolicited
model tool call fails and cancels repair before dispatch, with no tool frames sent
to the host. Repair uses the same durability and cleanup barriers as normal work.

Launch fingerprints must resolve `DSH_HOME` (nonempty override, tilde expansion,
otherwise OS homedir + `.dsh`), and include the home `cordis.patch.yml`, legacy
`settings.yaml` if present, profile `package.json`, `cordis.patch.yml`,
`pnpm-lock.yaml`, `pnpm-workspace.yaml`, and installed bundle entry/patch/manifests.
The exact profile prefix is `<resolveDshHome()>/profiles/zhongshuo/`; its installed
plugins live under that directory's `node_modules`. Include `compatibility.json`
(official version-exemption policy) and `cordis.yml` (launcher root) when present.
Home-level files above live
directly under `<resolveDshHome()>`, not inside a profile.
Credentials precedence is `.credentials.yaml` in Harness home, inherited process
environment, invocation cwd `.env`, home `.env`. Only hash relevant values/content;
never store or log secrets. Shared agent resources use `DSH_AGENTS_HOME` or
`~/.agents`. Do not fingerprint sessions, attachments, storages, cache or logs.
Official code confirming paths: published `dsh-home-paths`, `dsh-app-boot`,
`dsh-credentials-local`, and `dsh-settings` at the locked version.

## Verification (Windows, 2026-10-31)

`node --test packages/dsh-runtime/test/protocol.test.mjs` passes 17 protocol tests.
For opt-in official-CLI verification, set `ZHONGSHUO_DSH_TEST_CLI` to the absolute
official `dsh/lib/bin.js` path, and run
`node --test packages/dsh-runtime/test/official-cli.test.mjs`.
The test uses a freshly isolated `DSH_HOME` and `DSH_AGENTS_HOME`, an environment
allowlist without provider credentials, and a test-only scripted LlmAdapter.
The fixture is excluded from the production archive. No real model is contacted.
The test stages this package in a temporary profile without a package manager or
changes to shared node_modules. Its 27 checks cover probe/catalog, effort metadata,
the official agent/tool/persistence loop, streaming and usage, exact restart resume,
fresh-session isolation, missing/wrong-cwd session rejection, readonly rejection,
max-tokens failure, error redaction and active/startup/pre-execute cancellation,
the full TaskComplete schema at the actual SDK provider boundary, exact resultKey,
empty repair tool schemas, global/scoped/late/stale/run_code denial, execution hook
blocking, guard behavior after an extension returns allow, and unsolicited model
tool calls failing before dispatch.
These checks passed against the released Windows CLI. Real provider requests,
image input, native shell execution and sandbox enforcement are not certified.
