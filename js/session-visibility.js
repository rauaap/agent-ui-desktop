const DAY = 86_400_000;
const KEY = 'agent-ui.session-visibility';

export function oldestSessionDays(sessions, now = Date.now()) {
  let maximum = 1;
  for (const session of sessions) {
    const timestamp = Date.parse(session.last_active_at);
    if (!Number.isFinite(timestamp)) throw new Error('Invalid session last_active_at');
    maximum = Math.max(maximum, Math.ceil((now - timestamp) / DAY));
  }
  return maximum;
}

export function sessionVisible(session, days, query, now = Date.now()) {
  if (query && (session.name || '').toLowerCase().includes(query)) return true;
  return days == null || Date.parse(session.last_active_at) >= now - days * DAY;
}

/** One shared state for the sidebar controls, persistence, and filtering. */
export class SessionVisibility {
  constructor(toggle, slider, number, onChange, storage = localStorage) {
    this.toggle = toggle;
    this.slider = slider;
    this.number = number;
    this.onChange = onChange;
    this.storage = storage;
    const raw = storage.getItem(KEY);
    this.state = raw === null ? null : JSON.parse(raw);
    if (this.state !== null && (typeof this.state.enabled !== 'boolean'
      || !Number.isInteger(this.state.days) || this.state.days < 1)) {
      throw new Error('Invalid session visibility preference');
    }
    this.maximum = 1;
    this.ready = false;
    this.paint();
    toggle.addEventListener('change', () => {
      this.state.enabled = toggle.checked;
      this.commit();
    });
    slider.addEventListener('input', () => this.setDays(Number(slider.value)));
    number.addEventListener('input', () => {
      if (number.value !== '' && number.validity.valid) this.setDays(Number(number.value));
    });
    number.addEventListener('blur', () => this.paint());
    number.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (number.value !== '' && number.validity.valid) this.setDays(Number(number.value));
        this.paint();
      }
    });
  }

  get cutoff() { return this.state?.enabled ? this.state.days : null; }

  updateCatalog(sessions) {
    this.maximum = oldestSessionDays(sessions);
    this.ready = true;
    if (this.state === null) {
      this.state = { enabled: false, days: this.maximum };
    } else if (this.state.days > this.maximum) {
      this.state.days = this.maximum;
      this.storage.setItem(KEY, JSON.stringify(this.state));
    }
    this.paint(true);
    return this.cutoff;
  }

  setDays(days) {
    if (!Number.isInteger(days) || days < 1 || days > this.maximum) return;
    this.state.days = days;
    this.commit();
  }

  commit() {
    this.storage.setItem(KEY, JSON.stringify(this.state));
    this.paint();
    this.onChange(this.cutoff);
  }

  paint(preserveEdit = false) {
    const days = this.state?.days ?? 1;
    this.toggle.checked = this.state?.enabled ?? false;
    this.toggle.disabled = !this.ready;
    this.slider.disabled = this.number.disabled = !this.ready || !this.toggle.checked;
    this.slider.max = this.number.max = String(this.maximum);
    this.slider.value = String(days);
    this.slider.style.setProperty('--age-progress', `${this.maximum === 1 ? 100 : (days - 1) / (this.maximum - 1) * 100}%`);
    if (!preserveEdit || document.activeElement !== this.number) this.number.value = String(days);
  }
}
