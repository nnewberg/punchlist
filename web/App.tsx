import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { setPeople } from '../shared/config';
import { api, ApiError, boardPath, knownBrowser, setAccount, signInUrl, type Me } from './api';
import { BoardPage } from './BoardPage';
import { MyWorkPage, StatesPage } from './GroupsPage';
import { Header } from './components/Header';
import { NoBoards, SignedOut } from './components/SignedOut';

// A browser that has signed in before goes back through GitHub on its own when the session runs out
// (FR-3a), since GitHub remembers the approval. Once per minute at most, so a failing sign-in shows
// the button instead of looping.
function silentReauth(): boolean {
  if (!knownBrowser()) return false;
  try {
    const last = Number(sessionStorage.getItem('pl_reauth') ?? 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem('pl_reauth', String(Date.now()));
  } catch {
    return false;
  }
  location.replace(signInUrl());
  return true;
}

export function App() {
  const [me, setMe] = useState<Me | null | 'signed-out'>(null);
  useEffect(() => {
    api<Me>('/v1/me').then(
      m => {
        setPeople(m.people, m.dev);
        setAccount(m);
        setMe(m);
      },
      e => {
        if (e instanceof ApiError && e.status === 401 && silentReauth()) return;
        setMe('signed-out');
      },
    );
  }, []);

  if (me === null) return <div className="app" />;
  if (me === 'signed-out') return <SignedOut />;
  return (
    <BrowserRouter>
      <Routes>
        {me.boards.length === 0 ? (
          <Route path="*" element={<div className="app"><Header title="" boards={[]} me={me.user} query="" onQuery={() => {}} /><NoBoards installUrl={me.installUrl} /></div>} />
        ) : (
          <>
            <Route path="/" element={<Navigate to={boardPath(me.boards[0]!)} replace />} />
            <Route path="/signin" element={<Navigate to="/" replace />} />
            <Route path="/me" element={<MyWorkPage me={me.user} boards={me.boards} />} />
            {me.dev && <Route path="/_states" element={<StatesPage me={me.user} boards={me.boards} />} />}
            <Route path="/:owner/:repo" element={<BoardPage me={me.user} boards={me.boards} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </>
        )}
      </Routes>
    </BrowserRouter>
  );
}
