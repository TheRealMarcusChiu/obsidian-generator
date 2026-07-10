// Runs the ZIM → Obsidian conversion off the main thread, so it continues at
// full speed even when the tab is hidden or the OS throttles the page.
// Loaded as a module worker by index.html; falls back to in-page conversion if
// this worker can't start.

const booted = (async () => {
  // linkedom provides a DOMParser that works inside a worker
  const dom = await import('https://cdn.jsdelivr.net/npm/linkedom@0.18.5/worker/+esm');
  globalThis.window = globalThis;
  globalThis.DOMParser = dom.DOMParser;
  const td = await import('https://cdn.jsdelivr.net/npm/turndown@7.2.0/+esm');
  globalThis.TurndownService = td.default || td.TurndownService;
  try {
    const gfm = await import('https://cdn.jsdelivr.net/npm/turndown-plugin-gfm@1.0.2/+esm');
    globalThis.turndownPluginGfm = { gfm: gfm.gfm || (gfm.default && gfm.default.gfm) };
  } catch (e) { /* tables degrade gracefully without gfm */ }
  const fz = await import('https://cdn.jsdelivr.net/npm/fzstd@0.1.1/+esm');
  globalThis.fzstd = fz;
  await import('./zim.js');
})();

let reader = null;
let cancelled = false;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'cancel') { cancelled = true; return; }
  try {
    await booted;
  } catch (err) {
    self.postMessage({ type: 'boot-failed', message: err.message });
    return;
  }
  if (m.type === 'open') {
    try {
      reader = new globalThis.ZimVault.ZimReader(m.file);
      await reader.open();
      const meta = await reader.getMetadata();
      self.postMessage({ type: 'opened', meta, counts: reader.counts });
    } catch (err) {
      self.postMessage({ type: 'error', archive: true, message: err.message });
    }
  } else if (m.type === 'convert') {
    cancelled = false;
    try {
      if (!reader) throw new Error('no archive open in worker');
      const vault = await globalThis.ZimVault.convert(
        reader,
        Object.assign({}, m.opts, { isCancelled: () => cancelled }),
        (p) => self.postMessage({ type: 'progress', p })
      );
      if (!vault) { self.postMessage({ type: 'cancelled' }); return; }
      const notes = {};
      for (const [k, v] of vault.notes) notes[k] = v;
      const attachments = [];
      const transfers = [];
      for (const [k, v] of vault.attachments) {
        attachments.push([k, v.mime, v.data.buffer]);
        transfers.push(v.data.buffer);
      }
      self.postMessage({ type: 'done', notes, attachments, order: vault.order, mainNote: vault.mainNote }, transfers);
    } catch (err) {
      self.postMessage({ type: 'error', archive: true, message: err.message });
    }
  }
};
