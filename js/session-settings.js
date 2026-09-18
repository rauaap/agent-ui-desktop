/** Session settings shared by REST, live frames, and the sandbox control. */
export function settingsMeta(row) {
  return {
    sandbox: typeof row.sandbox === 'boolean' ? row.sandbox : null,
    autoApproveWrite: !!row.auto_approve_write,
    autoApproveCommand: !!row.auto_approve_command,
  };
}

export function supportsSandbox(agent) {
  return agent === 'pi' || agent === 'claude-code';
}

export function canChangeSandbox(state) {
  return supportsSandbox(state.agent) && typeof state.sandbox === 'boolean'
    && state.connected && state.settingsLoaded && state.sessionReady
    && !state.sandboxSaving
    && state.status !== 'running' && state.status !== 'awaiting_approval';
}

/**
 * A request captures a revision before starting. Settings received after that
 * point win over its snapshot, including PATCH responses overtaken by a frame.
 * Revisions are per field so partial frames cannot erase other settings.
 */
export class SettingsSync {
  constructor() {
    this.revision = 0;
    this.latest = new Map();
    this.pending = new Set();
  }

  checkpoint() { return this.revision; }

  record(id, row) {
    id = String(id);
    const fields = this.latest.get(id) || {};
    for (const key of ['sandbox', 'auto_approve_write', 'auto_approve_command']) {
      if (typeof row[key] === 'boolean') {
        fields[key] = { value: row[key], revision: ++this.revision };
      }
    }
    this.latest.set(id, fields);
  }

  reconcile(row, since) {
    const result = { ...row };
    for (const [key, field] of Object.entries(this.latest.get(String(row.id)) || {})) {
      if (field.revision > since) result[key] = field.value;
    }
    return result;
  }

  /** No queuing/retrying: retain the confirmed value until the PATCH succeeds. */
  async saveSandbox(id, value, { getState, setPending, patch, accept }) {
    id = String(id);
    if (this.pending.has(id) || !canChangeSandbox(getState())) {
      throw new Error('Sandbox can only be changed between turns while connected.');
    }
    this.pending.add(id);
    setPending(true);
    const since = this.checkpoint();
    try {
      const row = this.reconcile(await patch(id, value), since);
      accept(row);
    } finally {
      this.pending.delete(id);
      setPending(false);
    }
  }
}
