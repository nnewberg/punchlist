import { useEffect, useRef, type ReactNode } from 'react';
import { person } from '../../shared/config';
import type { Status } from '../../shared/types';

/** Status as progress around a circle: dashed (not committed), empty (ready), half (underway), full (done). */
export function Glyph({ status }: { status: Status }) {
  return (
    <svg className={`glyph ${status}`} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      {status === 'backlog' && <circle cx="7" cy="7" r="6" strokeDasharray="2.36 2.36" transform="rotate(-11 7 7)" />}
      {(status === 'up_next' || status === 'in_progress' || status === 'dropped') && <circle cx="7" cy="7" r="6" />}
      {status === 'in_progress' && <path d="M7 3.25a3.75 3.75 0 0 1 0 7.5z" fill="currentColor" stroke="none" />}
      {status === 'done' && (
        <>
          <circle cx="7" cy="7" r="6.75" fill="currentColor" stroke="none" />
          <path d="M4.4 7.2l1.8 1.8 3.5-3.7" style={{ stroke: 'var(--bg)' }} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {status === 'dropped' && <path d="M5.1 5.1l3.8 3.8M8.9 5.1l-3.8 3.8" strokeLinecap="round" />}
    </svg>
  );
}

export function Avatar({ user, size, title }: { user: string | null | undefined; size?: number; title?: string }) {
  const p = person(user);
  const style = size ? { width: size, height: size, fontSize: Math.round(size * 0.42) } : undefined;
  if (!user) return <span className="avatar gh" style={style} title={title ?? 'GitHub'}>gh</span>;
  return <span className="avatar" style={{ background: p.color, ...style }} title={title ?? p.name}>{p.initial}</span>;
}

export function Logo({ size }: { size?: 'lg' }) {
  return <div role="img" aria-label="Punchlist" className="logo" style={size === 'lg' ? { width: 120, height: 80 } : undefined} />;
}

export const PlusIcon = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" style={{ strokeWidth: 1.6, strokeLinecap: 'round' }}><path d="M5.5 1v9M1 5.5h9" /></svg>
);
export const SearchIcon = () => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" style={{ strokeWidth: 1.5, strokeLinecap: 'round', flex: 'none' }}><circle cx="5.5" cy="5.5" r="4" /><path d="M8.5 8.5l3 3" /></svg>
);
export const FilterIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" style={{ strokeWidth: 1.5, strokeLinecap: 'round' }}><path d="M1 3h10M3 6h6M5 9h2" /></svg>
);
export const ChevronIcon = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" style={{ strokeWidth: 1.5, color: 'var(--fg3)' }}><path d="M2 3.5l3 3 3-3" /></svg>
);
export const CloseIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" fill="none" style={{ strokeWidth: 1.5, strokeLinecap: 'round' }}><path d="M2 2l8 8M10 2l-8 8" /></svg>
);
export const TrashIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" style={{ strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
    <path d="M2 3.5h10M5.5 3.5V2.2c0-.4.3-.7.7-.7h1.6c.4 0 .7.3.7.7v1.3M3.3 3.5l.6 8.3c0 .5.5.9 1 .9h4.2c.5 0 .9-.4 1-.9l.6-8.3M5.8 6v4.2M8.2 6v4.2" />
  </svg>
);
export const BranchIcon = () => (
  <svg width="10" height="12" viewBox="0 0 10 12" fill="none" stroke="currentColor" style={{ strokeWidth: 1.3, flex: 'none' }}>
    <circle cx="2.5" cy="2.5" r="1.5" /><circle cx="2.5" cy="9.5" r="1.5" /><circle cx="7.5" cy="4" r="1.5" /><path d="M2.5 4v4M7.5 5.5c0 2-5 1.5-5 2.5" />
  </svg>
);

/** Closes a popover on outside click or Escape. */
export function useDismiss<T extends HTMLElement>(open: boolean, close: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

/** A one-line input that commits on Enter and cancels on Escape or blur-with-nothing. */
export function InlineInput({ placeholder, onSubmit, onCancel, className = 'inline-input' }: { placeholder: string; onSubmit: (v: string) => void; onCancel: () => void; className?: string }) {
  return (
    <input
      autoFocus
      className={className}
      placeholder={placeholder}
      onKeyDown={e => {
        if (e.key === 'Enter' && e.currentTarget.value.trim()) onSubmit(e.currentTarget.value.trim());
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
      onBlur={e => !e.currentTarget.value.trim() && onCancel()}
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <div className="k">{label}</div>
      <div className="v">{children}</div>
    </div>
  );
}
