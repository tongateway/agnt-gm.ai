// useVisible — is anyone looking at the page? False while the tab is hidden or
// Telegram has minimised the mini-app (the owner is off in the t.me/newbot
// flow after "Create your bot"). Drives the pollers down to a crawl.
import { useEffect, useState } from 'react';
import { onVisibility } from '../telegram';

export function useVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => onVisibility(setVisible), []);
  return visible;
}
