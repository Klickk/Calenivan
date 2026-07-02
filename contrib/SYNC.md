# iCloud two-way sync (vdirsyncer) — setup runbook

The app only ever reads/writes local `.ics` files under `~/.local/share/calendar/`.
`vdirsyncer` does the actual iCloud CalDAV sync. Your Apple password lives in the
system keyring (gnome-keyring), never in a config file.

## 1. Install vdirsyncer
```bash
sudo pacman -S vdirsyncer
```

## 2. Generate an Apple app-specific password
Because your Apple ID has 2FA, you need an app-specific password (NOT your real one):
1. Go to https://appleid.apple.com → Sign-In and Security → App-Specific Passwords.
2. Create one (e.g. label it "vdirsyncer"). Copy the generated value.

## 3. Store the password in the keyring
Replace `APPLE_ID_EMAIL` with your iCloud Apple ID. You'll be prompted to paste the
app-specific password (it is read from stdin, not shown, and goes straight to the keyring):
```bash
secret-tool store --label="iCloud CalDAV" service icloud-caldav account APPLE_ID_EMAIL
```

## 4. Install the vdirsyncer config
```bash
mkdir -p ~/.config/vdirsyncer
cp ~/Projects/Calendar/contrib/vdirsyncer.conf ~/.config/vdirsyncer/config
# Then edit the file and replace BOTH occurrences of APPLE_ID_EMAIL with your Apple ID.
sed -i "s/APPLE_ID_EMAIL/you@icloud.com/g" ~/.config/vdirsyncer/config   # <-- your address
```

## 5. Discover calendars and do the first sync
```bash
vdirsyncer discover        # answer 'y' to create/pair collections
vdirsyncer sync
ls ~/.local/share/calendar/    # each iCloud calendar is now a subdirectory
```
Tell me the subdirectory names that appear — I'll point new-event writes at the right
one (your main calendar), by setting EventStore's `writeDir` in `src/main.js`.

## 6. Enable periodic background sync
```bash
cp ~/Projects/Calendar/contrib/calendar-sync.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now calendar-sync.timer
systemctl --user list-timers | grep calendar   # verify it's scheduled
```
The launcher (`bin/calendar`) also fires a non-blocking `vdirsyncer sync` each time you
open the popup, so it stays fresh between timer runs.

## Verify end-to-end
- Create an event on your iPhone → wait for a sync (or run `vdirsyncer sync`) → open the
  popup; it should appear.
- Add an event in the popup → run `vdirsyncer sync` → it should show on your iPhone.
