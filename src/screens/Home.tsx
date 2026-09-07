// Home (#/) — the idea box (PromptScreen hero + chips) with the owner's bots
// underneath. Sending the idea creates the draft and opens the Bot page: the
// conversation continues there. Server is the source of truth for the list
// (DELETE then refetch); only the pin order is kept client-side.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Theme } from '../theme';
import { ApiError, startChat, listProjectsByAgent, deleteProject } from '../api/client';
import { insideTelegram, haptic } from '../telegram';
import { navigate } from '../router';
import { useT } from '../i18n';
import { ConfirmSheet } from '../ui';
import { PromptScreen } from './Prompt';
import { MyBotsList, MyBot, botFromProject } from '../manage/MyBots';

// Pinned bots — the owner's own ordering, kept client-side (there is no server
// field for it). Stored oldest-pin-first; pinned bots render on top, newest
// pin highest.
const PINNED_KEY = 'agentbot-pinned';
function loadPinned(): string[] {
  try { const v = JSON.parse(localStorage.getItem(PINNED_KEY) || '[]'); return Array.isArray(v) ? v as string[] : []; }
  catch { return []; }
}

export function HomeScreen({ T, authed, agentId, tryAuth }: {
  T: Theme; authed: boolean; agentId: string | null; tryAuth: () => Promise<boolean>;
}) {
  const t = useT();
  const [idea, setIdea] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [bots, setBots] = useState<MyBot[]>([]);
  const [loading, setLoading] = useState(false);
  const [pinnedIds, setPinnedIds] = useState<string[]>(loadPinned);
  // A swipe armed a pin/delete and is waiting on the confirm sheet. null = shut.
  const [swipeConfirm, setSwipeConfirm] = useState<{ kind: 'delete' | 'pin'; bot: MyBot } | null>(null);
  const lastSwipeConfirm = useRef(swipeConfirm); // keeps the copy stable while the sheet slides out

  const refresh = useCallback(async () => {
    if (!authed || !agentId) { setBots([]); return; }
    setLoading(true);
    try {
      const list = await listProjectsByAgent(agentId);
      setBots((list.projects || [])
        .filter(p => p.status !== 'rejected' && p.status !== 'archived')
        .map(botFromProject));
    } catch { /* keep whatever we had */ }
    setLoading(false);
  }, [authed, agentId]);
  useEffect(() => { void refresh(); }, [refresh]);

  // "Build it": create the draft from the idea and go straight to its page
  const start = async () => {
    if (starting || !idea.trim()) return;
    if (!authed && !(await tryAuth())) return; // auth raced the tap — retry once
    setStarting(true); setStartError(null);
    try {
      const r = await startChat(idea.trim());
      navigate({ name: 'bot', id: r.project_id });
    } catch (e) {
      setStartError(e instanceof ApiError ? `${e.message}${e.details ? ` (${e.details})` : ''}` : t('network error', 'ошибка сети'));
    } finally {
      setStarting(false);
    }
  };

  // ── pin / unpin (client-side ordering) ──
  const persistPins = (ids: string[]) => {
    setPinnedIds(ids);
    try { localStorage.setItem(PINNED_KEY, JSON.stringify(ids)); } catch { /* storage blocked — order lives for the session */ }
  };
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const unpin = (id: string) => { if (pinnedIds.includes(id)) persistPins(pinnedIds.filter(x => x !== id)); };
  // Swipe-right routes here: unpinning is the harmless reverse of the gesture, so
  // it fires immediately; pinning reorders the list, so it asks first.
  const onSwipePin = (id: string) => {
    if (pinnedSet.has(id)) { haptic('light'); unpin(id); return; }
    const bot = bots.find(b => b.id === id);
    if (bot) setSwipeConfirm({ kind: 'pin', bot });
  };
  const onSwipeDelete = (id: string) => {
    const bot = bots.find(b => b.id === id);
    if (bot) setSwipeConfirm({ kind: 'delete', bot });
  };
  const confirmSwipe = () => {
    if (!swipeConfirm) return;
    const { kind, bot } = swipeConfirm;
    setSwipeConfirm(null);
    if (kind === 'pin') { haptic('success'); persistPins([...pinnedIds.filter(x => x !== bot.id), bot.id]); return; }
    // delete: server-side archive, then refetch — the list is never edited locally
    setBots(bs => bs.filter(b => b.id !== bot.id)); // instant feedback; the refetch is the truth
    unpin(bot.id);
    deleteProject(bot.id).catch(() => {}).finally(() => void refresh());
  };
  // Pinned bots float to the top, newest pin highest; the rest keep server order.
  const sorted = useMemo(() => {
    const rank = (id: string) => { const i = pinnedIds.indexOf(id); return i < 0 ? -1 : pinnedIds.length - i; };
    return [...bots].sort((a, b) => rank(b.id) - rank(a.id));
  }, [bots, pinnedIds]);

  if (swipeConfirm) lastSwipeConfirm.current = swipeConfirm;
  const c = swipeConfirm ?? lastSwipeConfirm.current;
  const del = c?.kind === 'delete';
  const cName = c?.bot.name || t('this bot', 'этот бот');
  return (
    <>
      <PromptScreen T={T} idea={idea} setIdea={setIdea} changed={false} error={startError}
        startBtn={{
          // outside Telegram there is no initData to authorize with — say so
          label: idea.trim() && !authed && !insideTelegram
            ? t('Open in Telegram to build', 'Откройте в Telegram, чтобы собрать')
            : t('Build it', 'Собрать'),
          disabled: !idea.trim() || (!authed && !insideTelegram) || starting,
          busy: starting,
          onClick: () => void start(),
        }} />
      <MyBotsList T={T} bots={sorted} loading={loading} authed={authed} pinned={pinnedSet}
        onOpen={(id) => navigate({ name: 'bot', id })}
        onDelete={onSwipeDelete} onPin={onSwipePin} />
      <ConfirmSheet
        T={T} open={!!swipeConfirm}
        destructive={del}
        icon={del ? 'trash' : 'pin'}
        title={del ? t('Delete this bot?', 'Удалить этого бота?') : t('Pin to the top?', 'Закрепить наверху?')}
        body={del
          ? t(`Removes ${cName} from your list. The Telegram bot itself keeps running.`,
              `Удаляет ${cName} из вашего списка. Сам Telegram-бот продолжит работать.`)
          : t(`${cName} will stay at the top of your bots.`, `${cName} будет всегда наверху списка ботов.`)}
        confirmLabel={del ? t('Delete', 'Удалить') : t('Pin', 'Закрепить')}
        cancelLabel={t('Cancel', 'Отмена')}
        onConfirm={confirmSwipe}
        onCancel={() => setSwipeConfirm(null)} />
    </>
  );
}
