'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, setUnauthorizedHandler, ROLE_LABEL, STATUS_LABEL, type AppData, type AuthResult, type User } from './api';
import { AccountPage, EntryPage, ListPage, LocationsPage, MembersPage } from './pages';
import { ArrowIcon, LogoutIcon, ShieldIcon, InfoIcon } from './icons';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window { google?: any }
}

type Page = 'entry' | 'list' | 'locations' | 'members' | 'account';

export interface Toast { (msg: string, isErr?: boolean): void }

export default function App({ googleClientId, devLogin }: { googleClientId: string; devLogin: boolean }) {
  const [phase, setPhase] = useState<'loading' | 'auth' | 'app'>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [toastMsg, setToastMsg] = useState<{ msg: string; err: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const toast: Toast = useCallback((msg: string, isErr = false) => {
    setToastMsg({ msg, err: isErr });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToastMsg(null), 3600);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      setPhase('auth');
      toast('หมดเวลาการใช้งาน กรุณาเข้าสู่ระบบใหม่', true);
    });
    api<{ user: User }>('/api/me')
      .then(r => { setUser(r.user); setPhase('app'); })
      .catch(() => setPhase('auth'));
  }, [toast]);

  const logout = async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ออกจากระบบฝั่งหน้าเว็บต่อไป */ }
    window.google?.accounts?.id?.disableAutoSelect?.();
    setUser(null);
    setPhase('auth');
    window.scrollTo(0, 0);
  };

  return (
    <>
      {phase === 'loading' && <div className="loading">กำลังโหลด…</div>}
      {phase === 'auth' && (
        <AuthScreen googleClientId={googleClientId} devLogin={devLogin} onLoggedIn={u => { setUser(u); setPhase('app'); }} />
      )}
      {phase === 'app' && user && <Shell user={user} setUser={setUser} onLogout={logout} toast={toast} />}
      {toastMsg && <div id="toast" role="status" aria-live="polite" className={toastMsg.err ? 'err' : ''}>{toastMsg.msg}</div>}
    </>
  );
}

/* ================= เข้าสู่ระบบ / สมัครสมาชิก ================= */

