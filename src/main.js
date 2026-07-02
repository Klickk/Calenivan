// Calendar — GJS + GTK4 waybar dropdown popup.
// Phase 0: layer-shell popup anchored top-right under the bar, Escape to close.

import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import LayerShell from 'gi://Gtk4LayerShell?version=1.0';
import system from 'system';

import { CalendarGrid } from './CalendarGrid.js';
import { EventStore } from './EventStore.js';

const APP_ID = 'com.jimmmmothy.calendar';

// Directory this script lives in, so we can find sibling assets (ui.css).
const SCRIPT_DIR = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);

function loadStyles() {
    const cssPath = GLib.build_filenamev([SCRIPT_DIR, 'ui.css']);
    if (!GLib.file_test(cssPath, GLib.FileTest.EXISTS))
        return;
    const provider = new Gtk.CssProvider();
    provider.load_from_path(cssPath);
    Gtk.StyleContext.add_provider_for_display(
        Gdk.Display.get_default(),
        provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
    );
}

function setupLayerShell(win) {
    LayerShell.init_for_window(win);
    LayerShell.set_namespace(win, 'calendar-popup');
    LayerShell.set_layer(win, LayerShell.Layer.TOP);
    // Anchor to the top-right corner so the popup drops out of the waybar
    // clock (which lives at the right end of the bar on this ML4W setup).
    LayerShell.set_anchor(win, LayerShell.Edge.TOP, true);
    LayerShell.set_anchor(win, LayerShell.Edge.RIGHT, true);
    LayerShell.set_margin(win, LayerShell.Edge.TOP, -6);
    LayerShell.set_margin(win, LayerShell.Edge.RIGHT, 8);
    // ON_DEMAND lets the popup take keyboard focus (for Escape) without
    // stealing it globally the way EXCLUSIVE would.
    LayerShell.set_keyboard_mode(win, LayerShell.KeyboardMode.ON_DEMAND);
}

// Parse an add/edit string into { summary, time }. A leading "HH:MM" (optionally
// a range "HH:MM-HH:MM") makes it a timed event; otherwise time is null (all-day).
// The colon is required, so titles that merely start with a number stay all-day.
function parseEntry(text) {
    const m = text.match(/^(\d{1,2}):(\d{2})(?:\s*-\s*(\d{1,2}):(\d{2}))?\s+(.+)$/);
    if (!m) return { summary: text.trim(), time: null };
    const sh = +m[1], sm = +m[2];
    if (sh > 23 || sm > 59) return { summary: text.trim(), time: null };
    let endMin = null;
    if (m[3] != null) {
        const eh = +m[3], em = +m[4];
        if (eh <= 23 && em <= 59) endMin = eh * 60 + em;
    }
    return { summary: m[5].trim(), time: { startMin: sh * 60 + sm, endMin } };
}

// Inverse of parseEntry's time part: an editor prefix like "14:00 " or
// "14:00-15:30 " so editing an existing timed event round-trips its time.
function formatTimePrefix(time) {
    if (!time) return '';
    const f = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    return time.endMin != null ? `${f(time.startMin)}-${f(time.endMin)} ` : `${f(time.startMin)} `;
}

// Pretty-print a YYYY-MM-DD key as e.g. "Thursday, 2 July 2026".
function prettyDate(key) {
    const [y, m, d] = key.split('-').map(Number);
    const dt = GLib.DateTime.new_local(y, m, d, 0, 0, 0);
    return dt.format('%A, %e %B %Y').replace('  ', ' ');
}

