/* ZimVault — parse .zim archives and convert them to an Obsidian vault, fully in-browser.
   Exposes window.ZimVault = { ZimReader, convert }.
   Depends on: fzstd (zstd clusters), xzwasm or xz-decompress (xz clusters), TurndownService (+gfm). */
(function () {
  'use strict';
  const td8 = new TextDecoder('utf-8');

  function decodeSafe(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

  function sanitizeName(s) {
    s = (s || '')
      .replace(/[\u0000-\u001f]/g, ' ')
      .replace(/[\/\\:*?"<>|#^\[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+|\.+$/g, '');
    if (s.length > 120) s = s.slice(0, 120).trim();
    return s || 'Untitled';
  }

  const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/x-icon': '.ico', 'image/avif': '.avif' };
  function extFromMime(m) { return EXT[(m || '').split(';')[0].trim()] || ''; }

  // ---------- xz decompression (UMD global or dynamic-import fallback) ----------
  let xzMod = null;
  async function getXz() {
    if (window.xzwasm && window.xzwasm.XzReadableStream) return window.xzwasm;
    if (!xzMod) {
      xzMod = import('https://cdn.jsdelivr.net/npm/xz-decompress@0.2.1/+esm')
        .then((m) => (m && m.XzReadableStream) ? m : (m && m.default && m.default.XzReadableStream) ? m.default : null)
        .catch(() => null);
    }
    return await xzMod;
  }
  async function xzDecompress(u8) {
    const mod = await getXz();
    if (!mod || !mod.XzReadableStream) throw new Error('XZ decompressor could not be loaded');
    const src = new Response(u8).body;
    const out = await new Response(new mod.XzReadableStream(src)).arrayBuffer();
    return new Uint8Array(out);
  }

  // ---------- ZIM reader ----------
  class ZimReader {
    constructor(file) {
      this.file = file;
      this._clusters = new Map(); // LRU cluster cache
    }

    async slice(pos, len) {
      const end = Math.min(this.file.size, pos + len);
      return new Uint8Array(await this.file.slice(pos, end).arrayBuffer());
    }

    async open() {
      if (this.file.size < 80) throw new Error('file is too small to be a ZIM archive');
      const hb = await this.slice(0, 80);
      const h = new DataView(hb.buffer, hb.byteOffset, hb.byteLength);
      if (h.getUint32(0, true) !== 72173914) throw new Error('not a ZIM archive (bad magic number)');
      this.major = h.getUint16(4, true);
      this.entryCount = h.getUint32(24, true);
      this.clusterCount = h.getUint32(28, true);
      this.urlPtrPos = Number(h.getBigUint64(32, true));
      this.titlePtrPos = Number(h.getBigUint64(40, true));
      this.clusterPtrPos = Number(h.getBigUint64(48, true));
      this.mimeListPos = Number(h.getBigUint64(56, true));
      this.mainPage = h.getUint32(64, true);
      this.checksumPos = Number(h.getBigUint64(72, true));
      if (!this.entryCount) throw new Error('archive contains no entries');

      // MIME list: null-terminated strings, terminated by an empty string
      const ml = await this.slice(this.mimeListPos, 65536);
      this.mimes = [];
      let p = 0;
      while (p < ml.length) {
        let q = p;
        while (q < ml.length && ml[q] !== 0) q++;
        if (q === p) break;
        this.mimes.push(td8.decode(ml.subarray(p, q)));
        p = q + 1;
      }

      // URL pointer list
      const pu = await this.slice(this.urlPtrPos, 8 * this.entryCount);
      const pdv = new DataView(pu.buffer, pu.byteOffset, pu.byteLength);
      const ptrs = new Array(this.entryCount);
      let minP = Infinity, maxP = 0;
      for (let i = 0; i < this.entryCount; i++) {
        const v = Number(pdv.getBigUint64(i * 8, true));
        ptrs[i] = v;
        if (v < minP) minP = v;
        if (v > maxP) maxP = v;
      }

      // Cluster pointer list
      const pc = await this.slice(this.clusterPtrPos, 8 * this.clusterCount);
      const cdv = new DataView(pc.buffer, pc.byteOffset, pc.byteLength);
      this.clusterPtrs = new Array(this.clusterCount);
      for (let i = 0; i < this.clusterCount; i++) this.clusterPtrs[i] = Number(cdv.getBigUint64(i * 8, true));

      // Directory entries — read the whole dirent span in one pass
      const spanEnd = Math.min(this.file.size, maxP + 65536);
      const span = spanEnd - minP;
      if (span > 900 * 1024 * 1024) throw new Error('archive directory is too large for in-browser parsing (' + Math.round(span / 1048576) + ' MB)');
      const buf = await this.slice(minP, span);
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

      const entries = new Array(this.entryCount);
      const byPath = new Map();
      let nArticles = 0, nMedia = 0, nRedirects = 0;
      for (let i = 0; i < this.entryCount; i++) {
        const o = ptrs[i] - minP;
        const mimeIdx = dv.getUint16(o, true);
        const ns = String.fromCharCode(buf[o + 3]);
        const e = { i, ns, mime: null, redirect: -1, cluster: -1, blob: -1, url: '', title: '', skip: false };
        let s;
        if (mimeIdx === 0xffff) { e.redirect = dv.getUint32(o + 8, true); s = o + 12; nRedirects++; }
        else if (mimeIdx === 0xfffe || mimeIdx === 0xfffd) { e.skip = true; entries[i] = e; continue; }
        else { e.mime = this.mimes[mimeIdx] || 'application/octet-stream'; e.cluster = dv.getUint32(o + 8, true); e.blob = dv.getUint32(o + 12, true); s = o + 16; }
        let q = s;
        while (q < buf.length && buf[q] !== 0) q++;
        e.url = td8.decode(buf.subarray(s, q));
        s = q + 1; q = s;
        while (q < buf.length && buf[q] !== 0) q++;
        e.title = q > s ? td8.decode(buf.subarray(s, q)) : '';
        entries[i] = e;
        const key = ns + '/' + e.url;
        if (!byPath.has(key)) byPath.set(key, i);
        const dec = ns + '/' + decodeSafe(e.url);
        if (dec !== key && !byPath.has(dec)) byPath.set(dec, i);
        if (e.mime) {
          if (e.mime.indexOf('text/html') === 0 && (ns === 'A' || ns === 'C')) nArticles++;
          else if (/^(image|video|audio)\//.test(e.mime)) nMedia++;
        }
      }
      this.entries = entries;
      this.byPath = byPath;
      this.counts = { articles: nArticles, media: nMedia, redirects: nRedirects, entries: this.entryCount, size: this.file.size };
      return this;
    }

    resolve(i) {
      let e = this.entries[i], hops = 0;
      while (e && e.redirect >= 0 && hops++ < 12) e = this.entries[e.redirect];
      return e;
    }

    async getCluster(idx) {
      if (this._clusters.has(idx)) {
        const c = this._clusters.get(idx);
        this._clusters.delete(idx); this._clusters.set(idx, c); // refresh LRU
        return c;
      }
      const start = this.clusterPtrs[idx];
      const end = idx + 1 < this.clusterCount ? this.clusterPtrs[idx + 1] : this.checksumPos;
      const raw = await this.slice(start, end - start);
      const info = raw[0];
      const comp = info & 0x0f;
      const extended = !!(info & 0x10);
      let data = raw.subarray(1);
      if (comp === 4) data = await xzDecompress(data);
      else if (comp === 5) {
        if (!window.fzstd) throw new Error('zstd decompressor not loaded');
        data = window.fzstd.decompress(data);
      } else if (comp === 2 || comp === 3) throw new Error('legacy ' + (comp === 2 ? 'zlib' : 'bzip2') + ' clusters are not supported');
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const osize = extended ? 8 : 4;
      const first = extended ? Number(dv.getBigUint64(0, true)) : dv.getUint32(0, true);
      const n = Math.floor(first / osize);
      const offs = new Array(n);
      for (let i = 0; i < n; i++) offs[i] = extended ? Number(dv.getBigUint64(i * 8, true)) : dv.getUint32(i * 4, true);
      const cluster = { data, offs };
      this._clusters.set(idx, cluster);
      while (this._clusters.size > 8) this._clusters.delete(this._clusters.keys().next().value);
      return cluster;
    }

    async getEntryData(e) {
      if (e.redirect >= 0) e = this.resolve(e.i);
      if (!e || e.cluster < 0) throw new Error('entry has no content');
      const c = await this.getCluster(e.cluster);
      if (e.blob + 1 >= c.offs.length) throw new Error('blob index out of range');
      return c.data.subarray(c.offs[e.blob], c.offs[e.blob + 1]);
    }

    async getMetadata() {
      const get = async (k) => {
        const i = this.byPath.get('M/' + k);
        if (i === undefined) return '';
        try { return td8.decode(await this.getEntryData(this.entries[i])).trim(); } catch (e) { return ''; }
      };
      return {
        title: await get('Title'),
        description: (await get('Description')) || (await get('LongDescription')),
        language: await get('Language'),
        creator: await get('Creator'),
        date: await get('Date')
      };
    }
  }

  // ---------- conversion ----------
  async function convert(reader, opts, onProgress) {
    opts = opts || {};
    const entries = reader.entries;
    const notes = new Map();
    const attachments = new Map();
    const progress = (phase, done, total, detail) => { if (onProgress) onProgress({ phase, done, total, detail }); };
    const cancelled = () => opts.isCancelled && opts.isCancelled();

    // pick articles (document order), then sort by cluster for sequential decompression
    let articles = [];
    for (const e of entries) {
      if (!e || e.skip || e.redirect >= 0 || !e.mime) continue;
      if (e.mime.indexOf('text/html') === 0 && (e.ns === 'A' || e.ns === 'C')) articles.push(e);
    }
    if (opts.maxArticles > 0 && articles.length > opts.maxArticles) articles = articles.slice(0, opts.maxArticles);
    articles.sort((a, b) => a.cluster - b.cluster || a.blob - b.blob);

    // assign unique note names
    const usedNames = new Set();
    const noteOf = new Map();
    for (const e of articles) {
      const base = sanitizeName(e.title || decodeSafe((e.url.split('/').pop() || '').replace(/\.html?$/i, '')));
      let name = base, n = 2;
      while (usedNames.has(name.toLowerCase())) name = base + ' ' + (n++);
      usedNames.add(name.toLowerCase());
      noteOf.set(e.i, name);
    }

    // path -> note name (articles themselves + redirects that land on them)
    const linkMap = new Map();
    for (const e of entries) {
      if (!e || e.skip) continue;
      const t = e.redirect >= 0 ? reader.resolve(e.i) : e;
      if (t && noteOf.has(t.i)) {
        const name = noteOf.get(t.i);
        linkMap.set(e.ns + '/' + e.url, name);
        linkMap.set(e.ns + '/' + decodeSafe(e.url), name);
      }
    }

    // attachment naming
    const attOf = new Map();
    const usedAtt = new Set();
    const refs = [];
    function attNameFor(t) {
      if (attOf.has(t.i)) return attOf.get(t.i);
      let base = sanitizeName(decodeSafe(t.url.split('/').pop() || 'file'));
      if (!/\.[a-z0-9]{2,5}$/i.test(base)) base += extFromMime(t.mime) || '.bin';
      let name = base, n = 2;
      while (usedAtt.has(name.toLowerCase())) {
        const dot = base.lastIndexOf('.');
        name = dot > 0 ? base.slice(0, dot) + ' ' + n + base.slice(dot) : base + ' ' + n;
        n++;
      }
      usedAtt.add(name.toLowerCase());
      attOf.set(t.i, name);
      refs.push(t);
      return name;
    }

    // turndown
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', hr: '---', bulletListMarker: '-', emDelimiter: '*' });
    if (window.turndownPluginGfm) td.use(window.turndownPluginGfm.gfm);
    td.addRule('wikilink', {
      filter: (n) => n.nodeName === 'A' && !!n.getAttribute('data-wl'),
      replacement: (content, n) => {
        const t = n.getAttribute('data-wl');
        const c = (content || '').replace(/\\([\[\]])/g, '$1').replace(/\n+/g, ' ').trim();
        return (c && c !== t) ? '[[' + t + '|' + c + ']]' : '[[' + t + ']]';
      }
    });
    td.addRule('wikiimage', {
      filter: (n) => n.nodeName === 'IMG' && !!n.getAttribute('data-wi'),
      replacement: (c, n) => '![[' + n.getAttribute('data-wi') + ']]'
    });

    function rewrite(doc, e) {
      let base;
      try { base = new URL('zim:///' + e.ns + '/' + e.url); } catch (err) { base = new URL('zim:///' + e.ns + '/'); }
      const toPath = (href) => {
        try {
          const u = new URL(href, base);
          if (u.protocol !== 'zim:') return null;
          return decodeSafe(u.pathname.replace(/^\/+/, ''));
        } catch (err) { return null; }
      };
      for (const a of doc.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href');
        if (!href || /^(#|mailto:|javascript:|tel:)/i.test(href)) { a.removeAttribute('href'); continue; }
        if (/^(https?|ftp):/i.test(href)) continue; // keep external links as-is
        const path = toPath(href);
        const name = path && (linkMap.get(path) || linkMap.get(path.replace(/\.html?$/i, '')) || linkMap.get(path + '.html'));
        if (name) a.setAttribute('data-wl', name);
        else a.removeAttribute('href'); // unresolvable internal link -> plain text
      }
      for (const img of Array.from(doc.querySelectorAll('img'))) {
        const src = img.getAttribute('src') || '';
        if (/^https?:/i.test(src)) { if (!opts.includeImages) img.remove(); continue; }
        if (!opts.includeImages || /^data:/i.test(src)) { img.remove(); continue; }
        const path = toPath(src);
        let t = null;
        if (path !== null) {
          const idx = reader.byPath.get(path);
          if (idx !== undefined) t = reader.resolve(idx);
        }
        if (t && t.mime && t.mime.indexOf('image/') === 0) img.setAttribute('data-wi', attNameFor(t));
        else img.remove();
      }
    }

    const STRIP = 'script,style,noscript,link,meta,iframe,object,embed,video,audio,form,input,button,.mw-editsection,.noprint';
    const parser = new DOMParser();
    let lastYield = performance.now();
    let done = 0;
    const total = articles.length;
    progress('Converting articles', 0, total, '');

    for (const e of articles) {
      if (cancelled()) return null;
      const name = noteOf.get(e.i);
      const title = e.title || name;
      try {
        const data = await reader.getEntryData(e);
        const doc = parser.parseFromString(td8.decode(data), 'text/html');
        doc.querySelectorAll(STRIP).forEach((n) => n.remove());
        rewrite(doc, e);
        const h1 = doc.body.querySelector('h1');
        if (h1 && h1.textContent.trim().toLowerCase() === title.trim().toLowerCase()) h1.remove();
        let md = td.turndown(doc.body);
        md = md.replace(/\n{3,}/g, '\n\n').trim() + '\n';
        const fm = opts.frontmatter !== false
          ? '---\ntitle: "' + title.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"\n---\n\n'
          : '';
        notes.set(name, { md: fm + md, title });
      } catch (err) {
        notes.set(name, { md: '> Conversion failed: ' + err.message + '\n', title });
      }
      done++;
      if (performance.now() - lastYield > 40) {
        progress('Converting articles', done, total, name);
        await new Promise((r) => setTimeout(r, 0));
        lastYield = performance.now();
      }
    }
    progress('Converting articles', total, total, '');

    // extract referenced images, grouped by cluster
    refs.sort((a, b) => a.cluster - b.cluster || a.blob - b.blob);
    let ad = 0;
    for (const t of refs) {
      if (cancelled()) return null;
      try {
        const data = await reader.getEntryData(t);
        attachments.set(attOf.get(t.i), { data: data.slice(), mime: t.mime });
      } catch (err) { /* skip broken attachment */ }
      ad++;
      if (performance.now() - lastYield > 40) {
        progress('Extracting images', ad, refs.length, attOf.get(t.i) || '');
        await new Promise((r) => setTimeout(r, 0));
        lastYield = performance.now();
      }
    }

    let mainNote = '';
    if (reader.mainPage !== 0xffffffff && entries[reader.mainPage]) {
      const m = reader.resolve(reader.mainPage);
      if (m && noteOf.has(m.i)) mainNote = noteOf.get(m.i);
    }
    const order = Array.from(notes.keys()).sort((a, b) => a.localeCompare(b));
    return { notes, attachments, order, mainNote };
  }

  window.ZimVault = { ZimReader, convert, sanitizeName };
})();
