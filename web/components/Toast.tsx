import { useEffect } from 'react';
import { Avatar } from './ui';

export interface ToastData {
  key: number;
  user: string | null;
  text: string;
  undoSeq?: number;
  warn?: boolean;
}

const TOAST_MS = 6000;

export function Toast({ data, onDone, onUndo }: { data: ToastData; onDone: () => void; onUndo?: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, TOAST_MS);
    return () => clearTimeout(t);
  }, [data.key, onDone]);
  return (
    <div className="toast" key={data.key} role="status">
      {data.warn ? <span className="ring warn" /> : <Avatar user={data.user} size={18} />}
      <span>{data.text}</span>
      {!data.warn && <span className="ring" />}
      {onUndo && <button onClick={onUndo}>Undo</button>}
    </div>
  );
}
