// Month/week calendar grid: weekday header + 6 week rows of 7 day cells, with
// an ISO week number down the left of each row and a separating line above it.
// Month navigation, today/selected highlighting. Pure JS Date math (Monday-first).
// Emits `day-selected` (YYYY-MM-DD string) when a day is selected.

import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']; // Monday-first
const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEK_COL = 26; // width of the left-hand week-number column (px)

// Local YYYY-MM-DD key (avoids UTC drift from Date.toISOString()).
function ymd(d) {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
}

// ISO 8601 week number (weeks start Monday; week 1 holds the year's first
// Thursday). Computed in UTC to avoid DST edge cases.
function isoWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = (d.getUTCDay() + 6) % 7;      // Mon=0..Sun=6
    d.setUTCDate(d.getUTCDate() - dayNum + 3);   // the Thursday of this week
    const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const jan4Day = (jan4.getUTCDay() + 6) % 7;
    jan4.setUTCDate(jan4.getUTCDate() - jan4Day + 3); // Thursday of week 1
    return 1 + Math.round((d.getTime() - jan4.getTime()) / 604800000);
}

export const CalendarGrid = GObject.registerClass({
    GTypeName: 'CalendarGrid',
    Signals: { 'day-selected': { param_types: [GObject.TYPE_STRING] } },
}, class CalendarGrid extends Gtk.Box {
    _init(params = {}) {
        super._init({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, ...params });

        const today = new Date();
        this._view = new Date(today.getFullYear(), today.getMonth(), 1); // first of shown month
        this._selected = ymd(today);
        this._dayColors = () => []; // overridden via setDayColors()
        this._mode = 'month';       // 'month' | 'week'

        this._buildHeader();
        this._buildBody();

        this._render();
    }

    get selected() {
        return this._selected;
    }

    // fn(ymd) -> array of '#RRGGBB'; controls the per-day event dots.
    setDayColors(fn) {
        this._dayColors = fn;
        this._render();
    }

    // Repaint cells (e.g. after events change on disk).
    refresh() {
        this._render();
    }

    _buildHeader() {
        const header = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 4 });

        const prevMonth = new Gtk.Button({ icon_name: 'go-previous-symbolic' });
        prevMonth.add_css_class('flat');
        prevMonth.connect('clicked', () => this._navPrimary(-1));

        this._title = new Gtk.Label({ hexpand: true });
        this._title.add_css_class('title-4');

        const nextMonth = new Gtk.Button({ icon_name: 'go-next-symbolic' });
        nextMonth.add_css_class('flat');
        nextMonth.connect('clicked', () => this._navPrimary(1));

        const prevYear = new Gtk.Button({ icon_name: 'go-previous-symbolic' });
        prevYear.add_css_class('flat');
        prevYear.connect('clicked', () => this._navYear(-1));

        this._selectedYear = new Gtk.Label({ label: String(this._view.getFullYear()) });
        // this._selectedYear.add_css_class('dim-label');
        this._selectedYear.add_css_class('title-5');

        const nextYear = new Gtk.Button({ icon_name: 'go-next-symbolic' });
        nextYear.add_css_class('flat');
        nextYear.connect('clicked', () => this._navYear(1));

        const todayBtn = new Gtk.Button({ label: 'Today' });
        todayBtn.add_css_class('flat');
        todayBtn.connect('clicked', () => this.goToday());

        header.append(prevMonth);
        header.append(this._title);
        header.append(nextMonth);
        header.append(prevYear);
        header.append(this._selectedYear);
        header.append(nextYear);
        header.append(todayBtn);
        this.append(header);
    }

    // Weekday header + 6 week rows. Each row is [week number | 7 day cells],
    // with a separating line above it (via the .week-row border in ui.css).
    _buildBody() {
        const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });

        // Weekday labels, with an empty spacer over the week-number column.
        const head = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 2 });
        const corner = new Gtk.Box();
        corner.set_size_request(WEEK_COL, -1);
        head.append(corner);
        WEEKDAYS.forEach((label) => {
            const l = new Gtk.Label({ label, hexpand: true });
            l.add_css_class('dim-label');
            l.add_css_class('caption');
            head.append(l);
        });
        body.append(head);

        this._cells = [];
        this._weekLabels = [];
        this._weekRows = [];
        for (let r = 0; r < 6; r++) {
            const rowBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 2 });
            rowBox.add_css_class('week-row');

            const wk = new Gtk.Label({ valign: Gtk.Align.CENTER });
            wk.set_size_request(WEEK_COL, -1);
            wk.add_css_class('week-number');
            rowBox.append(wk);
            this._weekLabels.push(wk);

            for (let c = 0; c < 7; c++) {
                const cell = this._makeDayCell();
                rowBox.append(cell);
                this._cells.push(cell);
            }
            body.append(rowBox);
            this._weekRows.push(rowBox);
        }
        this.append(body);
    }

    // One day cell: the number stacked over a fixed-height row of colored event
    // dots (kept fixed so the number doesn't shift when dots appear/disappear).
    _makeDayCell() {
        const btn = new Gtk.Button({ hexpand: true });
        btn.add_css_class('flat');
        btn.add_css_class('day');

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
        });
        const num = new Gtk.Label();
        const dots = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 2,
            halign: Gtk.Align.CENTER,
        });
        dots.set_size_request(-1, 8);
        box.append(num);
        box.append(dots);
        btn.set_child(box);
        btn._num = num;
        btn._dots = dots;

        btn.connect('clicked', () => this.selectDate(btn._ymd));
        return btn;
    }

    // 'month' | 'week'
    setMode(mode) {
        if (mode !== 'week' && mode !== 'month') return;
        this._mode = mode;
        this._render();
    }

    // The ‹ › next to the month name: month mode steps a month, week mode a week.
    _navPrimary(dir) {
        if (this._mode === 'week') this.moveDays(dir * 7);
        else this._shiftMonth(dir);
    }

    // The ‹ › next to the year: month mode steps a year (12 months), week mode a year.
    _navYear(dir) {
        if (this._mode === 'week') this.moveYears(dir);
        else this._shiftMonth(dir * 12);
    }

    // View-only month step (header arrows in month mode); selection unchanged.
    _shiftMonth(delta) {
        this._view = new Date(this._view.getFullYear(), this._view.getMonth() + delta, 1);
        this._render();
    }

    // --- Selection-driven navigation (clicks + keybindings). The shown month
    // always follows the selected day, so selecting a day in an adjacent month
    // flips the view to that month. ---

    selectDate(key) {
        this._selected = key;
        const [y, m] = key.split('-').map(Number);
        this._view = new Date(y, m - 1, 1);
        this._render();
        this.emit('day-selected', key);
    }

    moveDays(n) {
        const [y, m, d] = this._selected.split('-').map(Number);
        this.selectDate(ymd(new Date(y, m - 1, d + n)));
    }

    moveMonths(n) {
        const [y, m, d] = this._selected.split('-').map(Number);
        const target = new Date(y, m - 1 + n, 1);
        const dim = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
        this.selectDate(ymd(new Date(target.getFullYear(), target.getMonth(), Math.min(d, dim))));
    }

    moveYears(n) {
        const [y, m, d] = this._selected.split('-').map(Number);
        const dim = new Date(y + n, m, 0).getDate(); // last day of month m (1-based) in year y+n
        this.selectDate(ymd(new Date(y + n, m - 1, Math.min(d, dim))));
    }

    goToday() {
        this.selectDate(ymd(new Date()));
    }

    get mode() {
        return this._mode;
    }

    toggleMode() {
        this.setMode(this._mode === 'week' ? 'month' : 'week');
    }

    _render() {
        if (this._mode === 'week') this._renderWeek();
        else this._renderMonth();
    }

    _renderMonth() {
        const year = this._view.getFullYear();
        const month = this._view.getMonth();
        this._title.set_label(MONTHS[month]);
        this._selectedYear.set_label(String(year));

        // Monday-first offset of the 1st, then walk back to the grid's first cell.
        const offset = (new Date(year, month, 1).getDay() + 6) % 7;
        const start = new Date(year, month, 1 - offset);

        for (let i = 0; i < 42; i++) {
            const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
            this._paintCell(this._cells[i], d, month);
            if (i % 7 === 0)
                this._weekLabels[i / 7].set_label(String(isoWeek(d)));
        }
        for (let r = 0; r < 6; r++) this._weekRows[r].set_visible(true);
    }

    _renderWeek() {
        // The week (Mon–Sun) containing the selected day.
        const [sy, sm, sd] = this._selected.split('-').map(Number);
        const sel = new Date(sy, sm - 1, sd);
        const offset = (sel.getDay() + 6) % 7;
        const monday = new Date(sel.getFullYear(), sel.getMonth(), sel.getDate() - offset);

        this._title.set_label(MONTHS[sel.getMonth()]);
        this._selectedYear.set_label(String(sel.getFullYear()));

        for (let i = 0; i < 7; i++) {
            const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
            this._paintCell(this._cells[i], d, sel.getMonth());
        }
        this._weekLabels[0].set_label(String(isoWeek(monday)));
        this._weekRows[0].set_visible(true);
        for (let r = 1; r < 6; r++) this._weekRows[r].set_visible(false);
    }

    _paintCell(cell, d, currentMonth) {
        const todayStr = ymd(new Date());
        cell._ymd = ymd(d);
        cell._num.set_label(String(d.getDate()));

        // Repaint colored event dots (up to 3, one per calendar).
        let dc = cell._dots.get_first_child();
        while (dc) {
            const nx = dc.get_next_sibling();
            cell._dots.remove(dc);
            dc = nx;
        }
        for (const color of this._dayColors(cell._ymd).slice(0, 3)) {
            const dot = new Gtk.Label();
            dot.add_css_class('event-dot');
            dot.set_markup(`<span foreground="${color}">●</span>`);
            cell._dots.append(dot);
        }

        cell.remove_css_class('other-month');
        cell.remove_css_class('today');
        cell.remove_css_class('selected');
        if (d.getMonth() !== currentMonth) cell.add_css_class('other-month');
        if (cell._ymd === todayStr) cell.add_css_class('today');
        if (cell._ymd === this._selected) cell.add_css_class('selected');
    }
});
