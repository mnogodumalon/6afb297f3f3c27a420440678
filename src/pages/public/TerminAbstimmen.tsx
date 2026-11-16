import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { PublicShell } from '@/components/PublicShell';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/blocks/Field';
import { FieldErrorSummary } from '@/components/blocks/FieldErrorSummary';
import { LoadProblem } from '@/components/blocks/LoadProblem';
import {
  loadPublicPagesConfig, prepareChallenge, PageUnavailableError,
  doorsFromHash, withDoors, getPublicRecord,
  type PublicPagesConfig, type PublicPageConfig,
} from '@/lib/publicClient';
import { createPublicPort } from '@/lib/journey/publicPort';
import {
  useStepForm, useJourneySubmit, useLiveList, submissionsOf, topOne,
  fieldRef, fieldLookup, fieldText, fieldDate,
  type JourneyRecord, type JourneyPort, type PlanStep,
} from '@/lib/journey';
import { tx, dateFnsLocale } from '@/i18n';

const SLUG = 'termin-abstimmen';

const CHOICES = [
  { key: 'ja', mark: '✓' },
  { key: 'vielleicht', mark: '?' },
  { key: 'nein', mark: '✗' },
] as const;

function readUmfrageId(): string | null {
  const q = window.location.hash.split('?')[1] ?? '';
  const id = new URLSearchParams(q).get('umfrage');
  return id && /^[a-f0-9]{24}$/i.test(id) ? id : null;
}

