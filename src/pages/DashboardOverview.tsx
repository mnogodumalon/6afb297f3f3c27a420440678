import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { IconPlus, IconChecklist, IconMapPin, IconTrophy, IconLock } from '@tabler/icons-react';
import type { DashboardData } from '@/hooks/useDashboardData';
import { useEntityCrud } from '@/components/EntityCrud';
import { flowActionFor, countOf } from '@/config/plan';
import type { EnrichedUmfragen, EnrichedTerminvorschlaege, EnrichedAntworten } from '@/types/enriched';
import { extractRecordId } from '@/services/livingAppsService';
import { lookupKey } from '@/lib/formatters';
import { submissionsOf } from '@/lib/journey';
import { useClock, gruss, namen } from '@/lib/polish';
import { tx, appLabel, dateFnsLocale } from '@/i18n';
import { DashboardGrid } from '@/components/DashboardGrid';
import { StatStrip, StatStripItem } from '@/components/StatCard';
import { WorkList } from '@/components/WorkList';
import { Button } from '@/components/ui/button';
import { RecordDoorLink } from '@/components/widgets/RecordDoorLink';

type Filter = 'all' | 'offen' | 'ohneFinal';

export default function DashboardOverview({ data }: { data: DashboardData }) {
  const crud = useEntityCrud(data, {
    footer: (top) => {
      if (top.type !== 'umfragen') return undefined;
      const go = lookupKey(top.record.fields.status) === 'offen'
        ? flowActionFor('umfragen', 'status', top.record.record_id, 'geschlossen')
        : null;
      return go ? { label: tx('Umfrage abschließen'), onClick: go } : undefined;
    },
  });
  const umfragen: EnrichedUmfragen[] = crud.enriched.umfragen;
  const termine: EnrichedTerminvorschlaege[] = crud.enriched.terminvorschlaege;
  const antworten: EnrichedAntworten[] = crud.enriched.antworten;
  const clock = useClock();
  const [filter, setFilter] = useState<Filter>('all');

  const locale = dateFnsLocale();
  const fmt = (s?: string) => {
    if (!s) return '—';
    const d = new Date(s);
    return isNaN(d.getTime()) ? s : format(d, 'EEE dd.MM. HH:mm', { locale });
  };

  const rows = useMemo(() => umfragen.map(u => {
    const ts = termine
      .filter(t => extractRecordId(t.fields.umfrage) === u.record_id)
      .sort((a, b) => (a.fields.beginn ?? '').localeCompare(b.fields.beginn ?? ''));
    const as = antworten.filter(a => extractRecordId(a.fields.umfrage) === u.record_id);
    const teilnehmende = submissionsOf(as, { names: ['teilnehmer_firstname', 'teilnehmer_lastname'] }).length;
    const perTermin = ts.map(t => {
      const mine = as.filter(a => extractRecordId(a.fields.terminvorschlag) === t.record_id);
      return {
        termin: t,
        ja: mine.filter(a => lookupKey(a.fields.antwort) === 'ja').length,
        vielleicht: mine.filter(a => lookupKey(a.fields.antwort) === 'vielleicht').length,
      };
    });
    const maxJa = Math.max(0, ...perTermin.map(p => p.ja));
    const best = maxJa > 0 ? perTermin.find(p => p.ja === maxJa) : undefined;
    const finalId = extractRecordId(u.fields.finaler_termin);
    const isOpen = lookupKey(u.fields.status) !== 'geschlossen';
    return { u, perTermin, maxJa, best, finalId, isOpen, teilnehmende };
  }), [umfragen, termine, antworten]);

  const offene = rows.filter(r => r.isOpen);
  const ohneFinal = offene.filter(r => !r.finalId);
  const visible = rows.filter(r => filter === 'offen' ? r.isOpen : filter === 'ohneFinal' ? (r.isOpen && !r.finalId) : true);

  const titles = offene.map(r => r.u.fields.titel ?? '').filter(Boolean);
  const context = offene.length > 0
    ? tx`${namen(titles, 3)} — hier läuft gerade die Abstimmung.`
    : tx('Aktuell läuft keine offene Umfrage.');

  const closeAction = (r: typeof rows[number]) => {
    const go = flowActionFor('umfragen', 'status', r.u.record_id, 'geschlossen');
    return go ? { label: tx('Abschließen'), onClick: go } : undefined;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{gruss(clock)}</h1>
          <p className="text-sm text-muted-foreground">{context}</p>
        </div>
        {crud.umfragen.canWrite && (
          <Button onClick={() => crud.umfragen.openCreate({ status: 'offen' })} className="w-full sm:w-auto">
            <IconPlus size={16} className="shrink-0" /> {tx('Neue Umfrage')}
          </Button>
        )}
      </div>

      <DashboardGrid
        variant="split"
        kpis={rows.length > 0 ? (
          <StatStrip>
            <StatStripItem
              title={tx('Offene Umfragen')}
              value={offene.length}
              icon={<IconChecklist size={16} className="text-muted-foreground" />}
              onClick={() => setFilter(f => f === 'offen' ? 'all' : 'offen')}
              active={filter === 'offen'}
            />
            <StatStripItem
              title={tx('Ohne finalen Termin')}
              value={ohneFinal.length}
              tone={ohneFinal.length > 0 ? 'warning' : 'default'}
              icon={<IconTrophy size={16} className="text-muted-foreground" />}
              onClick={() => setFilter(f => f === 'ohneFinal' ? 'all' : 'ohneFinal')}
              active={filter === 'ohneFinal'}
            />
          </StatStrip>
        ) : undefined}
        aside={
          <WorkList
            title={tx('Entscheidung offen')}
            items={ohneFinal.map(r => ({
              id: r.u.record_id,
              title: r.u.fields.titel ?? '—',
              secondLine: (
                <span className="text-muted-foreground">
                  {r.best
                    ? tx`Vorne: ${fmt(r.best.termin.fields.beginn)} (${r.maxJa} Ja)`
                    : tx('Noch keine Ja-Stimmen')}
                </span>
              ),
              action: (() => {
                const go = r.best ? flowActionFor('umfragen', 'finaler_termin', r.u.record_id, r.best.termin.record_id) : null;
                return go ? { label: tx('Termin festlegen'), onClick: go } : undefined;
              })(),
            }))}
            onItemClick={id => {
              const rec = umfragen.find(u => u.record_id === id);
              if (rec) crud.umfragen.openDetail(rec);
            }}
            empty={{
              text: tx('Alle offenen Umfragen haben einen finalen Termin.'),
              action: crud.umfragen.canWrite ? { label: tx('Neue Umfrage'), onClick: () => crud.umfragen.openCreate({ status: 'offen' }) } : undefined,
            }}
          />
        }
        primary={
          rows.length === 0 ? (
            <div className="rounded-2xl border bg-card p-8 text-center space-y-3 overflow-hidden">
              <IconChecklist size={48} className="mx-auto text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{tx('Lege deine erste Umfrage mit mehreren Terminvorschlägen an.')}</p>
              {crud.umfragen.canWrite && (
                <Button onClick={() => crud.umfragen.openCreate({ status: 'offen' })}>{tx('Erste Umfrage anlegen')}</Button>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {visible.length === 0 && (
                <div className="rounded-2xl border bg-card p-6 text-sm text-muted-foreground">{tx('Keine Umfrage in dieser Ansicht.')}</div>
              )}
              {visible.map(r => {
                const close = r.isOpen ? closeAction(r) : undefined;
                return (
                  <div key={r.u.record_id} className="rounded-2xl border bg-card p-4 space-y-3 overflow-hidden">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <button
                          type="button"
                          className="text-left font-semibold hover:underline break-words"
                          onClick={() => crud.umfragen.openDetail(r.u)}
                        >
                          {r.u.fields.titel ?? '—'}
                        </button>
                        <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                          {r.u.fields.ort && (
                            <span className="inline-flex items-center gap-1 min-w-0"><IconMapPin size={12} className="shrink-0" />{r.u.fields.ort}</span>
                          )}
                          <span>{countOf('antworten', r.teilnehmende, appLabel('antworten'))}</span>
                        </div>
                      </div>
                      <span className={r.isOpen ? 'text-xs font-medium text-emerald-600' : 'inline-flex items-center gap-1 text-xs font-medium text-muted-foreground'}>
                        {!r.isOpen && <IconLock size={12} />}
                        {r.isOpen ? tx('Offen') : tx('Geschlossen')}
                      </span>
                    </div>

                    <ul className="space-y-1.5">
                      {r.perTermin.length === 0 && (
                        <li className="text-xs text-muted-foreground">{tx('Noch keine Terminvorschläge.')}</li>
                      )}
                      {r.perTermin.map(p => {
                        const isFinal = p.termin.record_id === r.finalId;
                        const isBest = !isFinal && r.maxJa > 0 && p.ja === r.maxJa;
                        const width = r.teilnehmende > 0 ? Math.round((p.ja / r.teilnehmende) * 100) : 0;
                        return (
                          <li key={p.termin.record_id} className="relative rounded-lg bg-muted/40 px-3 py-2 text-sm overflow-hidden">
                            <div className="absolute inset-y-0 left-0 bg-emerald-500/15" style={{ width: `${width}%` }} />
                            <div className="relative flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                              <span className={isBest || isFinal ? 'font-semibold' : ''}>
                                {fmt(p.termin.fields.beginn)} – {fmt(p.termin.fields.ende)}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {isFinal && <b className="mr-2 text-primary">{tx('Finaler Termin')}</b>}
                                {isBest && <b className="mr-2 text-emerald-600">{tx('Meiste Ja')}</b>}
                                {tx`${p.ja} Ja · ${p.vielleicht} Vielleicht`}
                              </span>
                            </div>
                          </li>
                        );
                      })}
                    </ul>

                    <div className="flex flex-wrap items-center gap-2">
                      <RecordDoorLink page="termin-abstimmen" recordId={r.u.record_id} qr />
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {r.isOpen && r.best && !r.finalId && (() => {
                        const go = flowActionFor('umfragen', 'finaler_termin', r.u.record_id, r.best!.termin.record_id);
                        return go ? <Button size="sm" variant="outline" onClick={go}>{tx('Beliebtesten Termin festlegen')}</Button> : null;
                      })()}
                      {close && <Button size="sm" onClick={close.onClick}>{close.label}</Button>}
                      <Button size="sm" variant="ghost" onClick={() => crud.umfragen.openDetail(r.u)}>{tx('Details')}</Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )
        }
      />
      {crud.surfaces}
    </div>
  );
}
