// BotEnv — the bot's settings table: the keys it needs from its owner.
//
// The chat asks for these once, while the bot builds. This screen is everything
// after: seeing what is still missing, replacing a key that rotated, removing
// one that leaked.
//
// The API never returns a stored value, so this screen cannot show one — there
// is no "reveal" to write. A row says SET, MISSING or SKIPPED, and the owner
// re-pastes when they need to change something. That is the whole security
// model of the feature and the reason there is no state here holding a secret
// beyond the input the owner is actively typing.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Theme } from '../theme';
import {
  ApiError, BotEnvPanel, BotEnvRow, getBotEnv, setBotEnvValue, deleteBotEnvValue,
} from '../api/client';
import { Card, Pill, Spinner, TGIcon, ConfirmSheet, DANGER } from '../ui';
import { useT } from '../i18n';
import { haptic } from '../telegram';

// A pending action waiting on the confirmation sheet. Holding the typed value
// here is what lets the sheet stay a pure yes/no: nothing is sent until the
// owner confirms.
type Pending =
  | { kind: 'save'; row: BotEnvRow; value: string }
  | { kind: 'delete'; row: BotEnvRow };

// Pill tones: green reads as done, gold as "needs you", neutral as parked.
function statusTone(status: BotEnvRow['status']): 'green' | 'gold' | 'neutral' {
  switch (status) {
    case 'set': return 'green';
    case 'missing': return 'gold';
    default: return 'neutral';
  }
}

