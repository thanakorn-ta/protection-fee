'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, money, norm, stampThai, ROLE_LABEL, STATUS_LABEL, type AppData, type Entry, type Location, type Member, type Mode, type Role, type User } from './api';
import { monthLong, parseIso, sheetMonthText, thaiShort, todayBangkok, toIso } from '@/lib/dates';
import { CheckIcon, CopyIcon, PinIcon, PlusIcon, SearchIcon } from './icons';
import type { Toast } from './App';

const MODE_TEXT: Record<Mode, { subtitle: string; note: string }> = {
  EXAT: { subtitle: 'การทางพิเศษแห่งประเทศไทย — จ่ายแบบทดรองจ่าย', note: 'ตาราง รถคุ้มครอง EXAT (ทดรองจ่าย)' },
  BEM: { subtitle: 'บมจ.ทางด่วนและรถไฟฟ้ากรุงเทพ — จ่ายแบบเปิด PR', note: 'ตาราง รถคุ้มครอง BEM (เปิด PR)' },
};

const keyOf = (m: Mode) => (m === 'EXAT' ? 'exat' : 'bem');

function errorBox(msg: string) {
  return msg ? <div className="error">{msg}</div> : null;
}

function DataList({ id, values }: { id: string; values: string[] }) {
  return <datalist id={id}>{values.map(v => <option key={v} value={v} />)}</datalist>;
}

function showDate(e: Entry) {
  const p = parseIso(e.date);
  return p ? thaiShort(p) : e.dateText;
}

/* ---------------- ตารางรายการ ---------------- */

type Col = [keyof Entry, string, string];

function entryCols(mode: Mode): Col[] {
  const cols: Col[] = [
    ['no', 'ลำดับ', 'mono'], ['date', 'วันที่', 'nowrap'], ['place', 'สถานที่', ''], ['project', 'โครงการ', 'nowrap'],
    ['jobType', 'ประเภทงาน', ''], ['worker', 'ผู้เข้างาน', 'nowrap'],
  ];
  if (mode === 'EXAT') cols.push(['fee', 'ค่าอาหาร/รถ (บาท)', 'num']);
  else cols.push(['feeText', 'ค่ารถคุ้มครอง', 'nowrap'], ['payment', 'การชำระเงิน', 'nowrap']);
  return cols;
}

function cellText(e: Entry, key: keyof Entry) {
  if (key === 'date') return showDate(e);
  if (key === 'fee') return money(e.fee);
  return String(e[key] ?? '');
}

function EntryHead({ cols, actions }: { cols: Col[]; actions?: boolean }) {
  return (
    <thead>
      <tr>
        {cols.map(c => <th key={c[0]} className={c[2] === 'num' ? 'num' : ''}>{c[1]}</th>)}
        {actions && <th className="num">จัดการ</th>}
      </tr>
    </thead>
  );
}

/* ================= บันทึกการใช้รถ ================= */

function projectFor(loc: Location) {
  const op = /^BEM/.test(loc.operator) ? 'BEM' : 'EXAT';
  return (/gateway/i.test(loc.mediaSite) ? 'Gateway ' : 'Flyover 2.0 ') + op;
}

interface EntryForm {
  date: string; worker: string; place: string; expressway: string; project: string; jobType: string;
  fee: string; feeText: string; payment: string;
}

