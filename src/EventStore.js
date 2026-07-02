// Reads a "vdir" (a directory tree of *.ics files, one event each — the format
// vdirsyncer produces) and indexes events by local date. Also writes new events
// back as *.ics so they sync up on the next vdirsyncer run.
//
// Parsing/recurrence handled by the vendored ical.js.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import ICAL from '../vendor/ical.js';

const pad = (n) => String(n).padStart(2, '0');

// iCloud/vdirsyncer store colors as #RRGGBBAA; GTK/Pango markup wants #RRGGBB.
const normalizeColor = (raw) => {
    const s = (raw || '').trim();
    if (/^#[0-9a-fA-F]{8}$/.test(s)) return s.slice(0, 7);
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
    return null;
};

export class EventStore {
    constructor(options = {}) {
        // Read root: ~/.local/share/calendar (vdirsyncer collections are subdirs
        // here, scanned recursively). Write dir: where new events are saved —
        // set this to a specific synced collection once iCloud sync is on.
        const base = GLib.build_filenamev([GLib.get_user_data_dir(), 'calendar']);
        this._dir = options.dir || base;
        this._writeDir = options.writeDir || this._dir;
        this._defaultColor = options.defaultColor || '#4aa3ff'; // events not in a collection
        this._byDate = new Map();     // 'YYYY-MM-DD' -> [entry]
        this._colors = new Map();     // collection dir name -> '#RRGGBB'
        this._calendars = new Map();  // collection -> {name, color}, only if it has events
    }

    get dir() {
        return this._dir;
    }

    ensureDir() {
        GLib.mkdir_with_parents(this._writeDir, 0o755);
    }

    // (Re)build the index from disk.
    load() {
        this._byDate.clear();
        this._colors.clear();
        this._calendars.clear();

        // Expansion window for recurring events (keeps iteration bounded).
        const from = ICAL.Time.now();
        from.year -= 1;
        const until = ICAL.Time.now();
        until.year += 2;
        this._from = from;
        this._until = until;

        const paths = [];
        this._collectIcs(this._dir, paths);
        for (const path of paths) {
            try {
                this._indexFile(path);
            } catch (e) {
                logError(e, `EventStore: failed to parse ${path}`);
            }
        }
    }

    _collectIcs(dir, out) {
        const d = Gio.File.new_for_path(dir);
        let en;
        try {
            en = d.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE, null);
        } catch (_e) {
            return; // dir doesn't exist yet — fine, no events.
        }
        let info;
        while ((info = en.next_file(null)) !== null) {
            const child = GLib.build_filenamev([dir, info.get_name()]);
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                this._collectIcs(child, out);
            else if (info.get_name().endsWith('.ics'))
                out.push(child);
        }
    }

    _indexFile(path) {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok) return;
        const text = new TextDecoder().decode(bytes);
        const comp = new ICAL.Component(ICAL.parse(text));
        const collection = this._collectionOf(path);
        const color = this._colorFor(collection);
        const vevents = comp.getAllSubcomponents('vevent');
        if (vevents.length > 0)
            this._registerCalendar(collection, color);
        for (const ve of vevents) {
            try {
                this._indexEvent(ve, { color, path });
            } catch (e) {
                logError(e, `EventStore: skipping bad event in ${path}`);
            }
        }
    }

    // Record a calendar that has at least one event (for the legend). Skips
    // loose files and collections that only hold VTODOs (e.g. Reminders).
    _registerCalendar(collection, color) {
        if (collection === null || this._calendars.has(collection)) return;
        this._calendars.set(collection, { name: this._nameFor(collection), color });
    }

    // A collection's human name from its vdirsyncer `displayname` file.
    _nameFor(collection) {
        try {
            const [ok, bytes] = GLib.file_get_contents(
                GLib.build_filenamev([this._dir, collection, 'displayname']));
            if (ok) {
                const n = new TextDecoder().decode(bytes).trim();
                if (n) return n;
            }
        } catch (_e) {
            // no displayname — fall through
        }
        return collection;
    }

    // [{name, color}] for calendars that have events, alphabetical (for a legend).
    calendars() {
        return [...this._calendars.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    // The collection (immediate subdir of the read root) a file belongs to,
    // or null if it's a loose file directly in the root.
    _collectionOf(path) {
        if (!path.startsWith(this._dir + '/')) return null;
        const rel = path.slice(this._dir.length + 1);
        const slash = rel.indexOf('/');
        return slash === -1 ? null : rel.slice(0, slash);
    }

    // '#RRGGBB' for a collection, read from its vdirsyncer `color` metadata file
    // (cached). Falls back to the default color.
    _colorFor(collection) {
        if (collection === null) return this._defaultColor;
        if (this._colors.has(collection)) return this._colors.get(collection);
        let color = this._defaultColor;
        try {
            const [ok, bytes] = GLib.file_get_contents(
                GLib.build_filenamev([this._dir, collection, 'color']));
            if (ok) color = normalizeColor(new TextDecoder().decode(bytes)) || this._defaultColor;
        } catch (_e) {
            // no color file — keep default
        }
        this._colors.set(collection, color);
        return color;
    }

    _indexEvent(vevent, ctx) {
        const ev = new ICAL.Event(vevent);
        if (!ev.startDate) return;
        const meta = {
            summary: ev.summary || '(no title)',
            color: ctx.color,
            path: ctx.path,
            uid: ev.uid || '',
        };

        if (ev.isRecurring()) {
            let dur = null;
            try { dur = ev.duration; } catch (_e) { /* no duration */ }
            const it = ev.iterator();
            let t;
            let guard = 0;
            // ical.js returns a falsy value (undefined/null) when exhausted.
            while ((t = it.next()) && guard < 800) {
                guard++;
                if (t.compare(this._from) < 0) continue;
                if (t.compare(this._until) > 0) break;
                let end = null;
                if (dur) {
                    end = t.clone();
                    end.addDuration(dur);
                }
                this._pushSpan(t, end, meta);
            }
        } else {
            this._pushSpan(ev.startDate, ev.endDate, meta);
        }
    }

    // Add one entry per day the event covers. All-day DTEND is exclusive;
    // timed events include their end day unless they end exactly at midnight.
    _pushSpan(startT, endT, meta) {
        const allDay = startT.isDate;
        const first = new Date(startT.year, startT.month - 1, startT.day);

        // For a single-day timed event, expose the end time so the row can show
        // a range ("14:00–15:30"). Multi-day/all-day spans get no end label.
        const sameDayTimedEnd = endT && !allDay &&
            endT.year === startT.year && endT.month === startT.month && endT.day === startT.day;
        const endLabel = sameDayTimedEnd ? `${pad(endT.hour)}:${pad(endT.minute)}` : '';

        let endExclusive;
        if (!endT) {
            endExclusive = new Date(first);
            endExclusive.setDate(endExclusive.getDate() + 1);
        } else if (allDay) {
            endExclusive = new Date(endT.year, endT.month - 1, endT.day);
        } else {
            endExclusive = new Date(endT.year, endT.month - 1, endT.day);
            const midnight = endT.hour === 0 && endT.minute === 0 && (endT.second | 0) === 0;
            if (!midnight) endExclusive.setDate(endExclusive.getDate() + 1);
        }
        if (endExclusive <= first) { // always at least the start day
            endExclusive = new Date(first);
            endExclusive.setDate(endExclusive.getDate() + 1);
        }

        const cur = new Date(first);
        let isStart = true;
        let guard = 0;
        while (cur < endExclusive && guard < 400) {
            const key = `${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}`;
            const timed = !allDay && isStart; // show a time only on the start day
            this._pushEntry(key, {
                summary: meta.summary,
                color: meta.color,
                path: meta.path,
                uid: meta.uid,
                allDay: allDay || !isStart,
                continuation: !isStart,
                timeLabel: timed ? `${pad(startT.hour)}:${pad(startT.minute)}` : '',
                endLabel: timed ? endLabel : '',
                minutes: timed ? startT.hour * 60 + startT.minute : -1,
            });
            cur.setDate(cur.getDate() + 1);
            isStart = false;
            guard++;
        }
    }

    _pushEntry(key, entry) {
        const list = this._byDate.get(key);
        if (list) list.push(entry);
        else this._byDate.set(key, [entry]);
    }

    hasEvents(ymd) {
        return this._byDate.has(ymd);
    }

    // Distinct calendar colors for a day, in first-seen order (for the dots).
    colorsOn(ymd) {
        const list = this._byDate.get(ymd);
        if (!list) return [];
        const out = [];
        for (const e of list)
            if (!out.includes(e.color)) out.push(e.color);
        return out;
    }

    // Events for a day, sorted (all-day first, then by start time).
    eventsOn(ymd) {
        const list = this._byDate.get(ymd);
        if (!list) return [];
        return [...list].sort((a, b) => a.minutes - b.minutes);
    }

    // The next date strictly after `afterYmd` that has any event, or null.
    // (YYYY-MM-DD strings sort chronologically, so plain comparison works.)
    nextEventDay(afterYmd) {
        let best = null;
        for (const k of this._byDate.keys())
            if (k > afterYmd && (best === null || k < best)) best = k;
        return best;
    }

    // Create a new event and persist it as a fresh *.ics, then reindex.
    // `time` is null for an all-day event, or {startMin, endMin} (minutes from
    // midnight, floating local wall-clock) for a timed one.
    addEvent(ymd, summary, time = null) {
        this.ensureDir();
        const [y, m, d] = ymd.split('-').map(Number);

        const cal = new ICAL.Component(['vcalendar', [], []]);
        cal.updatePropertyWithValue('version', '2.0');
        cal.updatePropertyWithValue('prodid', '-//custom-calendar//gjs//EN');

        const vevent = new ICAL.Component('vevent');
        const ev = new ICAL.Event(vevent);
        const uid = GLib.uuid_string_random();
        ev.uid = uid;
        ev.summary = summary;
        this._applyWhen(ev, y, m, d, time);
        vevent.updatePropertyWithValue('dtstamp', ICAL.Time.now());

        cal.addSubcomponent(vevent);

        const path = GLib.build_filenamev([this._writeDir, `${uid}.ics`]);
        GLib.file_set_contents(path, new TextEncoder().encode(cal.toString()));

        this.load();
        return path;
    }

    // Set an event's DTSTART/DTEND for date (y,m,d), either all-day (time null)
    // or timed. Timed end defaults to start + 1h and is clamped within the day.
    _applyWhen(ev, y, m, d, time) {
        if (time && time.startMin != null) {
            let endMin = time.endMin;
            if (endMin == null || endMin <= time.startMin) endMin = time.startMin + 60;
            if (endMin > 24 * 60) endMin = 24 * 60; // don't spill past midnight
            ev.startDate = ICAL.Time.fromData({
                year: y, month: m, day: d,
                hour: Math.floor(time.startMin / 60), minute: time.startMin % 60,
                second: 0, isDate: false,
            });
            ev.endDate = ICAL.Time.fromData({
                year: y, month: m, day: d,
                hour: Math.floor(endMin / 60), minute: endMin % 60,
                second: 0, isDate: false,
            });
        } else {
            const start = ICAL.Time.fromData({ year: y, month: m, day: d, isDate: true });
            ev.startDate = start;
            const end = start.clone();
            end.adjust(1, 0, 0, 0); // DTEND is exclusive for all-day events
            ev.endDate = end;
        }
    }

    // Delete the .ics file backing an event (removes all its occurrences). The
    // next vdirsyncer run propagates the deletion to iCloud.
    deleteEvent(path) {
        try {
            Gio.File.new_for_path(path).delete(null);
        } catch (e) {
            logError(e, `EventStore: failed to delete ${path}`);
        }
        this.load();
    }

    // Rewrite an event's SUMMARY and, optionally, its time. `time` is null to
    // make it all-day, {startMin, endMin} to make it timed, or `undefined` to
    // leave the existing DTSTART/DTEND untouched (title-only edit). The date is
    // preserved from the existing DTSTART.
    updateEvent(path, newSummary, time) {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok) return;
        const comp = new ICAL.Component(ICAL.parse(new TextDecoder().decode(bytes)));
        const vevents = comp.getAllSubcomponents('vevent');
        if (vevents.length === 0) return;
        const ev = new ICAL.Event(vevents[0]);
        ev.summary = newSummary;
        if (time !== undefined && ev.startDate) {
            const s = ev.startDate;
            this._applyWhen(ev, s.year, s.month, s.day, time);
        }
        vevents[0].updatePropertyWithValue('last-modified', ICAL.Time.now());
        GLib.file_set_contents(path, new TextEncoder().encode(comp.toString()));
        this.load();
    }

    // The event backing `path`'s time as {startMin, endMin} (timed) or null
    // (all-day), so the editor can prefill it. Reads the first VEVENT.
    timeOf(path) {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok) return null;
        const comp = new ICAL.Component(ICAL.parse(new TextDecoder().decode(bytes)));
        const vevents = comp.getAllSubcomponents('vevent');
        if (vevents.length === 0) return null;
        const ev = new ICAL.Event(vevents[0]);
        if (!ev.startDate || ev.startDate.isDate) return null;
        const s = ev.startDate;
        const out = { startMin: s.hour * 60 + s.minute, endMin: null };
        if (ev.endDate && !ev.endDate.isDate &&
            ev.endDate.year === s.year && ev.endDate.month === s.month && ev.endDate.day === s.day)
            out.endMin = ev.endDate.hour * 60 + ev.endDate.minute;
        return out;
    }
}
