import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { api, boardPath, type Me } from './api';
import { BoardPage } from './BoardPage';
import { MyWorkPage, StatesPage } from './GroupsPage';
import { SignedOut } from './components/SignedOut';

export function App() {
  const [me, setMe] = useState<Me | null | 'signed-out'>(null);
  useEffect(() => {
    api<Me>('/v1/me').then(setMe, () => setMe('signed-out'));
  }, []);

  if (me === null) return <div className="app" />;
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/signin" element={<SignedOut />} />
        {me === 'signed-out' ? (
          <Route path="*" element={<Navigate to="/signin" replace />} />
        ) : (
          <>
            <Route path="/" element={<Navigate to={me.boards[0] ? boardPath(me.boards[0]) : '/me'} replace />} />
            <Route path="/me" element={<MyWorkPage me={me.user} boards={me.boards} />} />
            <Route path="/_states" element={<StatesPage me={me.user} boards={me.boards} />} />
            <Route path="/:owner/:repo" element={<BoardPage me={me.user} boards={me.boards} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </>
        )}
      </Routes>
    </BrowserRouter>
  );
}
