# opencode-openchamber-remote

OpenCode tools that let an agent act on your **other** OpenChamber instances: list them, find a session, send work, read the result.

You work on your laptop. The job belongs on your VPS. Instead of switching windows, you say "ask the VPS to fix the deploy script", and the agent on your laptop calls `remote_send`. The VPS's own OpenChamber agent does the work there, with that machine's files, model and permissions, and its answer comes back into this chat.

This is an [OpenCode plugin](https://opencode.ai/docs/plugins/), not an OpenChamber extension: OpenChamber's extension SDK can style tool calls but cannot add agent tools. OpenChamber renders these tools like any other, so they work in the desktop app, the web UI, and the terminal.

## What you get

| Tool | What it does |
| --- | --- |
| `remote_hosts` | The instances this machine can reach, and each one's project directories. |
| `remote_sessions` | Recent sessions on one instance, newest first, filterable. |
| `remote_send` | Send a task to an existing session or start a new one. Waits for the turn and returns what the remote agent said. |
| `remote_check` | Is that session still working, what did it last say, is it blocked on an approval. |
| `remote_exec` | Run one shell command there and return exit code, stdout and stderr. |

An exchange looks like this:

```
you    ask the build box to fix the deploy script

agent  remote_hosts
       → build (build-box) — https://build.example.com
         projects: /srv/app, /srv/app-docs

       remote_sessions { host: "build", query: "deploy" }
       → ses_01h...  succeeded  38m ago  /srv/app  Deploy script rewrite

       remote_send { host: "build", sessionId: "ses_01h...", text: "Fix the deploy script" }
       → build (build-box) · ses_01h... · build · example/model-name · 41s

         Fixed the path in deploy.sh and added set -e.

       remote_exec { host: "build", command: "git -C /srv/app status --short" }
       → build (build-box) · /srv/app · exit 0 · 0.2s

         M deploy.sh
```

## Install

The plugin runs inside the **OpenCode server**, so install it where that server runs. For a desktop OpenChamber that is this machine; for a remote instance it is that server.

### From npm

```sh
opencode plugin add opencode-openchamber-remote
```

Or add it to `opencode.json` yourself:

```jsonc
{
  "plugins": ["opencode-openchamber-remote"]
}
```

### From git

```sh
opencode plugin add github:LuckyHead11/opencode-openchamber-remote
```

### From a checkout (development)

Point OpenCode at the folder; no copy, no build step:

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugins": ["C:/Users/you/source/repos/opencode-openchamber-remote"]
}
```

Relative paths resolve from the config file. A local plugin directory needs a `package.json` with `name` and `exports` — this repo has both, and OpenCode runs the TypeScript directly.

Restart OpenCode (or OpenChamber) after installing. In OpenChamber, a plugin dropped into `~/.config/opencode/plugins/` is picked up by the running server without a restart.

## Where hosts come from

### Automatically: the instances OpenChamber already saved

OpenChamber's desktop app keeps every instance you connected to in `~/.config/openchamber/settings.json`:

```jsonc
{
  "desktopHosts": [
    {
      "id": "vps-1",
      "label": "build",
      "url": "https://build.example.com/",
      "apiUrl": "https://build.example.com/",
      "clientToken": "oc_client_..."
    }
  ]
}
```

The plugin reads that file, so a host you can already open in OpenChamber needs no setup. `apiUrl` is preferred over `url`; a trailing slash is trimmed.

A host that only has a `relay://` address is reported as unusable. The private relay is an end-to-end encrypted WebSocket, not an HTTP API, so plain requests cannot reach it — pair the instance over a normal URL or a tunnel instead.

### Explicitly: `remote-hosts.json`

For a machine with no OpenChamber install of its own (a build server, the VPS itself), create `~/.config/openchamber/remote-hosts.json`:

```json
{
  "hosts": [
    { "id": "laptop", "label": "Laptop", "apiUrl": "http://192.0.2.10:8761", "token": "oc_client_..." }
  ]
}
```

Entries here add to the desktop hosts and override one with the same `id`. The shape is the same; `token` is accepted as an alias for `clientToken`.

### Getting a token

A client token is created when you pair a device with an instance. Pair once per machine that should talk to it (for example a device called "laptop agent"), then copy its `clientToken` out of that machine's `settings.json`, or paste it into `remote-hosts.json`. Revoking that device in OpenChamber revokes the token, and the tools start failing with a clear 401.

## Tools in detail

### `remote_hosts`

No arguments. Lists every configured instance, whether it answers, and its project directories. Call it first when the user names another machine.

OpenChamber registers a project per chat directory, so those are filtered out of the listing; a directory you pass to `remote_send` still works even if it is not listed.

### `remote_sessions`

| Argument | Meaning |
| --- | --- |
| `host` | Instance id or label, as `remote_hosts` prints it. |
| `query` | Optional text matched against title, directory and session id. |
| `limit` | How many to show, default 20. |

### `remote_send`