export function BotEnv({ T, projectId, botLiveHint }: {
  T: Theme; projectId: string; botLiveHint?: boolean;
}) {
  const t = useT();
  const [panel, setPanel] = useState<BotEnvPanel | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Which row is open for editing, and the value being typed into it. Cleared
  // the moment the request settles — a secret shouldn't outlive its use.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ key: string; message: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const load = useCallback(async () => {
    try {
      const p = await getBotEnv(projectId);
      setPanel(p ?? { env: [], summary: { total: 0, set: 0, missing: 0, skipped: 0 }, bot_live: !!botLiveHint });
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : t('Could not load settings', 'Не удалось загрузить настройки'));
    } finally {
      setLoading(false);
    }
  }, [projectId, botLiveHint, t]);

  useEffect(() => { void load(); }, [load]);

  function closeEditor() {
    setEditing(null);
    setDraft('');
    setReveal(false);
  }

  function openEditor(row: BotEnvRow) {
    haptic('light');
    setRowError(null);
    setEditing(row.key);
    setDraft('');
    setReveal(false);
  }

  // Both mutations go through the sheet first — the owner asked to be asked.
  function askSave(row: BotEnvRow) {
    const value = draft.trim();
    if (!value) {
      setRowError({ key: row.key, message: t('Enter a value first', 'Сначала введите значение') });
      return;
    }
    haptic('light');
    setPending({ kind: 'save', row, value });
  }

  function askDelete(row: BotEnvRow) {
    haptic('warning');
    setRowError(null);
    setPending({ kind: 'delete', row });
  }

  async function runPending() {
    if (!pending) return;
    const { kind, row } = pending;
    const value = kind === 'save' ? pending.value : '';
    setPending(null);
    setBusyKey(row.key);
    setRowError(null);
    try {
      const next = kind === 'save'
        ? await setBotEnvValue(projectId, row.key, value)
        : await deleteBotEnvValue(projectId, row.key);
      setPanel(next);
      closeEditor();
      haptic('success');
    } catch (e) {
      haptic('error');
      setRowError({
        key: row.key,
        message: e instanceof ApiError ? e.message : t('Something went wrong', 'Что-то пошло не так'),
      });
    } finally {
      setBusyKey(null);
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '48px 16px' }}>
        <Spinner color={T.hint} size={22} />
      </div>
    );
  }

  const rows = panel?.env ?? [];
  const missing = panel?.summary.missing ?? 0;
  const live = panel?.bot_live ?? !!botLiveHint;

  return (
    // Боковые отступы задаёт каждый экран сам — скроллер в App их не даёт.
    // 16px 16px 28px при gap 12 — ровно как у «События» и «Требует внимания»,
    // двух других списочных экранов; обзор бота отличается только низом.
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 16px 28px' }}>

      {/* What this screen is. Short, because the rows explain themselves. */}
      <Card T={T}>
        <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
          <div style={{ marginTop: 1, color: T.hint, flex: 'none' }}><TGIcon name="lock" size={19} /></div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>
              {t('Keys your bot uses', 'Ключи, которые использует бот')}
            </div>
            <div style={{ fontSize: 13.5, color: T.sub, lineHeight: 1.5 }}>
              {t('Stored encrypted. Values are never shown back — not here, not anywhere. To change one, paste the new value over it.',
                 'Хранятся в зашифрованном виде. Значения не показываются обратно — ни здесь, ни где-либо ещё. Чтобы поменять, вставьте новое поверх старого.')}
            </div>
          </div>
        </div>
      </Card>

      {loadError && (
        <Card T={T} style={{ borderColor: T.redSoft }}>
          <div style={{ fontSize: 14, color: DANGER }}>{loadError}</div>
        </Card>
      )}

      {missing > 0 && (
        <Card T={T} style={{ background: T.redSoft, borderColor: T.redSoft }}>
          <div style={{ fontSize: 14, color: T.text, lineHeight: 1.5 }}>
            <b>{t(missing === 1 ? '1 key is not set' : `${missing} keys are not set`, `Не задано: ${missing}`)}</b>{' — '}
            {t(missing === 1
                 ? 'the parts of the bot that need it will not work until you fill it in.'
                 : 'the parts of the bot that need them will not work until you fill them in.',
               missing === 1
                 ? 'части бота, которым он нужен, не заработают, пока вы его не введёте.'
                 : 'части бота, которым они нужны, не заработают, пока вы их не введёте.')}
          </div>
        </Card>
      )}

      {rows.length === 0 && !loadError && (
        <Card T={T}>
          <div style={{ fontSize: 14, color: T.sub, lineHeight: 1.5 }}>
            {t('This bot does not need any keys of its own.',
               'Этому боту не нужны собственные ключи.')}
          </div>
        </Card>
      )}

      {rows.map(row => {
        const open = editing === row.key;
        const busy = busyKey === row.key;
        const err = rowError?.key === row.key ? rowError.message : null;
        return (
          <Card T={T} key={row.key}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{
                  fontFamily: T.mono, fontSize: 13.5, fontWeight: 700, color: T.text,
                  wordBreak: 'break-all', lineHeight: 1.35,
                }}>{row.key}</div>
                {row.description && (
                  <div style={{ fontSize: 13, color: T.sub, marginTop: 3, lineHeight: 1.45 }}>
                    {row.description}
                  </div>
                )}
              </div>
              <Pill T={T} tone={statusTone(row.status)}>
                {row.status === 'set' ? t('Set', 'Задан')
                  : row.status === 'missing' ? t('Missing', 'Не задан')
                  : t('Skipped', 'Пропущен')}
              </Pill>
            </div>

            {!open && (
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                <RowButton T={T} onClick={() => openEditor(row)} disabled={busy}>
                  {row.is_set ? t('Change', 'Изменить') : t('Set value', 'Ввести значение')}
                </RowButton>
                {row.is_set && (
                  <RowButton T={T} danger onClick={() => askDelete(row)} disabled={busy}>
                    {busy ? t('Working…', 'Выполняется…') : t('Delete', 'Удалить')}
                  </RowButton>
                )}
              </div>
            )}

            {open && (
              <div style={{ marginTop: 12 }}>
                <div style={{ position: 'relative' }}>
                  <input
                    autoFocus
                    // password so a shoulder-surfer or a screen recording
                    // doesn't catch the key as it's pasted.
                    type={reveal ? 'text' : 'password'}
                    value={draft}
                    onChange={e => { setDraft(e.target.value); setRowError(null); }}
                    placeholder={row.example || t('Paste the value', 'Вставьте значение')}
                    autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                    style={{
                      width: '100%', boxSizing: 'border-box',
                      padding: '12px 74px 12px 13px', borderRadius: 13,
                      border: `1px solid ${err ? DANGER : T.sep}`, background: T.inputBg,
                      color: T.text, font: `500 15px ${T.font}`, outline: 'none',
                    }} />
                  {/* Текстом, а не иконкой: глаза в наборе нет, а лупа читается
                      как поиск и сбивает с толку. */}
                  <button
                    type="button"
                    onClick={() => setReveal(v => !v)}
                    style={{
                      position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)',
                      background: 'none', border: 0, padding: '8px 10px', cursor: 'pointer',
                      color: T.hint, font: `600 13px ${T.font}`,
                    }}>
                    {reveal ? t('Hide', 'Скрыть') : t('Show', 'Показать')}
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  <RowButton T={T} primary onClick={() => askSave(row)} disabled={busy || !draft.trim()}>
                    {busy ? t('Saving…', 'Сохраняем…') : t('Save', 'Сохранить')}
                  </RowButton>
                  <RowButton T={T} onClick={closeEditor} disabled={busy}>
                    {t('Cancel', 'Отмена')}
                  </RowButton>
                </div>
              </div>
            )}

            {err && (
              <div style={{ marginTop: 9, fontSize: 13, color: DANGER, lineHeight: 1.45 }}>{err}</div>
            )}
          </Card>
        );
      })}

      {rows.length > 0 && (
        <div style={{ fontSize: 12.5, color: T.hint, lineHeight: 1.5, padding: '2px 4px' }}>
          {live
            ? t('Your bot is running, so a change here restarts it with the new settings.',
                'Бот сейчас работает, поэтому изменение перезапустит его с новыми настройками.')
            : t('Changes apply the next time the bot is built.',
                'Изменения применятся при следующей сборке бота.')}
        </div>
      )}

      <EnvConfirm T={T} pending={pending} live={live}
        onConfirm={() => { void runPending(); }} onCancel={() => setPending(null)} />
    </div>
  );
}

