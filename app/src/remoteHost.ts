import qrcode from 'qrcode-generator';
import type { PackageModel } from './packageData';
import { remoteHash, type RemoteCommand, type RemoteJob } from './remoteTypes';

export interface RemoteHostOptions {
  snapshot(): RemoteJob;
  /** `rev` changes whenever the meshes do; `build` is only called then. */
  models(): { rev: string; build(): PackageModel[] };
  onCommand(cmd: RemoteCommand): void;
  /** Cabinets (one per STEP file) and their part names, for deep links. */
  sections(): { name: string; parts: string[] }[];
}


const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;');

/** A crisp QR as one SVG path: dark modules only, 4-module quiet zone. */
function qrSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text); qr.make();
  const n = qr.getModuleCount(), q = 4;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + q} ${r + q}h1v1h-1z`;
  return `<svg viewBox="0 0 ${n + q * 2} ${n + q * 2}" shape-rendering="crispEdges" role="img" aria-label="QR code for ${text}"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#111"/></svg>`;
}

/**
 * Shop remote host. The top-corner button shows a QR for remote.html on the
 * LAN; once a phone connects, every change here is pushed to it and every
 * edit there arrives as a command. Hidden when not served by the dev server.
 */
export function mountRemoteHost(button: HTMLButtonElement, opts: RemoteHostOptions) {
  const nonce = Math.random().toString(36).slice(2, 8);
  let phones = 0, open = false, addresses: string[] = [], port = '', chosen = 0;
  let section = '', part = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let publishing = false, again = false, serverModelsRev = '';

  const pop = document.createElement('div');
  pop.className = 'remote-pop';
  pop.hidden = true;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Open on your phone');
  document.body.append(pop);

  const url = () => `http://${addresses[chosen]}:${port}/remote.html${remoteHash(section, part)}`;
  const opt = (v: string, label: string, on: boolean) => `<option value="${escapeAttr(v)}" ${on ? 'selected' : ''}>${escapeText(label)}</option>`;
  const render = () => {
    button.classList.toggle('live', phones > 0);
    button.title = phones > 0 ? `${phones} phone${phones > 1 ? 's' : ''} connected — show QR` : 'Open on your phone (QR code)';
    if (!open) return;
    if (addresses.length < 2) {
      pop.innerHTML = `<p class="remote-pop-title">Open on your phone</p><p class="remote-pop-note">No local network found. Connect this computer to Wi-Fi or Ethernet.</p>`;
      return;
    }
    const sections = opts.sections();
    if (section && !sections.some(s => s.name === section)) { section = ''; part = ''; }
    const parts = sections.find(s => s.name === section)?.parts ?? [];
    if (part && !parts.includes(part)) part = '';
    pop.innerHTML = `<p class="remote-pop-title">Open on your phone</p>
      ${sections.length ? `<div class="remote-pick">
        <label>Section <select data-pick="section">${opt('', 'Whole job', !section)}${sections.map(s => opt(s.name, s.name, s.name === section)).join('')}</select></label>
        ${section ? `<label>Part <select data-pick="part">${opt('', 'Whole section', !part)}${parts.map(n => opt(n, n, n === part)).join('')}</select></label>` : ''}
      </div>` : ''}
      <div class="remote-qr">${qrSvg(url())}</div>
      <a class="remote-url" href="${escapeAttr(url())}" target="_blank" rel="noopener">${escapeText(url())}</a>
      <label class="remote-addr">Address <select data-pick="address">${addresses.map((a, i) => opt(String(i), i === 0 ? `${a} (name)` : a, i === chosen)).join('')}</select></label>
      <p class="remote-pop-note">${phones > 0 ? `<span class="remote-dot"></span>${phones} phone${phones > 1 ? 's' : ''} connected` : 'Scan with the phone camera on the same Wi-Fi. If the name does not open, pick the number address.'}</p>`;
    pop.querySelectorAll<HTMLSelectElement>('select[data-pick]').forEach(sel => sel.addEventListener('change', () => {
      if (sel.dataset.pick === 'address') chosen = Number(sel.value);
      if (sel.dataset.pick === 'section') { section = sel.value; part = ''; }
      if (sel.dataset.pick === 'part') part = sel.value;
      render();
    }));
  };
  const place = () => {
    const r = button.getBoundingClientRect();
    pop.style.top = `${r.bottom + 6}px`;
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - 268, r.left))}px`;
  };
  const setOpen = (v: boolean) => {
    open = v; pop.hidden = !v; button.setAttribute('aria-expanded', String(v));
    if (v) { listen(); place(); render(); schedule(0); }
  };
  button.addEventListener('click', e => { e.stopPropagation(); setOpen(!open); });
  document.addEventListener('pointerdown', e => { if (open && !pop.contains(e.target as Node) && e.target !== button) setOpen(false); });
  document.addEventListener('keydown', e => { if (open && e.key === 'Escape') setOpen(false); });
  window.addEventListener('resize', () => { if (open) place(); });

  async function post(path: string, body: string) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
  }
  async function publish() {
    if (publishing) { again = true; return; }
    publishing = true;
    try {
      const m = opts.models();
      const rev = `${nonce}:${m.rev}`;
      if (rev !== serverModelsRev) {
        await post(`/__remote/models?rev=${encodeURIComponent(rev)}`, JSON.stringify(m.build()));
        serverModelsRev = rev;
      }
      await post('/__remote/job', JSON.stringify(opts.snapshot()));
    } catch (err) {
      console.warn('Shop remote publish failed', err);
    } finally {
      publishing = false;
      if (again) { again = false; schedule(); }
    }
  }
  /** Coalesce bursts of UI changes; nothing is sent until a phone is around. */
  function schedule(delay = 250) {
    if (!phones && !open) return;
    clearTimeout(timer);
    timer = setTimeout(() => void publish(), delay);
  }

  /** Opened on first QR use, then on every load: an idle app keeps no
   *  long-lived connection (and stays network-idle for tests). */
  const KEY = 'plywood-estimator:shop-remote:v1';
  const remembered = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
  let listening = false;
  function listen() {
    if (listening) return;
    listening = true;
    try { localStorage.setItem(KEY, '1'); } catch { /* session only */ }
    const events = new EventSource('/__remote/events?role=desk');
    events.addEventListener('hello', e => { serverModelsRev = JSON.parse((e as MessageEvent).data).modelsRev; });
    events.addEventListener('presence', e => {
      const before = phones;
      phones = JSON.parse((e as MessageEvent).data).phones;
      render();
      if (phones > before) schedule(0);
    });
    events.addEventListener('command', e => {
      try { opts.onCommand(JSON.parse((e as MessageEvent).data)); } catch (err) { console.warn('Shop remote command failed', err); }
    });
  }

  void (async () => {
    try {
      const res = await fetch('/__remote/info');
      if (!res.ok) return;
      const info = await res.json() as { addresses: string[]; hostname: string; port: number; local: boolean };
      if (!info.local) return;
      // The .local name survives DHCP changes, so it is the default; numbers are the fallback.
      addresses = info.addresses.length ? [info.hostname, ...info.addresses] : []; port = String(info.port || location.port);
      button.hidden = false;
      if (remembered()) listen();
    } catch { /* static build: no bridge, keep the button hidden */ }
  })();

  return { schedule };
}