| Argument | Meaning |
| --- | --- |
| `host` | Instance id or label. |
| `text` | The task or message for the remote agent. Required, max 20,000 characters. |
| `sessionId` | Continue this session. Omit to start a new one. |
| `directory` | Project path **on the remote machine**. Required for a new session. |
| `title` | Title for a new session. Defaults to the start of `text`. |
| `model` | `provider/model` for a new session. Defaults to that instance's default model. |
| `wait` | Wait for the turn and return the reply. Default `true`. |
| `timeoutSec` | How long to wait. Default 300, max 3600. |

With `wait: true` it returns the reply and the model that produced it. If the deadline passes first, it returns the session id and says the turn is still running; `remote_check` picks it up later. With `wait: false` it returns immediately with the session id.

A new session inherits the instance's default model, which may be unavailable on that account. If the remote turn fails, the error is returned verbatim along with a hint to pass `model`.

### `remote_check`

| Argument | Meaning |
| --- | --- |
| `host` | Instance id or label. |
| `sessionId` | Session to inspect. |

Shows whether the session is working, its model, the last reply, any error, and how many approval requests are waiting on that machine.

### `remote_exec`

| Argument | Meaning |
| --- | --- |
| `host` | Instance id or label. |
| `command` | The command, run with that instance's shell. |
| `cwd` | Directory on the remote machine. Must be one of its projects or inside one. Defaults to its most recently used project. |
| `timeoutSec` | How long to wait. Default 60, max 600. |

Returns the exit code, stdout, stderr and how long it took. This is a real command on the other machine, run as that instance's user — it is not sandboxed and it is not a chat message. It goes through the same **bash permission rules** as the local bash tool, so a session that denies bash denies this too.

The instance only runs commands inside a project it knows, which is why `cwd` has to point at one (the tool finds the containing project for you). If you need a command outside every project, use `remote_send` and let the remote agent decide.

## Safety

- **Only configured hosts.** The model can name a host; it can never supply a URL or a token. Adding a host is a file edit you make.
- **`remote_exec` is a shell, not a sandbox.** It asks your bash permission rules first, and the instance refuses directories outside its projects, but the command runs with that user's full rights on that machine.
- **No silent approvals.** When the remote agent needs permission, the plugin reports it and stops. It never answers a remote approval prompt.
- **Capped input and output.** Prompts are limited to 20,000 characters; replies and command output are clipped at 8,000 with a marker.
- **Tokens stay in the config file.** The plugin sends them as `Authorization: Bearer` and never prints them.

The work really does run on the other machine: its model, its tools, its permissions, its bill. Treat `remote_send` with the same care as typing into that machine's chat box.

## How it works

Every call is plain HTTP against the instance's API, authenticated with the paired client token:

| Call | Endpoint |
| --- | --- |
| projects | `GET /api/project` |
| sessions | `GET /api/session` |
| one session | `GET /api/session/:id` |
| start a session | `POST /api/session?directory=...` |
| send | `POST /api/session/:id/prompt` |
| wait for the turn | `POST /api/experimental/session/:id/wait` |
| messages | `GET /api/session/:id/message?limit=N&order=desc` |
| approvals | `GET /api/session/:id/permission` |
| run a command | `POST /api/fs/exec?directory=...` |

`prompt` returns as soon as the message is queued, so `remote_send` waits on the wait endpoint and then reads the newest assistant message from the turn it started. Session-scoped calls carry `?directory=` for the session's project.

## Troubleshooting

| What you see | What it means |
| --- | --- |
| `the client token was rejected (401)` | The device was revoked or re-paired. Pair again, update the token. |
| `relay-only; the relay speaks an encrypted WebSocket, not HTTP` | That instance is only reachable through Private Relay. Give it a normal `apiUrl`. |
| `cannot reach ... (ECONNREFUSED)` | Wrong port, firewall, or the instance is not running. |
| `The remote turn failed: Model access is disabled` | That instance's default model is blocked. Pass `model: "provider/model"`. |
| `Still running ... after 300s` | A long turn or a waiting approval. `remote_check` for the detail; raise `timeoutSec` if it is just slow. |
| `Path is outside of active workspace` | `remote_exec` was given a directory the instance does not treat as a project. Pass a path from `remote_hosts`. |
| Tools do not appear | The server did not reload. Restart OpenChamber/OpenCode, then check `~/.local/share/opencode/log/`. |

## Compatibility

- Built for OpenCode 2.3 (`@opencode/plugin` 2.3.x), tested against OpenCode 2.3.0 and 2.3.2.
- The API surface it uses is the OpenCode server API that OpenChamber proxies; both ends should be on a 2.x release.
- If OpenCode changes its plugin contract, the `@opencode/plugin` dependency and this plugin need a matching release.

## Development

```sh
npm install
npm test          # unit tests for host parsing and reply extraction
npm run typecheck
npm run smoke     # real read-only calls: hosts + sessions on this machine
```

`npm run smoke` needs configured hosts and the network; it is not part of `npm test`.

Layout:

```
src/index.ts   plugin definition and the four tools
src/api.ts     HTTP calls, message parsing, model refs
src/hosts.ts   host discovery from settings.json and remote-hosts.json
test/          unit tests
scripts/       smoke script
```

## Publishing

See [PUBLISHING.md](./PUBLISHING.md) for the git, GitHub and npm steps, versioning, and what to tell people who want to install it.

## License

MIT