function AuthScreen({ googleClientId, devLogin, onLoggedIn }: { googleClientId: string; devLogin: boolean; onLoggedIn: (u: User) => void }) {
  const [view, setView] = useState<'signin' | 'signup' | 'waiting'>('signin');
  const [profile, setProfile] = useState<{ email: string; name: string } | null>(null);
  const [waiting, setWaiting] = useState<{ user: User; createdAt?: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const btnRef = useRef<HTMLDivElement>(null);
  const loggedIn = useRef(onLoggedIn);
  loggedIn.current = onLoggedIn;

  const handle = useCallback((r: AuthResult) => {
    setError('');
    if (r.state === 'ok' && r.user) loggedIn.current(r.user);
    else if (r.state === 'signup' && r.profile) { setProfile(r.profile); setView('signup'); }
    else if (r.state === 'waiting' && r.user) { setWaiting({ user: r.user, createdAt: r.createdAt }); setView('waiting'); }
  }, []);

  const submit = useCallback(async (path: string, body: unknown) => {
    setBusy(true);
    try { handle(await api<AuthResult>(path, { method: 'POST', body })); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, [handle]);

  // ปุ่ม Sign in with Google
  useEffect(() => {
    if (view !== 'signin' || !googleClientId) return;
    let cancelled = false;
    const render = () => {
      if (cancelled || !window.google?.accounts?.id || !btnRef.current) return;
      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: (r: { credential?: string }) => { if (r.credential) submit('/api/auth/google', { credential: r.credential }); },
        ux_mode: 'popup',
      });
      window.google.accounts.id.renderButton(btnRef.current, { theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', locale: 'th', width: 320 });
    };
    if (window.google?.accounts?.id) render();
    else {
      let s = document.getElementById('gsi-script') as HTMLScriptElement | null;
      if (!s) {
        s = document.createElement('script');
        s.id = 'gsi-script';
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true;
        s.onerror = () => setError('โหลดปุ่ม Google ไม่ได้ ตรวจอินเทอร์เน็ตแล้วรีเฟรชหน้า');
        document.head.appendChild(s);
      }
      s.addEventListener('load', render);
    }
    return () => { cancelled = true; };
  }, [view, googleClientId, submit]);

  const onSignup = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const fullName = String(f.get('fullName') || '').trim();
    const nickname = String(f.get('nickname') || '').trim();
    if (!fullName) return setError('กรอกชื่อ-นามสกุล');
    if (!nickname) return setError('กรอกชื่อเล่น ใช้เป็นชื่อในช่องผู้เข้างาน');
    submit('/api/auth/register', { fullName, nickname, phone: String(f.get('phone') || '').trim() });
  };

  const onDev = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    submit('/api/auth/dev', { email: f.get('email'), name: f.get('name') });
  };

  const back = () => { setView('signin'); setError(''); setProfile(null); setWaiting(null); };

  return (
    <div className="wrap auth">
      <div className="auth-shell">
        <div className="auth-hero">
          <span className="sign"><ShieldIcon size={28} /></span>
          <div>
            <h1>Protection Fee</h1>
            <p>ระบบบันทึกการใช้รถคุ้มครอง EXAT · BEM</p>
          </div>
        </div>
        <div className="lane" />
        <div className="auth-body">
          {view === 'signin' && (
            <>
              <h2 style={{ fontSize: 20 }}>เข้าสู่ระบบ</h2>
              <p className="muted">ใช้บัญชี Google ของคุณ ครั้งแรกจะให้กรอกใบสมัคร แล้วรอผู้ดูแลระบบอนุมัติ</p>
              {googleClientId
                ? <div className="gsi" ref={btnRef} aria-busy={busy} />
                : <div className="error">ยังไม่ได้ตั้งค่า GOOGLE_CLIENT_ID — ปุ่ม Sign in with Google ใช้ไม่ได้</div>}
              {error && <div className="error">{error}</div>}
              <div className="steps">
                <div><b>1</b><span>เข้าสู่ระบบด้วย Google</span></div>
                <div><b>2</b><span>กรอกชื่อและชื่อเล่น (ครั้งแรกเท่านั้น)</span></div>
                <div><b className="amber">3</b><span>รอผู้ดูแลระบบอนุมัติ แล้วจึงเข้าใช้งานได้</span></div>
              </div>
              {devLogin && (
                <form className="dev-login" onSubmit={onDev}>
                  <span><b>โหมดทดสอบ</b> — เข้าสู่ระบบด้วยอีเมลโดยไม่ใช้ Google (เฉพาะ npm run dev)</span>
                  <div className="grid2">
                    <label className="field">อีเมล<input name="email" type="email" required placeholder="admin@example.com" /></label>
                    <label className="field">ชื่อ<input name="name" placeholder="ชื่อที่แสดง" /></label>
                  </div>
                  <button type="submit" className="btn" disabled={busy}>เข้าสู่ระบบทดสอบ</button>
                </form>
              )}
            </>
          )}

          {view === 'signup' && profile && (
            <form onSubmit={onSignup} noValidate>
              <h2 style={{ fontSize: 20 }}>สมัครสมาชิก</h2>
              <div className="profile"><div><b>{profile.name || profile.email}</b>{profile.email}</div></div>
              <label className="field">ชื่อ-นามสกุล
                <input name="fullName" autoComplete="name" defaultValue={profile.name} required />
              </label>
              <div className="grid2">
                <label className="field">ชื่อเล่น
                  <input name="nickname" placeholder="ใช้ในช่องผู้เข้างาน" required />
                </label>
                <label className="field"><span>เบอร์โทร <span className="opt">(ไม่บังคับ)</span></span>
                  <input name="phone" type="tel" autoComplete="tel" inputMode="tel" />
                </label>
              </div>
              {error && <div className="error">{error}</div>}
              <button type="submit" className="btn primary block" style={{ minHeight: 50 }} disabled={busy}>ส่งใบสมัคร <ArrowIcon /></button>
              <button type="button" className="btn block" onClick={back}>ยกเลิก</button>
            </form>
          )}

          {view === 'waiting' && waiting && (
            <div className="waiting">
              <h2 style={{ fontSize: 20 }}>{waiting.user.status === 'rejected' ? 'ใบสมัครไม่ได้รับอนุมัติ' : 'ส่งใบสมัครแล้ว'}</h2>
              <p className="muted">
                {waiting.user.status === 'rejected'
                  ? 'ติดต่อผู้ดูแลระบบหากคิดว่าเป็นความผิดพลาด'
                  : 'ผู้ดูแลระบบจะตรวจสอบและอนุมัติบัญชีของคุณ เมื่ออนุมัติแล้วกดเข้าสู่ระบบด้วย Google ได้ทันที'}
              </p>
              <dl>
                <dt>อีเมล</dt><dd>{waiting.user.email}</dd>
                <dt>ชื่อ-นามสกุล</dt><dd>{waiting.user.fullName}</dd>
                <dt>ชื่อเล่น</dt><dd>{waiting.user.nickname}</dd>
                <dt>สถานะ</dt><dd><span className={'status ' + waiting.user.status}>{STATUS_LABEL[waiting.user.status]}</span></dd>
              </dl>
              {waiting.user.status === 'pending' && (
                <div className="notice"><InfoIcon /><div>แจ้งผู้ดูแลระบบให้อนุมัติที่เมนู “สมาชิก”</div></div>
              )}
              <button type="button" className="btn" onClick={back}>กลับไปหน้าเข้าสู่ระบบ</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ================= แอป ================= */

function Shell({ user, setUser, onLogout, toast }: { user: User; setUser: (u: User) => void; onLogout: () => void; toast: Toast }) {
  const [page, setPage] = useState<Page>('entry');
  const [data, setData] = useState<AppData | null>(null);
  const [loadError, setLoadError] = useState('');
  const isAdmin = user.role === 'admin';

  const reload = useCallback(async () => {
    try {
      const d = await api<AppData>('/api/data');
      setData(d);
      setUser(d.user);
      setLoadError('');
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [setUser]);

  useEffect(() => { reload(); }, [reload]);

  const go = (p: Page) => {
    setPage(p === 'members' && !isAdmin ? 'entry' : p);
    window.scrollTo(0, 0);
  };

  const nav: [Page, string][] = [['entry', 'บันทึกการใช้รถ'], ['list', 'รายการรายเดือน'], ['locations', 'สถานที่'], ['members', 'สมาชิก'], ['account', 'บัญชีของฉัน']];

  return (
    <div id="app">
      <header className="top">
        <div className="wrap top-inner">
          <div className="brand"><span className="sign"><ShieldIcon size={18} /></span>Protection Fee</div>
          <nav className="menu" aria-label="เมนูหลัก">
            {nav.filter(([p]) => p !== 'members' || isAdmin).map(([p, label]) => (
              <button key={p} type="button" aria-current={page === p ? 'page' : undefined} onClick={() => go(p)}>
                {label}
                {p === 'members' && !!data?.pendingCount && <span className="count">{data.pendingCount}</span>}
              </button>
            ))}
          </nav>
          <div className="me">
            <div className="me-name"><span>{user.nickname || user.fullName}</span><span>{ROLE_LABEL[user.role]}</span></div>
            <button type="button" className="icon-btn" aria-label="ออกจากระบบ" title="ออกจากระบบ" onClick={onLogout}><LogoutIcon /></button>
          </div>
        </div>
        <div className="lane" />
      </header>

      {loadError && (
        <main className="wrap page">
          <div className="error">โหลดข้อมูลจาก Google Sheet ไม่สำเร็จ: {loadError}</div>
          <div><button type="button" className="btn" onClick={reload}>ลองใหม่</button></div>
        </main>
      )}
      {!data && !loadError && <div className="loading">กำลังโหลดข้อมูลจาก Google Sheet…</div>}
      {data && (
        <>
          {page === 'entry' && <EntryPage data={data} user={user} reload={reload} toast={toast} />}
          {page === 'list' && <ListPage user={user} toast={toast} reload={reload} />}
          {page === 'locations' && <LocationsPage data={data} isAdmin={isAdmin} reload={reload} toast={toast} />}
          {page === 'members' && isAdmin && <MembersPage me={user} reload={reload} toast={toast} />}
          {page === 'account' && <AccountPage user={user} setUser={setUser} toast={toast} />}
        </>
      )}
    </div>
  );
}
