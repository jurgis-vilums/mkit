# mkit runbook — for Claude on the new machine

You are finishing a migration of Jurgis's Claude Code setup onto this machine. `mkit import` already ran.
State lives in `~/.mkit/` (`state.json`, `manifest.json`, `payload/`, `shell/`). The old PC's dashboard shows this machine's checklist.

## Loop
1. `node ~/.mkit/kit/bin/mkit.js status` — read every item that is not `ok`.
2. Handle items in this order: `failed` → `needs-agent` → `todo`.
3. After each item, record the result: `node ~/.mkit/kit/bin/mkit.js mark <id> <ok|failed|needs-agent|todo> <short reason>` (this also reports to the dashboard).
4. Verify before marking `ok` — run the thing (e.g. `gh auth status`, `ssh -T git@github.com`, open the app URL, `claude mcp list`).
5. Re-run `mkit import --resume` after fixing a root cause that affects several `failed` items.

## Item guidance
- **tool needs-agent**: install with the platform's package manager or the vendor's official installer; verify `<tool> --version`.
- **secret relogin** (e.g. `az login`): ask Jurgis to complete the browser login; verify; mark ok.
- **Claude credentials on macOS**: run `claude`, use `/login`.
- **project needs-agent (hardcoded source paths)**: show Jurgis the hits (`grep -rn "C:[\\/]Users[\\/]vilum" <project>`), propose the edit, apply only after he agrees.
- **scheduled task / startup needs-agent (Linux/macOS)**: these only appear when owner is `new`/`both` (owner `old` items are already `ok` — "stays on the old PC", nothing to install). Propose a systemd `--user` timer/service or a launchd agent that reproduces the trigger and command in the reason, and enable a singleton only after the old PC's copy was disabled (dashboard Services tab).
- **cloudflared**: only if owner is `new`/`both` — and only after the old PC's tunnel was disabled (check the dashboard's Services tab).
- **Moving service ownership later**: Jurgis changes it on the dashboard (which disables/enables the old PC's copy and tells him anything left to do by hand); then run `mkit services sync` here. `services sync` applies node-apps automatically; for every other service it prints "not a node-app, handle via RUNBOOK" — for those, apply the new owner yourself: owner `new`/`both` → install/enable as described for scheduled tasks/startup/cloudflared above; owner `old` → stop and disable the unit you created here (`systemctl --user disable --now …` / `launchctl bootout …` / `Disable-ScheduledTask`). Then `mkit mark <id> ok "<what you did>"`.

## Shell extras (📝 TODO items)
Files are saved under `~/.mkit/shell/<key>/`.
- **Windows target**: restore each to its original location (shown in the reason), then verify: open a new `pwsh` (profile loads without errors), run the AHK script (hotkeys work), open PowerToys Keyboard Manager (remaps listed). Mark ok.
- **macOS / Linux target**: do NOT port anything on your own. Summarise what each file does (aliases, functions, hotkeys, key remaps) in a short table, then ask Jurgis: *"Shall we brainstorm how to port these (e.g. zsh aliases, skhd/Karabiner on macOS, keyd/AutoKey on Linux)?"* Leave the items as `todo` until he decides; if he dismisses one, mark it `ok` with reason "dismissed by Jurgis".

## Done
When nothing is `failed` or `needs-agent`, run `mkit report` and tell Jurgis the counts and which `todo` items remain.