// EnvConfirm keeps the last non-null pending action while the sheet slides away,
// so the key name doesn't blank out mid-animation (same trick the bot-row swipe
// confirmation uses). The memory is a ref, not a module variable: at module
// scope it would outlive the screen and could flash a key from a different bot.
function EnvConfirm({ T, pending, live, onConfirm, onCancel }: {
  T: Theme; pending: Pending | null; live: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  const t = useT();
  const last = useRef<Pending | null>(null);
  if (pending) last.current = pending;
  const p = pending ?? last.current;
  if (!p) return null;

  const del = p.kind === 'delete';
  const replacing = !del && p.row.is_set;

  // The body says what actually happens, including the restart. A confirmation
  // that hides the consequence is worse than none.
  const effect = live
    ? t(' Your bot will restart with the new settings.', ' Бот перезапустится с новыми настройками.')
    : t(' It will apply at the next build.', ' Применится при следующей сборке.');

  const body = del
    ? t(`The stored value for ${p.row.key} is erased and cannot be recovered. Parts of the bot that use it will stop working.`,
        `Сохранённое значение ${p.row.key} будет стёрто без возможности восстановить. Части бота, которые его используют, перестанут работать.`) + effect
    : replacing
      ? t(`The current value of ${p.row.key} is replaced and cannot be recovered.`,
          `Текущее значение ${p.row.key} будет заменено без возможности восстановить.`) + effect
      : t(`${p.row.key} will be saved, encrypted.`, `${p.row.key} будет сохранён в зашифрованном виде.`) + effect;

  return (
    <ConfirmSheet
      T={T} open={!!pending}
      destructive={del || replacing}
      icon={del ? 'trash' : 'lock'}
      title={del
        ? t('Delete this value?', 'Удалить значение?')
        : replacing
          ? t('Replace this value?', 'Заменить значение?')
          : t('Save this value?', 'Сохранить значение?')}
      body={body}
      confirmLabel={del ? t('Delete', 'Удалить') : t('Save', 'Сохранить')}
      cancelLabel={t('Cancel', 'Отмена')}
      onConfirm={onConfirm}
      onCancel={onCancel} />
  );
}

function RowButton({ T, children, onClick, disabled, danger, primary }: {
  T: Theme; children: ReactNode; onClick: () => void;
  disabled?: boolean; danger?: boolean; primary?: boolean;
}) {
  const color = danger ? DANGER : primary ? T.accentText : T.text;
  const bg = primary ? T.accent : T.nestedBg;
  const border = danger ? T.redSoft : primary ? 'transparent' : T.sep;
  return (
    <button
      type="button" onClick={onClick} disabled={disabled}
      style={{
        padding: '9px 15px', borderRadius: 999, border: `1px solid ${border}`,
        background: bg, color, font: `600 14px ${T.font}`,
        opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer',
      }}>
      {children}
    </button>
  );
}
