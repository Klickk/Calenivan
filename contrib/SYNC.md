# Google Calendar two-way sync (vdirsyncer) — setup runbook

The app only ever reads/writes local `.ics` files under `~/.local/share/calendar/`.
`vdirsyncer` does the actual Google Calendar sync over OAuth. Your OAuth client
id/secret live in the (chmod 600) vdirsyncer config; the sensitive OAuth token
is written to `token_file` on first sync.

> Why OAuth and not a password? Google removed CalDAV-over-app-password support,
> so vdirsyncer talks to Google's Calendar API with an OAuth token instead. That
> means a one-time Google Cloud setup to mint an OAuth "Desktop app" client.

## 1. Install vdirsyncer (with Google support)
```bash
sudo pacman -S vdirsyncer python-aiohttp-oauthlib
```
`python-aiohttp-oauthlib` is the extra dependency the Google backend needs
(vdirsyncer 0.20+ is async/aiohttp-based).

## 2. Create a Google OAuth client
1. Go to https://console.cloud.google.com/ and create a project (any name).
2. APIs & Services → Library → enable **Google Calendar API**.
3. APIs & Services → OAuth consent screen → choose **External**, fill the
   required fields, and under **Test users** add your own Gmail address.
   (Leaving it in "Testing" is fine — you don't need Google verification.)
4. APIs & Services → Credentials → Create credentials → **OAuth client ID** →
   Application type **Desktop app**. Copy the **Client ID** and **Client secret**.

## 3. Install the vdirsyncer config
```bash
mkdir -p ~/.config/vdirsyncer
cp ~/Projects/Calenivan/contrib/vdirsyncer.conf ~/.config/vdirsyncer/config
chmod 600 ~/.config/vdirsyncer/config
```

## 4. Paste your client id + secret into the config
Edit `~/.config/vdirsyncer/config` and replace `PASTE_CLIENT_ID_HERE` /
`PASTE_CLIENT_SECRET_HERE` with the values from step 2.

## 5. Discover calendars and do the first sync
```bash
vdirsyncer discover        # opens a browser for the one-time OAuth consent,
                           # then answer 'y' to create/pair collections
vdirsyncer sync
ls ~/.local/share/calendar/    # each Google calendar is now a subdirectory
```
Tell me the subdirectory names that appear — I'll point new-event writes at the
right one (your main calendar) by setting EventStore's `writeDir` in
`src/main.js`. The friend's copy is hard-wired to his iCloud calendar's UUID, so
this **must** be updated or new events won't sync.

## 6. Enable periodic background sync
```bash
cp ~/Projects/Calenivan/contrib/calendar-sync.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now calendar-sync.timer
systemctl --user list-timers | grep calendar   # verify it's scheduled
```
The launcher (`bin/calendar`) also fires a non-blocking `vdirsyncer sync` each time
you open the popup, so it stays fresh between timer runs.

## Verify end-to-end
- Create an event in Google Calendar (web/phone) → wait for a sync (or run
  `vdirsyncer sync`) → open the popup; it should appear.
- Add an event in the popup → run `vdirsyncer sync` → it should show in Google
  Calendar.