function parseDate(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export default function TerminAbstimmen() {
  const [cfg, setCfg] = useState<PublicPagesConfig | null>(null);
  const [page, setPage] = useState<PublicPageConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [dead, setDead] = useState(false);
  const umfrageId = useMemo(() => readUmfrageId(), []);

  useEffect(() => {
    loadPublicPagesConfig(SLUG)
      .then(c => {
        setCfg(c);
        setPage(c?.pages[SLUG] ?? null);
        setLoading(false);
      })
      .catch(e => {
        if (e instanceof PageUnavailableError) setDead(true);
        setLoading(false);
      });
  }, []);

  if (loading || !cfg || !page) {
    return <PublicShell loading={loading} unavailable={!loading} />;
  }
  if (dead) return <PublicShell unavailable />;

  return (
    <PublicShell title={page.title} description={page.description} wide>
      {!umfrageId ? (
        <p className="text-sm text-muted-foreground">
          {tx('Dieser Link gehört zu keiner Umfrage. Bitte öffne den Link oder QR-Code, den du erhalten hast.')}
        </p>
      ) : (
        <Poll cfg={cfg} page={page} umfrageId={umfrageId} />
      )}
    </PublicShell>
  );
}

function Poll({ cfg, page: basePage, umfrageId }: { cfg: PublicPagesConfig; page: PublicPageConfig; umfrageId: string }) {
  const doors = useMemo(() => doorsFromHash(basePage), [basePage]);
  const page = useMemo(() => (doors ? withDoors(basePage, doors) : basePage), [basePage, doors]);
  const port: JourneyPort = useMemo(() => createPublicPort(cfg, page), [cfg, page]);
  const [umfrage, setUmfrage] = useState<JourneyRecord | null>(null);
  const [umfrageState, setUmfrageState] = useState<'loading' | 'ok' | 'dead' | 'error'>('loading');
  const [tries, setTries] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [missingAnswers, setMissingAnswers] = useState(false);

  useEffect(() => {
    let alive = true;
    setUmfrageState('loading');
    const spec = basePage.door_per_record;
    if (!spec || !doors) {
      setUmfrageState('dead');
      return () => { alive = false; };
    }
    getPublicRecord(cfg, page, spec.app_id, umfrageId)
      .then(r => {
        if (!alive) return;
        setUmfrage({ id: r.id ?? umfrageId, fields: (r.fields ?? {}) as Record<string, unknown>, createdAt: r.created_at ?? null } as JourneyRecord);
        setUmfrageState('ok');
      })
      .catch(e => {
        if (!alive) return;
        setUmfrageState(e instanceof PageUnavailableError ? 'dead' : 'error');
      });
    return () => { alive = false; };
  }, [cfg, page, basePage, doors, umfrageId, tries]);

  const termineLive = useLiveList(port, 'terminvorschlaege', { intervalMs: 30_000, list: { limit: 500 } });
  const antwortenLive = useLiveList(port, 'antworten', { intervalMs: 30_000, list: { limit: 500 } });

  const termine = useMemo(
    () => termineLive.records
      .filter(r => fieldRef(r, 'umfrage') === umfrageId)
      .sort((a, b) => (fieldDate(a, 'beginn') ?? '').localeCompare(fieldDate(b, 'beginn') ?? '')),
    [termineLive.records, umfrageId],
  );
  const antworten = useMemo(
    () => antwortenLive.records.filter(r => fieldRef(r, 'umfrage') === umfrageId),
    [antwortenLive.records, umfrageId],
  );
  const rows = useMemo(
    () => submissionsOf(antworten, { names: ['teilnehmer_firstname', 'teilnehmer_lastname'] }),
    [antworten],
  );

  const counts = useMemo(() => {
    const m: Record<string, { ja: number; vielleicht: number }> = {};
    for (const t of termine) m[t.id] = { ja: 0, vielleicht: 0 };
    for (const r of antworten) {
      const tid = fieldRef(r, 'terminvorschlag');
      const k = fieldLookup(r, 'antwort')?.key;
      if (!tid || !m[tid]) continue;
      if (k === 'ja') m[tid].ja += 1;
      else if (k === 'vielleicht') m[tid].vielleicht += 1;
    }
    return m;
  }, [termine, antworten]);

  const closed = umfrage ? fieldLookup(umfrage, 'status')?.key === 'geschlossen' : false;
  const finalId = umfrage ? fieldRef(umfrage, 'finaler_termin') : null;
  const top = topOne(
    termine,
    [t => counts[t.id]?.ja ?? 0, t => counts[t.id]?.vielleicht ?? 0],
    t => fieldDate(t, 'beginn'),
  );
  const highlightId = closed ? finalId : top?.id ?? null;
  const finalTermin = closed && finalId ? termine.find(t => t.id === finalId) ?? null : null;

  const form = useStepForm('antworten', {
    fields: ['teilnehmer_firstname', 'teilnehmer_lastname'],
    autoComplete: true,
  });

  const plan: PlanStep[] = termine.map((t, i) => ({
    key: `antwort-${t.id}`,
    entity: 'antworten',
    form,
    primary: i === 0,
    values: () => ({ terminvorschlag: t.id, antwort: answers[t.id] }),
  }));

  const submit = useJourneySubmit(port, plan, {
    draftKey: `termin-abstimmen-${umfrageId}`,
    check: async () => {
      const spec = basePage.door_per_record;
      if (!spec) return null;
      const r = await getPublicRecord(cfg, page, spec.app_id, umfrageId);
      const st = (r.fields as Record<string, unknown> | undefined)?.status;
      const key = st && typeof st === 'object' ? (st as { key?: string }).key : st;
      return key === 'geschlossen' ? tx('Die Umfrage ist inzwischen geschlossen.') : null;
    },
    onSuccess: () => { void antwortenLive.reload(); },
  });

  const warm = () => {
    const ep = page.endpoints?.find(e => e.op === 'create');
    if (ep) prepareChallenge(cfg, page, 'POST', `/apps/${ep.app_id}/records`);
  };

  const send = async () => {
    const nameOk = form.validate();
    const allAnswered = termine.every(t => !!answers[t.id]);
    setMissingAnswers(!allAnswered);
    if (!nameOk || !allAnswered) return;
    await submit.run();
  };

  const again = () => {
    submit.reset();
    form.reset();
    setAnswers({});
    setMissingAnswers(false);
  };

  if (umfrageState === 'dead') {
    return (
      <p className="text-sm text-muted-foreground">
        {tx('Dieser Link ist nicht mehr gültig. Bitte den aktuellen Link oder QR-Code verwenden.')}
      </p>
    );
  }
  if (umfrageState === 'error' || (!termineLive.loaded && termineLive.error) || (!antwortenLive.loaded && antwortenLive.error)) {
    if (termineLive.error instanceof PageUnavailableError || antwortenLive.error instanceof PageUnavailableError) {
      return (
        <p className="text-sm text-muted-foreground">
          {tx('Dieser Link ist nicht mehr gültig. Bitte den aktuellen Link oder QR-Code verwenden.')}
        </p>
      );
    }
    return (
      <LoadProblem
        onRetry={() => {
          setTries(n => n + 1);
          void termineLive.reload();
          void antwortenLive.reload();
        }}
      />
    );
  }
  if (umfrageState === 'loading' || !termineLive.loaded || !antwortenLive.loaded || !umfrage) {
    return <p className="text-sm text-muted-foreground">{tx('Lädt …')}</p>;
  }

  const ort = fieldText(umfrage, 'ort');
  const beschreibung = fieldText(umfrage, 'beschreibung');

  const dateHead = (t: JourneyRecord) => {
    const s = parseDate(fieldDate(t, 'beginn'));
    const e = parseDate(fieldDate(t, 'ende'));
    if (!s) return { day: fieldText(t, 'beginn'), time: '' };
    const sameDay = e && format(e, 'yyyy-MM-dd') === format(s, 'yyyy-MM-dd');
    return {
      day: format(s, 'EEE dd.MM.', { locale: dateFnsLocale() }),
      time: e ? (sameDay ? `${format(s, 'HH:mm')}–${format(e, 'HH:mm')}` : `${format(s, 'HH:mm')} …`) : format(s, 'HH:mm'),
    };
  };

  const cellMark = (r: JourneyRecord | undefined) => {
    const k = r ? fieldLookup(r, 'antwort')?.key : null;
    if (k === 'ja') return <span className="font-semibold text-emerald-600" aria-label={tx('Ja')}>✓</span>;
    if (k === 'vielleicht') return <span className="font-semibold text-amber-600" aria-label={tx('Vielleicht')}>?</span>;
    if (k === 'nein') return <span className="text-rose-500" aria-label={tx('Nein')}>✗</span>;
    return <span className="text-muted-foreground" aria-label={tx('Keine Antwort')}>–</span>;
  };

  const choiceLabel = (k: string) => (k === 'ja' ? tx('Ja') : k === 'vielleicht' ? tx('Vielleicht') : tx('Nein'));
  const hl = (id: string) => (id === highlightId ? 'bg-emerald-50' : '');

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{fieldText(umfrage, 'titel')}</h2>
        {ort && <p className="text-sm text-muted-foreground">{ort}</p>}
        {beschreibung && <p className="text-sm whitespace-pre-line">{beschreibung}</p>}
      </div>

      {closed && (
        <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm">
          <p className="font-semibold">{tx('Die Umfrage ist geschlossen.')}</p>
          {finalTermin ? (
            <p>
              {tx('Finaler Termin:')}{' '}
              <span className="font-semibold">{dateHead(finalTermin).day} {dateHead(finalTermin).time}</span>
            </p>
          ) : (
            <p>{tx('Es wurde noch kein finaler Termin festgelegt.')}</p>
          )}
        </div>
      )}

      {termine.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tx('Für diese Umfrage gibt es noch keine Termine.')}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="min-w-[9rem] p-2 text-left font-medium">{tx('Teilnehmende')}</th>
                {termine.map(t => {
                  const h = dateHead(t);
                  return (
                    <th key={t.id} className={`min-w-[4.5rem] p-2 text-center font-medium ${hl(t.id)}`}>
                      <div>{h.day}</div>
                      <div className="text-xs font-normal text-muted-foreground">{h.time}</div>
                      {t.id === highlightId && (
                        <div className="mt-1 text-[11px] font-semibold text-emerald-700">
                          {closed ? tx('Final') : tx('Beliebteste')}
                        </div>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map(s => (
                <tr key={s.key} className="border-b">
                  <td className="p-2 font-medium">{s.label}</td>
                  {termine.map(t => (
                    <td key={t.id} className={`p-2 text-center ${hl(t.id)}`}>
                      {cellMark(s.records.find(r => fieldRef(r, 'terminvorschlag') === t.id))}
                    </td>
                  ))}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr className="border-b">
                  <td className="p-2 text-muted-foreground" colSpan={termine.length + 1}>
                    {tx('Noch niemand hat abgestimmt.')}
                  </td>
                </tr>
              )}
              <tr className="border-b bg-muted/30 text-xs">
                <td className="p-2 font-medium">{tx('Summe')}</td>
                {termine.map(t => (
                  <td key={t.id} className={`p-2 text-center ${hl(t.id)}`}>
                    <div className="font-semibold text-emerald-700">{tx`${counts[t.id]?.ja ?? 0} Ja`}</div>
                    <div className="text-amber-700">{tx`${counts[t.id]?.vielleicht ?? 0} Vielleicht`}</div>
                  </td>
                ))}
              </tr>
              {!closed && !submit.result && (
                <tr className="align-top">
                  <td className="space-y-2 p-2">
                    <Field form={form} name="teilnehmer_firstname" label={tx('Vorname')} hideLabel>
                      <Input
                        {...form.field('teilnehmer_firstname')}
                        placeholder={tx('Vorname')}
                        className="min-h-11"
                        onFocus={warm}
                      />
                    </Field>
                    <Field form={form} name="teilnehmer_lastname" label={tx('Nachname')} hideLabel>
                      <Input
                        {...form.field('teilnehmer_lastname')}
                        placeholder={tx('Nachname')}
                        className="min-h-11"
                      />
                    </Field>
                  </td>
                  {termine.map(t => (
                    <td key={t.id} className={`p-1 ${hl(t.id)}`}>
                      <div role="radiogroup" aria-label={dateHead(t).day} className="flex flex-col gap-1">
                        {CHOICES.map(c => {
                          const on = answers[t.id] === c.key;
                          return (
                            <button
                              key={c.key}
                              type="button"
                              role="radio"
                              aria-checked={on}
                              aria-label={choiceLabel(c.key)}
                              className="min-h-11 min-w-11 rounded-lg border bg-background px-1 text-xs font-medium hover:bg-muted data-[on=y]:text-white data-[on=y]:data-[choice=ja]:border-emerald-600 data-[on=y]:data-[choice=ja]:bg-emerald-600 data-[on=y]:data-[choice=vielleicht]:border-amber-500 data-[on=y]:data-[choice=vielleicht]:bg-amber-500 data-[on=y]:data-[choice=nein]:border-rose-500 data-[on=y]:data-[choice=nein]:bg-rose-500"
                              data-choice={c.key}
                              data-on={on ? 'y' : 'n'}
                              onClick={() => { warm(); setAnswers(a => ({ ...a, [t.id]: c.key })); }}
                            >
                              {c.mark} {choiceLabel(c.key)}
                            </button>
                          );
                        })}
                      </div>
                    </td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {!closed && !submit.result && termine.length > 0 && (
        <div className="space-y-3">
          <FieldErrorSummary forms={[form]} />
          {missingAnswers && (
            <p className="text-sm text-destructive">{tx('Bitte wähle bei jedem Termin Ja, Vielleicht oder Nein.')}</p>
          )}
          {submit.offline && (
            <p className="text-sm text-muted-foreground">{tx('Keine Verbindung — deine Eingaben sind gesichert.')}</p>
          )}
          {submit.limited && (
            <p className="text-sm text-muted-foreground">{tx('Gerade viele Teilnehmende — wir senden gleich noch einmal.')}</p>
          )}
          {submit.error && !submit.offline && !submit.limited && (
            <p className="text-sm text-destructive">{submit.error.message}</p>
          )}
          <Button type="button" className="min-h-11 w-full sm:w-auto" disabled={submit.submitting} onClick={() => void send()}>
            {submit.submitting ? tx('Wird gespeichert …') : tx('Abstimmung speichern')}
          </Button>
        </div>
      )}

      {submit.result && !closed && (
        <div className="space-y-3 rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm">
          <p className="font-semibold">{tx('Danke, deine Antworten sind gespeichert.')}</p>
          <Button type="button" variant="outline" className="min-h-11" onClick={again}>
            {tx('Weitere Person eintragen')}
          </Button>
        </div>
      )}
    </div>
  );
}
