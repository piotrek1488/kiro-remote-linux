# Kiro Remote on Ubuntu

A port for Ubuntu 22.04 and 24.04 LTS, on x86_64 and ARM64. The app is still an
extension for the desktop Kiro IDE, with a local relay server and a PWA
interface on your phone. macOS is still supported.

## Installing the prebuilt extension

1. Install and start [Kiro IDE](https://kiro.dev/downloads/) for Linux.
2. Install the required system tools:

   ```bash
   sudo apt update
   sudo apt install curl lsof tar systemd
   ```

3. In Kiro press **Ctrl+Shift+P → Extensions: Install from VSIX** and pick
   the `.vsix` file from this port. Reload the window if Kiro asks you to.
4. Open a project and run **Kiro Remote: Start Remote Session**, then
   **Kiro Remote: Show QR Code**. Scan the code with your phone.

The prebuilt extension uses the Node runtime bundled with Kiro, so you do not
need to install Node separately. Cloudflared is downloaded automatically to
`~/.kiro-remote/cloudflared`. Installation does not require administrator
privileges.

The Local WiFi code works on the same network. The Cloudflare Tunnel code also
works outside of it. Installing the PWA and receiving Push notifications on the
phone require HTTPS, which means the tunnel address; plain local HTTP is enough
for chat and approvals.

## Building from source

**Node.js 24 or newer** with npm is required. Check `node --version`; the
version from the default repository of an older Ubuntu release may be too old.
Current releases are available at [nodejs.org](https://nodejs.org/en/download).

In the directory of this port:

```bash
npm --prefix relay-server ci
npm --prefix extension ci
npm --prefix relay-server test
npm --prefix extension test
npm --prefix extension run package
```

Output file: `extension/kiro-remote-control-0.1.2.vsix`.
The version number comes from the base project; this package contains the
port's changes. Alternatively, if the `kiro` command is available:

```bash
kiro --install-extension ./extension/kiro-remote-control-0.1.2.vsix
```

Do not run Kiro or the extension with `sudo`.

## Kiro data and processes

- Default data directory on Ubuntu: `~/.config/Kiro`.
- With an absolute `XDG_CONFIG_HOME`: `$XDG_CONFIG_HOME/Kiro`.
- After activation the extension uses the `globalStorageUri` provided by Kiro,
  also when a custom `--user-data-dir` is used.
- Chat history (current Kiro, verified on 1.1.14):
  `~/.kiro/sessions/<workspace-hash>/sess_<uuid>/` with `session.json` and
  `messages.jsonl`. This location does not depend on `--user-data-dir`.
- Older Kiro releases: `User/globalStorage/kiro.kiroagent/workspace-sessions` and
  execution logs in `User/globalStorage/kiro.kiroagent/<hash>/414d1636299d2b9e4ce7e17fb11f63e9`.
  Both layouts are read, so the extension works with either.
- Relay files, token and QR codes: `~/.kiro-remote/`.

The selected data path is printed in **Kiro Remote: Show Logs**. The history
format depends on the Kiro version, just like in the original project.

Tool approvals from the phone work in two ways: through the hook scripts, and
for Kiro's own permission prompts (Allow / Deny) through
`~/.kiro/sessions`. For the second one the extension runs
`kiroAgent.execution.runOrAcceptAll` or `kiroAgent.execution.rejectAll`, which
act on the prompt shown in the last active chat view. To avoid answering the
wrong prompt, it only does this when exactly one prompt is pending and it is
still unanswered at that moment; otherwise approve in the IDE. "Always allow"
is never offered on the phone. Questions that need a typed answer are not
forwarded.

`kiroRemote.preventSleep` runs `systemd-inhibit --what=idle:sleep` for the
duration of the session. Stopping the session ends the inhibitor together with
its helper process. It requires a working `systemd-logind` and permission from
the user session policy. If this feature is unavailable, the relay still works;
the error goes to the log. You can turn it off:

```json
{ "kiroRemote.preventSleep": false }
```

## Troubleshooting

**The phone does not connect over WiFi:** check that both devices are on the
same network, look for client isolation in the router, and check the firewall.
If UFW is active, allow the port only from your own network, e.g. for the LAN
`192.168.1.0/24`:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 3737 proto tcp
```

Adjust the subnet and port to your setup. The tunnel does not require opening
an incoming port on the router.

**The tunnel does not start:** check the logs, access to GitHub and the
Cloudflare network. Cloudflared needs an outgoing connection to Cloudflare on
port 7844. You can download it in advance, from the source directory:

```bash
sh relay-server/scripts/install.sh
```

You can also use the [official Cloudflare installation](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
The local WiFi connection also works without the tunnel.

**No history:** run at least one conversation in Kiro. Check that
`~/.kiro/sessions/` contains a directory with `sess_*/messages.jsonl` for your
project (older Kiro: that the path in the extension log contains
`workspace-sessions`).

**Port in use:** close the old session or change `kiroRemote.relayPort`.
Detecting an old server requires `lsof`. Hook scripts receive the current port
during installation by the extension.

## Verification

The tests cover reading history and responses from files, chat updates through
`fs.watch`, the local HTTP/WebSocket relay, sending instructions, authorization
and allow/deny decisions for hooks, selecting and installing cloudflared, and
cleaning up inhibitor processes. CI builds and packages the extension on
Ubuntu 22.04, Ubuntu 24.04 and macOS. The installer tests use controlled
executables and do not open a public tunnel.

A full test with a real desktop Kiro, a phone and a systemd-logind session
should be done after installation. The server tests do not confirm that Kiro's
internal commands are available in every IDE version.
