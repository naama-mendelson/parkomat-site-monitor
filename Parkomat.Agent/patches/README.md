# patches/

Written in English like the other instruction files; the patch's own comments stay Hebrew.

## Why a patch and not a branch

`1.0.20-udp.patch` carries the UDP work back onto the **1.0.20** agent — the build behind
`installer-output/ParkomatAgentSetup 12.exe` (12/08/2026, ProductVersion `1.0.20`).

It exists because of one request that is not a mistake: **a site that must change in exactly
one way.** A site already running 1.0.20 that needs a UDP controller should not, in the same
visit, also receive the durable queue, the direct Supabase path, the heartbeat and the
MQTT-off switch. If something breaks afterwards, one variable moved and it is obvious which.
`main` is the right answer for a *new* site; this is the answer for an existing one.

## How the base was identified — measured, not assumed

`f201028` (12/08) is the last commit touching `Parkomat.Agent/` before the installer's own
timestamp, and its `.csproj` says `1.0.20`, matching the ProductVersion embedded in her file.

⚠️ **That is inference, so it was checked against the artefact.** Compiled installer sizes:

| build | size | vs `Agent 12` |
|---|---|---|
| this patch, on `f201028` | 66,120,426 | **−256 bytes** |
| 1.0.36 | 66,178,295 | +57,613 |
| 1.0.37 | 66,197,120 | +76,438 |

256 bytes against a 66 MB payload is a small code change on the same base; tens of kilobytes
is a different codebase. If the numbers ever stop matching, the base moved.

## What it produces: **1.0.20.2**

Two changes, and the second is not the UDP work:

1. **Modbus over UDP**, identical in substance to `main` — `Plc.Transport`, the selector in
   `RegistersForm`, the choice surviving `BuildResetConfig`, the unknown-value warning, and
   the retry-division that keeps a failed UDP read as cheap as a failed TCP one.
2. **`cleansession false`** in `BridgeConfigWriter`. One line, in an unrelated subsystem.

⚠️ **On (2), and why it is here at all.** It contradicts "one variable" and was still taken,
because the alternative is shipping a build measured to lose data: `cleansession true` gives
**0 of 5** messages surviving an internet outage, against 5 of 5 with `false`
(`tools/cleansession-test.sh`). The two touch nothing in common — the Mosquitto bridge versus
the PLC read — so the isolation that motivates this patch survives.

⚠️ **`1.0.20.1` was built first and is the UDP change alone**, still in `installer-output/`.
Keep it: it is the artefact that makes "only UDP moved" a statement anyone can verify.

## What is still 1.0.20, and is not fixed here

**Uninstalling deletes `{commonappdata}\Parkomat`** — `config.json`, so the site id, the
HiveMQ password and the Supabase password. Fixed in 1.0.32, not backported.

**Install over the top. Never uninstall first.** A normal install does not run the old
uninstaller, so upgrading is safe; a technician who removes the program first erases the
site's identity, and the Supabase password is displayed exactly once at issue, so there is
nothing to copy it back from.

## Rebuilding

The worktree it was produced in is temporary, so start from the commit:

```sh
git worktree add /tmp/agent12 f201028
cd /tmp/agent12
git apply Parkomat.Agent/patches/1.0.20-udp.patch
```

Then, in `Parkomat.Agent/`:

```sh
dotnet build src/Parkomat.Agent.Service -c Release
dotnet build src/Parkomat.Agent.Tray    -c Release
```

⚠️ **`dotnet publish` fails on this commit** (`MSB3030`, a missing `runtimeconfig.json`) and
`dotnet test` fails with it — both predate the UDP change and neither is worth fixing on a
frozen base. Copy the **build** output instead: it is byte-identical in composition
(229 files, `includedFrameworks` in the runtimeconfig, i.e. self-contained) to what publish
produces on `main`.

```sh
mkdir -p publish/service publish/tray
cp -r src/Parkomat.Agent.Service/bin/Release/net10.0/win-x64/.         publish/service/
cp -r src/Parkomat.Agent.Tray/bin/Release/net10.0-windows/win-x64/.    publish/tray/
```

⚠️ **`installer.iss` hard-codes absolute source paths**, and on the unpatched file they point
at the *main* working copy — so compiling it as-is packages **`main`'s binaries under a
1.0.20 label**, which is precisely the version lie `Directory.Build.props` exists to prevent.
The patch repoints them; if the worktree lives somewhere else, repoint them again and then
**verify the ProductVersion of the compiled setup**, not just of the sources.

## Verification

`main`'s `PlcTransportTests` does not run here (the test project does not build on this
commit), so the same assertions were run from a standalone harness against the **exact DLLs
that were packaged** — not against an earlier build of the same source:

```
UDP: reads MODE / card / cycle from a real Modbus slave
the choice is honoured: a UDP-only server refuses a TCP request
TCP: still reads correctly (no regression)
"UDP " / "Udp" recognised · default TCP · garbage -> TCP but reported unknown
the choice survives BuildResetConfig · the address still resets
Transport is written to the file; UseUdp is not
a failed UDP read costs 3,803 ms   (the watchdog kills at 30,000)
bridge.conf carries cleansession false, and not true
the rest of the bridge settings did not move
```

Two of these earn their place specifically:

- **"a UDP-only server refuses a TCP request"** — both read tests pass against a reader that
  ignores `Transport` entirely, because each raises only the server it tests. This one does
  not.
- **`cleansession`** asserts the wrong value is *absent* as well as the right one present; the
  positive alone passes on a file containing both lines. Verified by mutation: putting `true`
  back turns it red.
