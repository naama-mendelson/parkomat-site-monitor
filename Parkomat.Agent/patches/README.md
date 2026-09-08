# patches/

Written in English like the other instruction files; the patch's own comments stay Hebrew.

## What this is

`agent12-udp-fc.patch` carries two configuration options and their diagnostics back onto the
**1.0.20** agent — the build behind `installer-output/ParkomatAgentSetup 12.exe` (12/08/2026).
It produces `ParkomatAgentSetup-12-udp.exe`, which still reports version **1.0.20**.

It exists because of a request that is not a mistake: **a site that must change in exactly one
way.** A site already running 1.0.20 that needs a UDP controller should not, in the same visit,
also receive the durable queue, the direct Supabase path, the heartbeat and the MQTT-off
switch. If something breaks afterwards, one variable moved and it is obvious which. `main` is
the right answer for a *new* site; this is the answer for an existing one.

## How the base was identified — measured, not assumed

`f201028` (12/08) is the last commit touching `Parkomat.Agent/` before the installer's own
timestamp, and its `.csproj` says `1.0.20`, matching the ProductVersion embedded in her file.

⚠️ **That is inference, so it was checked against the artefact.** A build from `f201028` came
out **256 bytes** from `Agent 12`, while 1.0.36 and 1.0.37 differ by 58 KB and 76 KB. A small
code change on the same base looks like the former; a different codebase looks like the latter.

## What the patch adds — and nothing else

| | |
|---|---|
| `Plc.Transport` | `"tcp"` (default) / `"udp"` — Modbus over UDP, MBAP framing |
| `Plc.FunctionCode` | `4` (default) / `3` — Input vs Holding Registers |
| Both selectors | in the **registers dialog**, not the main settings form |
| Diagnostics | the transport and function code in the startup line, and a decoded reason on failure |

Both defaults are exactly today's behaviour, so **a site nobody touches does not change.**

⚠️ **The version number is deliberately still 1.0.20.** She asked for the agent she brought,
changed in one way only. The cost is that Windows' program list cannot tell the two installers
apart — only the file name does.

## Three things the patch protects that are easy to get wrong

**One seam for every read.** Three places called `ReadInputRegisters` directly — the triple
read, the single read, and the fault text. With a function-code option that becomes three
places somebody must remember; a forgotten one reads with the wrong code **silently**. They
all go through `ReadBlock` now.

**Both choices survive `BuildResetConfig`.** The installer drops `reset-to-defaults.flag` on
every install, so an unpreserved field is wiped on every upgrade. The address and registers
still reset — that is the documented decision — but a wrong *transport* or *function code*
fails identically to a wrong address while leaving **nothing in the file** to show that anyone
chose otherwise, and the defaults are wrong for precisely the sites this exists for.

**⚠️ A wrong function code may not produce an error at all.** Measured: reading `0x03` at
addresses that only exist under `0x04` **succeeded** and returned `0/0/0` — and MODE 0 is a
legitimate state, *maintenance*. A misconfigured site would report maintenance forever: no
error, no log line, a green tray icon. `Worker` now logs one warning when a read comes back all
zeros. A hint, not an error: a brand-new controller can legitimately read zeros, and failing on
that would take down a healthy site.

## What is still 1.0.20, and is not fixed here

**`cleansession true`** in the bridge — measured **0 of 5** messages survive an internet
outage, against 5 of 5 with `false`. Fixed in 1.0.22, deliberately **not** backported: it is a
second variable, and the request was one. It is a one-line change if it is ever wanted.

**Uninstalling deletes `{commonappdata}\Parkomat`** — `config.json`, so the site id, the
HiveMQ password and the Supabase password. Fixed in 1.0.32.
⚠️ **Install over the top. Never uninstall first.** A normal install does not run the old
uninstaller, so upgrading is safe; removing the program first erases the site's identity, and
the Supabase password is displayed exactly once at issue.

## Rebuilding

The worktree it was produced in is temporary, so start from the commit:

```sh
git worktree add /tmp/agent12 f201028
cd /tmp/agent12
git apply Parkomat.Agent/patches/agent12-udp-fc.patch
cp <this repo>/Parkomat.Agent/agent-defaults.password Parkomat.Agent/
```

⚠️ **That last line is not optional, and forgetting it ships a broken installer.** The HiveMQ
password is burned into the build from a git-ignored file, so a worktree does not carry it. The
build says so — `BuildDefaults: אין agent-defaults.password — ברירת מחדל ריקה (תקין לפיתוח;
לא לשיגור)` — and that line was missed once: the installer went out, the settings form showed
an empty password field, and it read as "the agent is not saving the password". **Verify the
string is in `Parkomat.Agent.Core.dll` before packaging.**

Then, in `Parkomat.Agent/`:

```sh
dotnet build src/Parkomat.Agent.Service -c Release
dotnet build src/Parkomat.Agent.Tray    -c Release
```

⚠️ **`dotnet publish` fails on this commit** (`MSB3030`, a missing `runtimeconfig.json`), and
`dotnet test` fails with it — both predate this change and neither is worth fixing on a frozen
base. Copy the **build** output instead: it is byte-identical in composition (229 files,
`includedFrameworks` in the runtimeconfig, i.e. self-contained) to what publish produces on
`main`.

```sh
mkdir -p publish/service publish/tray
cp -r src/Parkomat.Agent.Service/bin/Release/net10.0/win-x64/.      publish/service/
cp -r src/Parkomat.Agent.Tray/bin/Release/net10.0-windows/win-x64/. publish/tray/
```

⚠️ **`installer.iss` hard-codes absolute source paths**, and unpatched they point at the *main*
working copy — so compiling it as-is packages **`main`'s binaries under a 1.0.20 label**, which
is precisely the version lie `Directory.Build.props` exists to prevent. Repoint them, set
`OutputBaseFilename`, and then **verify the ProductVersion of the compiled setup**, not just of
the sources.

## Verification

`main`'s test project does not build on this commit, so the assertions were run from standalone
harnesses against the **exact DLLs that were packaged** — not an earlier build of the same
source. 80 checks, and the ones that earn their place:

- **UDP behaves identically to TCP** — same slave, same data, every field equal. The other
  tests show UDP *works*; only this one shows it behaves the *same*, which was the requirement.
- **A UDP-only server refuses a TCP request** — both read tests pass against a reader that
  ignores `Transport`, because each raises only the server it tests. This one does not.
- **0x03 and 0x04 against different values at the same addresses** — a reader that ignores the
  setting gets a number, just not the right one.
- **A controller that actually rejects** — the whole `Explain` translation had never executed,
  because the mock returns zeros instead of raising. Codes 1/2/3 now produce three *different*
  sentences, and the 0x03↔0x04 suggestion flips with the configured code.
- **The dialog driven for real** — WinForms, off-screen, both selectors round-tripped together.
  ⚠️ `PerformClick` does nothing on a form that was never shown, and the first version of that
  test reported four failures that were in the test, not the product.

⚠️ **Measured and left alone:** a TCP socket that accepts but never answers costs **12,818 ms**
per read (four NModbus attempts), against **3,833 ms** for the UDP equivalent, where the same
ceiling is divided across the attempts. The tray watchdog kills at 30,000 ms, so both are safe —
but the margin on TCP is 2.3× rather than 7.8×. This is existing behaviour, not something the
patch introduced, and changing it would move all 21 sites.