export function EntryPage({ data, user, reload, toast }: { data: AppData; user: User; reload: () => Promise<void>; toast: Toast }) {
  const [mode, setModeState] = useState<Mode>('EXAT');
  const blank = useCallback((keep?: Partial<EntryForm>, m: Mode = 'EXAT'): EntryForm => ({
    date: keep?.date || toIso(todayBangkok()),
    worker: keep?.worker ?? user.nickname ?? '',
    place: '', expressway: '', project: m === 'EXAT' ? 'Flyover 2.0 EXAT' : 'Flyover 2.0 BEM', jobType: '',
    fee: '400', feeText: '', payment: data.options.payments[0] || 'รอดำเนินการ',
  }), [user.nickname, data.options.payments]);
  const [form, setForm] = useState<EntryForm>(() => blank());
  const [autofill, setAutofill] = useState<{ exp: string; proj: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [freshRow, setFreshRow] = useState<number | null>(null);

  const set = (k: keyof EntryForm, v: string) => setForm(f => ({ ...f, [k]: v }));

  const setMode = (m: Mode) => {
    setModeState(m);
    setForm(f => ({ ...f, project: m === 'BEM' ? f.project.replace(/EXAT$/, 'BEM') : f.project.replace(/BEM$/, 'EXAT') }));
  };

  const onPlace = (v: string) => {
    const loc = data.locations.find(l => l.area === v.trim());
    if (!loc) { setForm(f => ({ ...f, place: v })); setAutofill(null); return; }
    const proj = projectFor(loc);
    setForm(f => ({ ...f, place: v, project: proj, expressway: loc.expressway || f.expressway }));
    setAutofill({ exp: loc.expressway || '—', proj });
    const op: Mode = proj.endsWith('BEM') ? 'BEM' : 'EXAT';
    if (op !== mode) setModeState(op);
  };

  const clear = (keep?: Partial<EntryForm>) => {
    setForm(blank(keep, mode));
    setAutofill(null);
    setError('');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const labels: [keyof EntryForm, string][] = [['date', 'วันที่'], ['worker', 'ผู้เข้างาน'], ['place', 'สถานที่'], ['expressway', 'สายทาง'], ['jobType', 'ประเภทงาน']];
    for (const [k, label] of labels) if (!String(form[k]).trim()) return setError('กรอก' + label + 'ก่อนบันทึก');
    if (mode === 'EXAT') {
      const fee = Number(form.fee);
      if (form.fee === '' || !isFinite(fee) || fee < 0) return setError('ค่าอาหาร/รถคุ้มครองต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป');
    }
    setBusy(true);
    setError('');
    try {
      const body = {
        key: keyOf(mode), date: form.date, worker: form.worker, place: form.place, expressway: form.expressway,
        project: form.project, jobType: form.jobType,
        ...(mode === 'EXAT' ? { fee: Number(form.fee) } : { feeText: form.feeText, payment: form.payment }),
      };
      const r = await api<{ row: number; no: string }>('/api/entries', { method: 'POST', body });
      setFreshRow(r.row);
      clear({ date: form.date, worker: form.worker });
      toast('บันทึกลง Google Sheet แล้ว — ' + mode + ' ลำดับที่ ' + r.no);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const recent = data.recent[keyOf(mode)];
  const sum = data.summary[keyOf(mode)];
  const cols = entryCols(mode);

  return (
    <main className="wrap page">
      <div className="page-head">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <h1>บันทึกการใช้รถคุ้มครอง</h1>
          <p className="muted">{MODE_TEXT[mode].subtitle}</p>
        </div>
        <div className="seg" role="group" aria-label="เลือกผู้ให้บริการรถคุ้มครอง">
          <button type="button" aria-pressed={mode === 'EXAT'} onClick={() => setMode('EXAT')}>EXAT · ทดรองจ่าย</button>
          <button type="button" aria-pressed={mode === 'BEM'} onClick={() => setMode('BEM')}>BEM · เปิด PR</button>
        </div>
      </div>

      <div className="split">
        <form className="card main-col" onSubmit={submit} noValidate>
          <div className="row">
            <label className="field">วันที่
              <input type="date" value={form.date} onChange={e => set('date', e.target.value)} required />
            </label>
            <label className="field">ผู้เข้างาน
              <input value={form.worker} onChange={e => set('worker', e.target.value)} list="dl-workers" placeholder="ชื่อผู้รับผิดชอบหน้างาน" required />
            </label>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label className="field">สถานที่
              <input value={form.place} onChange={e => onPlace(e.target.value)} list="dl-places" placeholder="พิมพ์รหัสป้ายหรือชื่อจุด เช่น 4.3 หรือ ด่านดินแดง" required />
            </label>
            {autofill && (
              <div className="autofill">
                <PinIcon />
                <span>จากฐานข้อมูลป้าย เติมให้แล้ว:</span>
                <span className="chip">{autofill.exp}</span>
                <span className="chip">{autofill.proj}</span>
              </div>
            )}
          </div>
          <div className="row">
            <label className="field">สายทาง
              <input value={form.expressway} onChange={e => set('expressway', e.target.value)} list="dl-expressways" placeholder="เช่น เฉลิมมหานคร" required />
            </label>
            <label className="field">โครงการ
              <select value={form.project} onChange={e => set('project', e.target.value)} required>
                {data.options.projects.map(p => <option key={p}>{p}</option>)}
              </select>
            </label>
          </div>
          <label className="field">ประเภทงาน
            <input value={form.jobType} onChange={e => set('jobType', e.target.value)} list="dl-jobs" placeholder="เช่น ติดตั้งสินค้า, ตรวจสอบโครงสร้างประจำปี" required />
          </label>

          {mode === 'EXAT' ? (
            <div className="panel-amber">
              <label className="field">ค่าอาหาร/รถคุ้มครอง
                <span className="fee-input">
                  <input type="number" min={0} step={1} inputMode="numeric" value={form.fee} onChange={e => set('fee', e.target.value)} />
                  <span>บาท</span>
                </span>
              </label>
              <div className="quick">
                <button type="button" onClick={() => set('fee', '400')}>400 · จุดแรกของวัน</button>
                <button type="button" onClick={() => set('fee', '0')}>0 · จุดถัดไปในวันเดียวกัน</button>
              </div>
            </div>
          ) : (
            <div className="panel-blue row">
              <label className="field">ค่ารถคุ้มครอง
                <input value={form.feeText} onChange={e => set('feeText', e.target.value)} list="dl-bemfees" placeholder="เช่น คิดค่ารถ 1 คืน" />
              </label>
              <label className="field">การชำระเงิน
                <select value={form.payment} onChange={e => set('payment', e.target.value)}>
                  {data.options.payments.map(p => <option key={p}>{p}</option>)}
                </select>
              </label>
            </div>
          )}

          {errorBox(error)}
          <div className="actions">
            <button type="submit" className="btn primary" disabled={busy}><CheckIcon />{busy ? 'กำลังบันทึก…' : 'บันทึก'}</button>
            <button type="button" className="btn" onClick={() => clear()}>ล้างฟอร์ม</button>
          </div>
        </form>

        <aside className="side-col">
          <div className="summary">
            <div className="label">{mode} · {sum.month ? monthLong(sum.month) : 'ยังไม่มีรายการ'}</div>
            <div className="nums">
              <div><div className="num">{sum.count}</div><div className="unit">ครั้ง</div></div>
              {mode === 'EXAT'
                ? <div><div className="num amber">{money(sum.amount)}</div><div className="unit">บาท</div></div>
                : <div><div className="num amber">{sum.unpaid}</div><div className="unit">ยังไม่ชำระ</div></div>}
            </div>
          </div>
          <div className="card tips">
            <strong>วิธีกรอก</strong>
            <div>เข้าหลายจุดในวันเดียวกัน ให้บันทึกทุกจุด แต่คิดค่าใช้จ่ายจุดแรกจุดเดียว</div>
            <div>เลือกสถานที่จากรายการ ระบบเติมสายทางและโครงการให้เอง</div>
            <div>กดบันทึกแล้ว ข้อมูลเขียนลง Google Sheet ทันที</div>
          </div>
        </aside>
      </div>

      <section className="card table-card">
        <div className="table-head"><h2>รายการล่าสุด</h2><span className="sub">{MODE_TEXT[mode].note}</span></div>
        <div className="table-wrap">
          <table style={{ minWidth: 860 }}>
            <EntryHead cols={cols} />
            <tbody>
              {recent.length ? recent.map(e => (
                <tr key={e.row} className={e.row === freshRow ? 'fresh' : ''}>
                  {cols.map(c => <td key={c[0]} className={c[2]}>{cellText(e, c[0])}</td>)}
                </tr>
              )) : <tr><td className="empty" colSpan={cols.length}>ยังไม่มีรายการ {mode}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <DataList id="dl-places" values={data.options.places} />
      <DataList id="dl-expressways" values={data.options.expressways} />
      <DataList id="dl-jobs" values={data.options.jobTypes} />
      <DataList id="dl-workers" values={data.options.workers} />
      <DataList id="dl-bemfees" values={data.options.bemFees} />
    </main>
  );
}

/* ================= รายการรายเดือน ================= */

function tsvFor(list: Entry[], mode: Mode) {
  // เรียงคอลัมน์ตามตารางใน Google Sheet (ไม่รวมลำดับ)
  return list.map(e => {
    const p = parseIso(e.date);
    const row: (string | number)[] = [p ? sheetMonthText(p) : '', p ? thaiShort(p) : e.dateText, mode, e.expressway, e.project, e.place, e.jobType, e.worker];
    if (mode === 'EXAT') row.push(e.fee); else row.push(e.feeText, e.payment);
    return row.map(v => String(v ?? '').replace(/[\t\n]/g, ' ')).join('\t');
  }).join('\n');
}

export function ListPage({ user, toast, reload }: { user: User; toast: Toast; reload: () => Promise<void> }) {
  const [mode, setMode] = useState<Mode>('EXAT');
  const [month, setMonth] = useState('');
  const [res, setRes] = useState<{ months: string[]; month: string; entries: Entry[]; lastRow: number } | null>(null);
  const [error, setError] = useState('');
  const [confirmRow, setConfirmRow] = useState<number | null>(null);
  const [fallback, setFallback] = useState('');

  const load = useCallback(async (m: Mode, mo: string) => {
    setError('');
    try {
      const r = await api<{ months: string[]; month: string; entries: Entry[]; lastRow: number }>('/api/entries?key=' + keyOf(m) + (mo ? '&month=' + encodeURIComponent(mo) : ''));
      setRes(r);
      setMonth(r.month);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { load(mode, month); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = res?.entries || [];
  const cols = entryCols(mode);

  const del = async (row: number) => {
    try {
      await api('/api/entries?key=' + keyOf(mode) + '&row=' + row, { method: 'DELETE' });
      setConfirmRow(null);
      toast('ลบรายการแล้ว');
      await Promise.all([load(mode, month), reload()]);
    } catch (e) {
      setConfirmRow(null);
      toast((e as Error).message, true);
    }
  };

  const copy = () => {
    const text = tsvFor(list, mode);
    const fail = () => { setFallback(text); toast('คัดลอกอัตโนมัติไม่ได้ — กด Ctrl+C เพื่อคัดลอกข้อความที่เลือกไว้'); };
    try {
      navigator.clipboard.writeText(text).then(() => { setFallback(''); toast('คัดลอก ' + list.length + ' แถวแล้ว — วางในคอลัมน์ “เดือน”'); }, fail);
    } catch {
      fail();
    }
  };

  return (
    <main className="wrap page">
      <div className="page-head">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <h1>รายการรายเดือน</h1>
          <p className="muted">ข้อมูลจากตารางใน Google Sheet ดูตามเดือน แล้วคัดลอกไปวางในไฟล์ Accrue / Clear ได้</p>
        </div>
      </div>
      <div className="month-bar">
        <label className="field">เดือน
          <select value={month} onChange={e => { setConfirmRow(null); setMonth(e.target.value); load(mode, e.target.value); }}>
            {(res?.months || []).map(m => <option key={m} value={m}>{monthLong(m)}</option>)}
          </select>
        </label>
        <div className="seg" role="group" aria-label="ผู้ให้บริการ">
          {(['EXAT', 'BEM'] as Mode[]).map(m => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => { setConfirmRow(null); setRes(null); setMonth(''); setMode(m); }}>{m}</button>
          ))}
        </div>
      </div>
      {errorBox(error)}
      <section className="card table-card">
        <div className="table-head">
          <h2>{month ? mode + ' · ' + monthLong(month) : mode}</h2>
          <button type="button" className="btn sm" onClick={copy} disabled={!list.length}><CopyIcon />คัดลอกไปวางใน Google Sheet</button>
        </div>
        <div className="totals">
          <span>รายการ <b>{list.length}</b></span>
          {mode === 'EXAT'
            ? <span>รวมค่าใช้จ่าย <b>{money(list.reduce((s, e) => s + e.fee, 0))}</b> บาท</span>
            : <span>ยังไม่ชำระ <b>{list.filter(e => e.payment.trim() !== 'เรียบร้อย').length}</b> รายการ</span>}
        </div>
        <div className="table-wrap">
          <table style={{ minWidth: 900 }}>
            <EntryHead cols={cols} actions />
            <tbody>
              {!res && !error && <tr><td className="empty" colSpan={cols.length + 1}>กำลังโหลด…</td></tr>}
              {res && !list.length && <tr><td className="empty" colSpan={cols.length + 1}>ยังไม่มีรายการ</td></tr>}
              {list.map(e => {
                const isLast = e.row === res?.lastRow;
                const confirming = confirmRow === e.row;
                return (
                  <tr key={e.row} className={confirming ? 'confirm-row' : ''}>
                    {cols.map(c => <td key={c[0]} className={c[2]}>{cellText(e, c[0])}</td>)}
                    <td className="num nowrap">
                      {isLast && (confirming
                        ? <><button type="button" className="btn sm danger" onClick={() => del(e.row)}>ยืนยันลบ</button> <button type="button" className="btn sm" onClick={() => setConfirmRow(null)}>ยกเลิก</button></>
                        : <button type="button" className="btn sm" title={user.role === 'admin' ? 'ลบรายการล่าสุด' : 'ลบได้เฉพาะรายการที่คุณบันทึกเอง'} onClick={() => setConfirmRow(e.row)}>ลบ</button>)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {fallback && (
          <textarea aria-label="ข้อมูลสำหรับคัดลอก" readOnly value={fallback} ref={el => { el?.focus(); el?.select(); }}
            style={{ margin: '0 20px', height: 120, fontFamily: 'var(--mono)', fontSize: 13, border: '1.5px solid var(--field)', borderRadius: 8, background: 'var(--field-bg)', color: 'var(--ink)' }} />
        )}
        <p className="sub" style={{ padding: '0 20px 12px' }}>ลบได้เฉพาะรายการล่าสุดของตาราง เพื่อไม่ให้ตารางในชีทมีแถวว่างคั่น — แก้ไขรายการอื่นได้ใน Google Sheet</p>
      </section>
    </main>
  );
}

/* ================= สถานที่ ================= */

const MEDIA_SITES = ['Flyover 2.0 EXAT', 'Flyover 2.0 BECL', 'Gateway Billboard EXAT', 'Gateway Billboard BECL'];

export function LocationsPage({ data, isAdmin, reload, toast }: { data: AppData; isAdmin: boolean; reload: () => Promise<void>; toast: Toast }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'EXAT' | 'BEM' | 'Gateway'>('all');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const list = useMemo(() => {
    const nq = norm(q);
    return data.locations.filter(l => {
      if (filter === 'Gateway' && !/gateway/i.test(l.mediaSite)) return false;
      if ((filter === 'EXAT' || filter === 'BEM') && !l.operator.startsWith(filter)) return false;
      return !nq || norm([l.code, l.area, l.road, l.district, l.meetingPoint, l.police, l.expressway, l.mediaSite].join(' ')).includes(nq);
    });
  }, [data.locations, q, filter]);

  const add = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formEl = e.currentTarget;
    const f = Object.fromEntries(new FormData(formEl).entries()) as Record<string, string>;
    if (!f.code?.trim() || !f.area?.trim()) return setError('กรอกรหัสป้ายและบริเวณ');
    if (data.locations.some(l => l.code === f.code.trim())) return setError('มีรหัสป้าย ' + f.code.trim() + ' อยู่แล้ว');
    setBusy(true);
    setError('');
    try {
      await api('/api/locations', { method: 'POST', body: { ...f, count: '1' } });
      formEl.reset();
      toast('เพิ่มสถานที่ ' + f.code.trim() + ' ลง Google Sheet แล้ว');
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="wrap page">
      <div className="page-head">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <h1>ฐานข้อมูลสถานที่</h1>
          <p className="muted">ป้าย Flyover 2.0, Mainline และ Gateway Billboard จากแท็บ DataBase Locations</p>
        </div>
      </div>
      <div className="split">
        <section className="card table-card main-col">
          <div className="table-head">
            <label className="search">
              <SearchIcon />
              <input type="search" aria-label="ค้นหาสถานที่" placeholder="ค้นหารหัสป้าย ถนน หรือจุดนัดพบ" value={q} onChange={e => setQ(e.target.value)} />
            </label>
            <div className="filters" role="group" aria-label="กรองสถานที่">
              {(['all', 'EXAT', 'BEM', 'Gateway'] as const).map(f => (
                <button key={f} type="button" className="pill" aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === 'all' ? 'ทั้งหมด' : f}</button>
              ))}
            </div>
          </div>
          <div className="sub" style={{ padding: '0 20px' }}>แสดง {list.length} จาก {data.locations.length} จุด</div>
          <div className="table-wrap">
            <table style={{ minWidth: 760 }}>
              <thead><tr><th>ป้าย</th><th>บริเวณ</th><th>ผู้ดูแล · สายทาง</th><th>ขนาด</th><th>จุดนัดพบ</th><th>สน.</th></tr></thead>
              <tbody>
                {list.length ? list.map(l => {
                  const sub = [l.mediaSite, l.road && 'ถนน' + l.road, l.district && 'เขต' + l.district].filter(Boolean).join(' · ');
                  return (
                    <tr key={l.code + l.area}>
                      <td><span className="code-tag">{l.code}</span></td>
                      <td><div style={{ fontWeight: 500 }}>{l.area}</div><div className="sub">{sub}</div></td>
                      <td className="nowrap">{[l.operator, l.expressway].filter(Boolean).join(' · ')}</td>
                      <td className="nowrap mono">{l.size}{Number(l.count) > 1 ? ' ×' + l.count : ''}</td>
                      <td className="nowrap">{l.meetingPoint || '—'}</td>
                      <td className="nowrap">{l.police || '—'}</td>
                    </tr>
                  );
                }) : <tr><td className="empty" colSpan={6}>ไม่พบสถานที่ที่ค้นหา</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        {isAdmin && (
          <form className="card side-form side-col" onSubmit={add} noValidate>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <h2>เพิ่มสถานที่</h2>
              <span className="status pending">ผู้ดูแลระบบ</span>
            </div>
            <div className="grid2">
              <label className="field">รหัสป้าย<input name="code" placeholder="8.2" required /></label>
              <label className="field">ขนาด<input name="size" placeholder="3 x 14 m." /></label>
            </div>
            <label className="field">บริเวณ<input name="area" placeholder="รหัส ชื่อจุด (English)" required /></label>
            <div className="grid2">
              <label className="field">Media Site
                <select name="mediaSite">{MEDIA_SITES.map(m => <option key={m}>{m}</option>)}</select>
              </label>
              <label className="field">ผู้ดูแล
                <select name="operator"><option>EXAT</option><option>BEM</option></select>
              </label>
              <label className="field">สายทาง<input name="expressway" list="dl-loc-expressways" /></label>
              <label className="field">ถนน<input name="road" /></label>
              <label className="field">เขต กทม.<input name="district" /></label>
              <label className="field">จุดนัดพบ<input name="meetingPoint" placeholder="ด่านอโศก 1" /></label>
              <label className="field">สน.<input name="police" placeholder="สน.ยานาวา" /></label>
            </div>
            {errorBox(error)}
            <button type="submit" className="btn primary block" disabled={busy}><PlusIcon />{busy ? 'กำลังเพิ่ม…' : 'เพิ่มสถานที่'}</button>
            <DataList id="dl-loc-expressways" values={data.options.expressways} />
          </form>
        )}
      </div>
    </main>
  );
}

/* ================= สมาชิก (ผู้ดูแลระบบ) ================= */

export function MembersPage({ me, reload, toast }: { me: User; reload: () => Promise<void>; toast: Toast }) {
  const [users, setUsers] = useState<Member[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      setUsers((await api<{ users: Member[] }>('/api/users')).users);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const change = async (u: Member, changes: { role?: Role; status?: Member['status'] }, msg: string) => {
    setBusy(u.email);
    try {
      await api('/api/users', { method: 'PATCH', body: { email: u.email, ...changes } });
      toast(msg);
      await Promise.all([load(), reload()]);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy('');
    }
  };

  const pending = (users || []).filter(u => u.status === 'pending');
  const others = (users || []).filter(u => u.status !== 'pending');

  return (
    <main className="wrap page">
      <div className="page-head">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <h1>สมาชิก</h1>
          <p className="muted">อนุมัติผู้สมัครใหม่ กำหนดสิทธิ์ และระงับบัญชี — ข้อมูลอยู่ในแท็บ Users ของ Google Sheet</p>
        </div>
      </div>
      {errorBox(error)}
      {pending.length > 0 && (
        <div className="pending-box">
          <h2>รออนุมัติ {pending.length} คน</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {pending.map(u => (
              <div className="pending-item" key={u.email}>
                <div>
                  <span style={{ fontWeight: 600 }}>{u.fullName} ({u.nickname})</span>
                  <span className="sub">{u.email}{u.phone ? ' · ' + u.phone : ''} · สมัคร {stampThai(u.createdAt)}</span>
                </div>
                <button type="button" className="btn primary sm" disabled={busy === u.email} onClick={() => change(u, { status: 'active' }, 'อนุมัติ ' + u.email + ' แล้ว — เข้าสู่ระบบได้ทันที')}>อนุมัติ</button>
                <button type="button" className="btn sm" disabled={busy === u.email} onClick={() => change(u, { status: 'rejected' }, 'ไม่อนุมัติ ' + u.email)}>ไม่อนุมัติ</button>
              </div>
            ))}
          </div>
        </div>
      )}
      <section className="card table-card">
        <div className="table-head"><h2>สมาชิกทั้งหมด</h2></div>
        <div className="table-wrap">
          <table style={{ minWidth: 760 }}>
            <thead><tr><th>สมาชิก</th><th>สิทธิ์</th><th>สถานะ</th><th>เข้าใช้ล่าสุด</th><th className="num">จัดการ</th></tr></thead>
            <tbody>
              {!users && !error && <tr><td className="empty" colSpan={5}>กำลังโหลด…</td></tr>}
              {others.map(u => {
                const self = u.email === me.email;
                return (
                  <tr key={u.email}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{u.fullName}{self && <span className="sub"> (คุณ)</span>}</div>
                      <div className="sub">{u.email} · {u.nickname}</div>
                    </td>
                    <td>
                      <select aria-label={'สิทธิ์ของ ' + u.email} value={u.role} disabled={self || busy === u.email}
                        onChange={e => change(u, { role: e.target.value as Role }, 'เปลี่ยนสิทธิ์ ' + u.email + ' เป็น' + ROLE_LABEL[e.target.value as Role] + 'แล้ว')}>
                        <option value="user">ผู้ใช้งาน</option>
                        <option value="admin">ผู้ดูแลระบบ</option>
                      </select>
                    </td>
                    <td><span className={'status ' + u.status}>{STATUS_LABEL[u.status] || u.status}</span></td>
                    <td className="nowrap mono">{u.lastLogin ? stampThai(u.lastLogin) : '—'}</td>
                    <td className="num nowrap">
                      {!self && (
                        <button type="button" className={'btn sm' + (u.status === 'active' ? ' danger' : '')} disabled={busy === u.email}
                          onClick={() => change(u, { status: u.status === 'active' ? 'disabled' : 'active' }, (u.status === 'active' ? 'ระงับ ' : 'เปิดใช้งาน ') + u.email + ' แล้ว')}>
                          {u.status === 'active' ? 'ระงับ' : 'เปิดใช้งาน'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

/* ================= บัญชีของฉัน ================= */

export function AccountPage({ user, setUser, toast }: { user: User; setUser: (u: User) => void; toast: Toast }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
    if (!f.fullName?.trim()) return setError('กรอกชื่อ-นามสกุล');
    if (!f.nickname?.trim()) return setError('กรอกชื่อเล่น');
    setBusy(true);
    setError('');
    try {
      const r = await api<{ user: User }>('/api/me', { method: 'PATCH', body: f });
      setUser(r.user);
      toast('บันทึกข้อมูลแล้ว');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="wrap page">
      <div className="page-head">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <h1>บัญชีของฉัน</h1>
          <p className="muted">{user.email} · {ROLE_LABEL[user.role]}</p>
        </div>
      </div>
      <form className="card side-form" onSubmit={save} noValidate style={{ maxWidth: 440 }}>
        <h2>ข้อมูลส่วนตัว</h2>
        <label className="field">ชื่อ-นามสกุล<input name="fullName" defaultValue={user.fullName} autoComplete="name" required /></label>
        <label className="field">ชื่อเล่น<input name="nickname" defaultValue={user.nickname} placeholder="ใช้ในช่องผู้เข้างาน" required /></label>
        <label className="field"><span>เบอร์โทร <span className="opt">(ไม่บังคับ)</span></span><input name="phone" type="tel" defaultValue={user.phone} inputMode="tel" /></label>
        {errorBox(error)}
        <button type="submit" className="btn primary block" disabled={busy}>{busy ? 'กำลังบันทึก…' : 'บันทึก'}</button>
        <p className="sub">เข้าสู่ระบบด้วยบัญชี Google จึงไม่มีรหัสผ่านในระบบนี้ — เปลี่ยนรหัสผ่านได้ที่บัญชี Google</p>
      </form>
    </main>
  );
}