function buildContent(win) {
    const content = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 10,
    });
    content.add_css_class('calendar-root');

    // New events are written into the primary Google calendar collection
    // (vdirsyncer syncs this subdir up to Google). Reads still cover the whole tree.
    const HOME_COLLECTION = 'ivanbakalov15@gmail.com';
    const store = new EventStore({
        writeDir: GLib.build_filenamev([GLib.get_user_data_dir(), 'calendar', HOME_COLLECTION]),
    });
    store.load();

    const grid = new CalendarGrid();
    grid.setDayColors((ymd) => store.colorsOn(ymd));

    // --- View toggle (Month / Week), right-aligned above the grid ---
    const weekToggle = new Gtk.ToggleButton({ label: 'Week' });
    weekToggle.add_css_class('flat');
    weekToggle.connect('toggled', () => grid.setMode(weekToggle.active ? 'week' : 'month'));
    const toolbar = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    toolbar.append(new Gtk.Box({ hexpand: true })); // spacer pushes the toggle right
    toolbar.append(weekToggle);

    // --- Legend: each calendar's name in its color ---
    const legend = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
        halign: Gtk.Align.CENTER,
    });
    legend.add_css_class('legend');
    for (const cal of store.calendars()) {
        const item = new Gtk.Label();
        item.add_css_class('legend-item');
        // Guard against pathological names (e.g. a Google "@virtual" calendar
        // with no displayname) stretching the whole popup wide.
        item.set_ellipsize(Pango.EllipsizeMode.END);
        item.set_max_width_chars(24);
        item.set_markup(`<span foreground="${cal.color}">●</span> ${GLib.markup_escape_text(cal.name, -1)}`);
        legend.append(item);
    }

    // --- Selected-day header + event list ---
    const dateLabel = new Gtk.Label({ halign: Gtk.Align.START });
    dateLabel.add_css_class('title-5');

    const list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });

    // --- Add / edit row (the entry doubles as an inline editor) ---
    const entry = new Gtk.Entry({ hexpand: true, placeholder_text: 'Add event…  (e.g. 14:00 Lunch)' });
    const cancelBtn = new Gtk.Button({ icon_name: 'window-close-symbolic', visible: false });
    cancelBtn.add_css_class('flat');
    const addBtn = new Gtk.Button({ icon_name: 'list-add-symbolic' });
    addBtn.add_css_class('flat');
    const addRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    addRow.append(entry);
    addRow.append(cancelBtn);
    addRow.append(addBtn);

    let editingPath = null;
    const endEdit = () => {
        editingPath = null;
        entry.set_text('');
        entry.set_placeholder_text('Add event…  (e.g. 14:00 Lunch)');
        addBtn.set_icon_name('list-add-symbolic');
        cancelBtn.set_visible(false);
    };
    const startEdit = (ev) => {
        editingPath = ev.path;
        // Prefill the time (if any) so the whole "14:00 Title" round-trips.
        entry.set_text(formatTimePrefix(store.timeOf(ev.path)) + ev.summary);
        entry.set_placeholder_text('Edit…  (e.g. 14:00 Lunch)');
        addBtn.set_icon_name('object-select-symbolic');
        cancelBtn.set_visible(true);
        entry.grab_focus();
        entry.set_position(-1); // cursor at end
    };

    // Replace a row's contents with an inline "Delete “…”? [Delete] [Cancel]".
    const confirmDelete = (row, ev) => {
        let c = row.get_first_child();
        while (c) { const n = c.get_next_sibling(); row.remove(c); c = n; }
        const q = new Gtk.Label({ label: `Delete “${ev.summary}”?`, halign: Gtk.Align.START, hexpand: true, xalign: 0, wrap: true });
        q.add_css_class('dim-label');
        const yes = new Gtk.Button({ label: 'Delete' });
        yes.add_css_class('destructive-action');
        yes.add_css_class('row-btn');
        const no = new Gtk.Button({ label: 'Cancel' });
        no.add_css_class('flat');
        no.add_css_class('row-btn');
        yes.connect('clicked', () => {
            store.deleteEvent(ev.path);
            if (editingPath === ev.path) endEdit();
            grid.refresh();
            refresh(grid.selected);
        });
        no.connect('clicked', () => refresh(grid.selected));
        row.append(q);
        row.append(yes);
        row.append(no);
    };

    const buildEventRow = (ev) => {
        const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 4 });
        row.add_css_class('event-row');
        const lbl = new Gtk.Label({ halign: Gtk.Align.START, hexpand: true, xalign: 0, wrap: true });
        const time = ev.allDay
            ? (ev.continuation ? '…  ' : '')
            : (ev.endLabel ? `${ev.timeLabel}–${ev.endLabel}  ` : `${ev.timeLabel}  `);
        lbl.set_markup(`<span foreground="${ev.color}">●</span>  ${GLib.markup_escape_text(time + ev.summary, -1)}`);
        const editB = new Gtk.Button({ icon_name: 'document-edit-symbolic' });
        editB.add_css_class('flat');
        editB.add_css_class('row-btn');
        editB.connect('clicked', () => startEdit(ev));
        const delB = new Gtk.Button({ icon_name: 'user-trash-symbolic' });
        delB.add_css_class('flat');
        delB.add_css_class('row-btn');
        delB.connect('clicked', () => confirmDelete(row, ev));
        row.append(lbl);
        row.append(editB);
        row.append(delB);
        return row;
    };

    const refresh = (key) => {
        dateLabel.set_label(prettyDate(key));
        let child = list.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            list.remove(child);
            child = next;
        }
        const events = store.eventsOn(key);
        if (events.length === 0) {
            const empty = new Gtk.Label({ label: 'No events', halign: Gtk.Align.START });
            empty.add_css_class('dim-label');
            list.append(empty);
            return;
        }
        for (const ev of events) list.append(buildEventRow(ev));
    };

    const commit = () => {
        const text = entry.get_text().trim();
        if (!text) return;
        const { summary, time } = parseEntry(text);
        if (!summary) return;
        if (editingPath) store.updateEvent(editingPath, summary, time);
        else store.addEvent(grid.selected, summary, time);
        endEdit();
        grid.refresh();
        refresh(grid.selected);
    };
    entry.connect('activate', commit);
    addBtn.connect('clicked', commit);
    cancelBtn.connect('clicked', endEdit);

    // --- Keyboard shortcuts ---
    // Capture phase so shortcuts work whichever widget has focus, but we bow
    // out (return false) while the text entry is focused so typing works.
    const focusInEntry = () => {
        let f = win.get_focus();
        while (f) {
            if (f === entry) return true;
            f = f.get_parent();
        }
        return false;
    };
    const keyCtl = new Gtk.EventControllerKey();
    keyCtl.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    keyCtl.connect('key-pressed', (_c, keyval, _kc, state) => {
        const typing = focusInEntry();
        const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;

        // Tab toggles week view (button stays in sync via its 'toggled' signal).
        if (keyval === Gdk.KEY_Tab && !typing) {
            weekToggle.set_active(!weekToggle.active);
            return true;
        }
        // Enter focuses the add-event box when you're not already in it.
        if ((keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) && !typing) {
            entry.grab_focus();
            return true;
        }
        if (typing) return false; // let the entry keep every other key

        const ch = String.fromCharCode(Gdk.keyval_to_unicode(keyval)).toLowerCase();
        switch (ch) {
            case 'a': // left: day / month (Shift) / year (Ctrl)
                if (ctrl) grid.moveYears(-1);
                else if (shift) grid.moveMonths(-1);
                else grid.moveDays(-1);
                return true;
            case 'd': // right
                if (ctrl) grid.moveYears(1);
                else if (shift) grid.moveMonths(1);
                else grid.moveDays(1);
                return true;
            case 'w': // up a week
                grid.moveDays(-7);
                return true;
            case 's': // down a week
                grid.moveDays(7);
                return true;
            case 't':
                grid.goToday();
                return true;
            case 'n': { // jump to next day with an event
                const next = store.nextEventDay(grid.selected);
                if (next) grid.selectDate(next);
                return true;
            }
        }
        return false;
    });
    win.add_controller(keyCtl);

    grid.connect('day-selected', (_g, key) => refresh(key));
    refresh(grid.selected);

    content.append(toolbar);
    content.append(grid);
    if (store.calendars().length > 0)
        content.append(legend);
    content.append(new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL }));
    content.append(dateLabel);
    content.append(list);
    content.append(addRow);

    // Outer box paints the "liquid glass" gradient rim; the inner content box
    // (solid fill, slightly smaller radius) sits on top, so the gradient shows
    // only as a thin border — brightest at the top-left and bottom-right corners.
    const border = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    border.add_css_class('glass-border');
    border.append(content);
    return border;
}

function buildWindow(app) {
    const win = new Gtk.ApplicationWindow({ application: app });
    win.set_title('Calendar');
    win.set_default_size(200, 200);
    win.add_css_class('calendar-window');

    setupLayerShell(win);
    win.set_child(buildContent(win));

    // Escape closes the popup.
    const keys = new Gtk.EventControllerKey();
    keys.connect('key-pressed', (_controller, keyval) => {
        if (keyval === Gdk.KEY_Escape) {
            win.close();
            return true;
        }
        return false;
    });
    win.add_controller(keys);

    return win;
}

const app = new Adw.Application({ application_id: APP_ID, flags: 0 });
app.connect('startup', () => loadStyles());
app.connect('activate', () => buildWindow(app).present());
app.run([system.programInvocationName, ...ARGV]);
