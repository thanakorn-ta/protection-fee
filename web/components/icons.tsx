/** ไอคอนเส้นจาก demo */

const base = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export function ShieldIcon({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth={size > 20 ? 1.8 : 2} {...base}><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z" /><path d="M9 12l2 2 4-4" /></svg>;
}

export function ArrowIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" strokeWidth="2" {...base}><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></svg>;
}

export function LogoutIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" strokeWidth="2" {...base}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 17l-5-5 5-5" /><path d="M5 12h11" /></svg>;
}

export function CheckIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" strokeWidth="2.2" {...base}><path d="M5 12.5l4.5 4.5L19 7" /></svg>;
}

export function PlusIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" strokeWidth="2.2" {...base}><path d="M12 5v14" /><path d="M5 12h14" /></svg>;
}

export function PinIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" strokeWidth="2" {...base} style={{ color: 'var(--green)' }}><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></svg>;
}

export function CopyIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" strokeWidth="2" {...base}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>;
}

export function SearchIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" strokeWidth="2" {...base}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>;
}

export function InfoIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" strokeWidth="2" {...base} style={{ flex: 'none', marginTop: 2 }}><circle cx="12" cy="12" r="9" /><path d="M12 8v5" /><path d="M12 16.5v.01" /></svg>;
}
