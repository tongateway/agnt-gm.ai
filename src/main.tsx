import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initTelegram, applyStartParamRoute } from './telegram';
import { LangProvider } from './i18n';

initTelegram();
// Before React mounts: a `?startapp=open_<id>` link becomes #/bots/<id>, so the
// owner lands on the bot the message was about instead of the list.
applyStartParamRoute();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LangProvider>
      <App />
    </LangProvider>
  </React.StrictMode>,
);
