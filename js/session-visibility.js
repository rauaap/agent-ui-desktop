const DAY = 86_400_000;
const KEY = 'agent-ui.session-visibility';

export function sessionAgeStops() {
  return [1, 2, 3, 4, 5, 6, 7, 14, 30, 60, 90, null];
}

export function sessionVisible(session, days, query, now = Date.now()) {
  if (query && (session.name || '').toLowerCase().includes(query)) return true;
  return days == null || Date.parse(session.last_active_at) >= now - days * DAY;
}

/** One shared state for the sidebar controls, persistence, and filtering. */
export class SessionVisibility {
  constructor(slider, number, onChange, storage = localStorage) {
    this.slider = slider;
    this.number = number;
    this.onChange = onChange;
    this.storage = storage;
    const raw = storage.getItem(KEY);
    this.state = raw === null ? { enabled: false, days: 30 } : JSON.parse(raw);
    if (this.state === null || typeof this.state.enabled !== 'boolean'
      || !Number.isSafeInteger(this.state.days) || this.state.days < 1) {
      throw new Error('Invalid session visibility preference');
    }
    const selectStep = () => this.setDays(sessionAgeStops()[Number(slider.value)]);
    slider.addEventListener('input', selectStep);
    // A click on the current tick need not emit input/change. It still selects
    // that preset, replacing an exact typed value (including 100 → infinity).
    slider.addEventListener('click', selectStep);
    slider.addEventListener('keyup', (event) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
        selectStep();
      }
    });
    number.addEventListener('input', () => {
      if (/^\d+$/.test(number.value)) this.setDays(Number(number.value), true);
    });
    number.addEventListener('focus', () => {
      if (this.cutoff === null) number.value = '';
    });
    number.addEventListener('blur', () => this.paint());
    number.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (/^\d+$/.test(number.value)) this.setDays(Number(number.value));
        this.paint();
      }
    });
    this.paint();
  }

  get cutoff() { return this.state.enabled ? this.state.days : null; }

  setDays(days, preserveEdit = false) {
    if (days !== null && (!Number.isSafeInteger(days) || days < 1)) return;
    const changed = this.cutoff !== days;
    this.state.enabled = days !== null;
    if (days !== null) this.state.days = days;
    if (changed) this.storage.setItem(KEY, JSON.stringify(this.state));
    this.paint(preserveEdit);
    if (changed) this.onChange(this.cutoff);
  }

  paint(preserveEdit = false) {
    const days = this.cutoff;
    const stops = sessionAgeStops();
    const index = stops.findIndex((stop) => stop === null || (days !== null && stop >= days));
    const label = days === null ? 'All sessions' : `${days} days`;
    const preset = stops[index] === null ? 'all sessions' : `${stops[index]} days`;
    this.slider.max = String(stops.length - 1);
    this.slider.value = String(index);
    this.slider.setAttribute('aria-valuetext', `${label}; slider preset ${preset}`);
    this.slider.style.setProperty('--age-progress', `${index / (stops.length - 1) * 100}%`);
    if (!preserveEdit || document.activeElement !== this.number) this.number.value = days === null ? '∞' : String(days);
  }
}
