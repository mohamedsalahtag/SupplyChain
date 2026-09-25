import { Button, InputNumber, Tag, Tooltip, Typography } from 'antd';
import type { RouterOutputs } from '../../lib/format';
import { mondayText } from '../../lib/workflow';
import { n } from '../rfq/rfqLabels';

export type Grid = RouterOutputs['award']['grid'];
export type Group = Grid['weeks'][number]['groups'][number];
/** Per container group: the supplier each open (and added) container goes to, null = not awarded. */
export type Picks = Record<string, (string | null)[]>;

export const SUPPLIER_COLORS = [
  ['#1677ff', '#e6f4ff'], ['#722ed1', '#f9f0ff'], ['#13a8a8', '#e6fffb'], ['#fa8c16', '#fff7e6'], ['#eb2f96', '#fff0f6'], ['#52c41a', '#f6ffed'], ['#2f54eb', '#f0f5ff'], ['#a0d911', '#fcffe6'],
];
export const colorOf = (grid: Grid, code: string) => SUPPLIER_COLORS[grid.suppliers.findIndex((s) => s.code === code) % SUPPLIER_COLORS.length];
export const priced = (g: Group, code: string) => (g.prices[code] ?? []).every((p) => p !== null);
/** Value of one container for a supplier (Σ quantity per container × price per unit). */
export const containerValue = (g: Group, code: string) => g.items.reduce((s, it, i) => s + Number(it.perContainer) * Number(g.prices[code]?.[i] ?? 0), 0);
export const countIn = (picks: Picks, groupId: string, code: string | null) => (picks[groupId] ?? []).filter((x) => x === code).length;

const CSS = `
.aw-box { max-height: calc(100vh - 260px); min-height: 320px; overflow: auto; user-select: none; border: 1px solid #f0f0f0; border-radius: 8px; background: #fff; }
.aw-t { border-collapse: separate; border-spacing: 0; width: 100%; }
.aw-t th, .aw-t td { padding: 6px 10px; border-bottom: 1px solid #f0f0f0; background: #fff; text-align: left; vertical-align: top; }
.aw-t thead th { position: sticky; top: 0; z-index: 3; background: #fafafa; border-bottom: 2px solid #d9d9d9; vertical-align: bottom; }
.aw-t tfoot td { position: sticky; bottom: 0; z-index: 3; background: #fafafa; border-top: 2px solid #d9d9d9; font-weight: 600; }
.aw-t .aw-first { position: sticky; left: 0; z-index: 2; min-width: 300px; max-width: 360px; border-right: 1px solid #f0f0f0; }
.aw-t thead .aw-first, .aw-t tfoot .aw-first { z-index: 4; }
.aw-t th.aw-sup { text-align: center; min-width: 190px; cursor: pointer; }
.aw-t th.aw-sup:hover { background: #f0f0f0; }
.aw-t tr.aw-week td { background: #f5f5f5; border-top: 2px solid #d9d9d9; }
.aw-c { text-align: center !important; }
.aw-strip { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 6px; max-width: 330px; }
.aw-sq { width: 18px; height: 18px; border-radius: 3px; background: #d9d9d9; cursor: pointer; position: relative; }
.aw-sq:hover { outline: 2px solid var(--aw-brush, #595959); outline-offset: 1px; }
.aw-sq.aw-x { outline: 2px solid #d48806; outline-offset: 1px; }
.aw-sq.aw-add::after { content: '+'; position: absolute; inset: 0; color: #fff; font-size: 11px; font-weight: 700; text-align: center; line-height: 18px; }
.aw-prices { font-size: 12px; line-height: 1.5; color: #595959; }
`;

type Props = {
  grid: Grid; picks: Picks; added: Record<string, number>; brush: string | null;
  onBrush: (code: string | null) => void;
  onPaint: (groupId: string, index: number, start: boolean) => void;
  onCount: (groupId: string, code: string, count: number) => void;
  onWeek: (week: string, code: string | null) => void;
  onAdd: (groupId: string) => void; onRemoveAdded: (groupId: string) => void;
};

/** The award grid (spec 20 revision 1): suppliers as columns; per week, one row per container group. */
export function AwardGrid({ grid, picks, added, brush, onBrush, onPaint, onCount, onWeek, onAdd, onRemoveAdded }: Props) {
  const all = Object.values(picks).flat();
  // n-th container of a supplier in a week (earlier batches first) above its offer → amber outline
  const overFlags = (w: Grid['weeks'][number]) => {
    const seen: Record<string, number> = { ...w.awardedBefore };
    return Object.fromEntries(w.groups.map((g) => [g.groupId, (picks[g.groupId] ?? []).map((s) => {
      if (!s) return false;
      seen[s] = (seen[s] ?? 0) + 1;
      return seen[s] > (w.offered[s] ?? 0);
    })]));
  };
  const lowest = (g: Group, i: number) => Math.min(...grid.suppliers.map((s) => g.prices[s.code]?.[i]).filter((p): p is string => p !== null && p !== undefined).map(Number));
  const brushColor = brush ? colorOf(grid, brush)[0] : '#8c8c8c';

  return (
    <div className="aw-box" style={{ ['--aw-brush' as string]: brushColor }}>
      <style>{CSS}</style>
      <table className="aw-t">
        <thead>
          <tr>
            <th className="aw-first">Week · container group</th>
            {grid.suppliers.map((s) => {
              const [c, bg] = colorOf(grid, s.code);
              const on = brush === s.code;
              const count = all.filter((x) => x === s.code).length;
              return (
                <th key={s.code} className="aw-sup" style={{ borderTop: `4px solid ${c}`, background: on ? bg : undefined, boxShadow: on ? `inset 0 -3px 0 ${c}` : undefined }}
                  onClick={() => onBrush(s.code)} title={`Click: squares go to ${s.name}`}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'center' }}><span style={{ width: 12, height: 12, borderRadius: 3, background: c }} />{s.name}</div>
                  <div style={{ fontWeight: 400, fontSize: 12, color: '#595959' }}>{count} container{count === 1 ? '' : 's'} · price per unit, {s.currency}</div>
                  {on && <div style={{ fontWeight: 400, fontSize: 11, color: c }}>squares go here</div>}
                </th>
              );
            })}
            <th className="aw-c" style={{ minWidth: 110 }}>Not awarded<div style={{ fontWeight: 400, fontSize: 12, color: '#595959' }}>{all.filter((x) => !x).length} stay Quoted</div></th>
          </tr>
        </thead>
        <tbody>
          {grid.weeks.map((w) => {
            const flags = overFlags(w);
            const containers = w.groups.reduce((t, g) => t + (picks[g.groupId]?.length ?? 0) + g.awarded, 0);
            return [
              <tr key={w.week} className="aw-week">
                <td className="aw-first"><Typography.Text strong style={{ fontSize: 14 }}>{w.week}</Typography.Text> <Typography.Text type="secondary" style={{ fontSize: 12 }}>{mondayText(w.week)} · {containers} containers</Typography.Text></td>
                {grid.suppliers.map((s) => {
                  const mine = w.groups.reduce((t, g) => t + countIn(picks, g.groupId, s.code), 0) + (w.awardedBefore[s.code] ?? 0);
                  const over = mine - (w.offered[s.code] ?? 0);
                  return (
                    <td key={s.code} className="aw-c" style={{ fontSize: 12 }}>
                      {mine} of {w.offered[s.code] ?? 0} offered {over > 0 && <Tag color="gold" style={{ marginInlineEnd: 0 }}>+{over}</Tag>}{' '}
                      <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={() => onWeek(w.week, s.code)}>whole week</Button>
                    </td>
                  );
                })}
                <td className="aw-c"><Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={() => onWeek(w.week, null)}>clear</Button></td>
              </tr>,
              ...w.groups.map((g) => {
                const rows = picks[g.groupId] ?? [];
                const extra = added[g.groupId] ?? 0;
                return (
                  <tr key={g.groupId}>
                    <td className="aw-first">
                      <Typography.Text strong>{g.name}</Typography.Text>{' '}
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        · {g.containerCount + extra} × {n(g.capacity)} {g.unit}{g.awarded ? ` · ${g.awarded} already awarded` : ''}
                        {extra > 0 && <> · <span style={{ color: '#1f6f43' }}>{extra} added</span> <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={() => onRemoveAdded(g.groupId)}>undo</Button></>}
                      </Typography.Text>
                      <div style={{ fontSize: 12, color: '#595959' }}>{g.items.map((i) => `${i.label} ${n(i.perContainer)}`).join(' · ')} {g.unit} per container</div>
                      {g.blocker ? <Tag color="gold" style={{ marginTop: 6 }}>{g.blocker}</Tag> : (
                        <>
                          <div className="aw-strip">
                            {rows.map((s, i) => (
                              <Tooltip key={i} title={`Container ${i + 1} of ${rows.length}${i >= rows.length - extra ? ' (added)' : ''}: ${s ? grid.suppliers.find((x) => x.code === s)?.name : 'not awarded'}`} mouseEnterDelay={0.6}>
                                <span className={`aw-sq ${flags[g.groupId]?.[i] ? 'aw-x' : ''} ${i >= rows.length - extra ? 'aw-add' : ''}`} aria-label={`Container ${g.name} ${w.week} ${i + 1}`}
                                  style={s ? { background: colorOf(grid, s)[0] } : undefined}
                                  onMouseDown={(e) => { e.preventDefault(); onPaint(g.groupId, i, true); }} onMouseEnter={() => onPaint(g.groupId, i, false)} />
                              </Tooltip>
                            ))}
                            {!rows.length && <Typography.Text type="secondary" style={{ fontSize: 12 }}>all containers awarded</Typography.Text>}
                          </div>
                          <Button type="link" size="small" style={{ padding: 0, marginTop: 4 }} onClick={() => onAdd(g.groupId)} aria-label={`Add container ${g.name} ${w.week}`}>+ Add container</Button>
                        </>
                      )}
                    </td>
                    {grid.suppliers.map((s) => {
                      if (!priced(g, s.code)) {
                        const missing = g.items.filter((_, i) => g.prices[s.code]?.[i] == null).map((i) => i.label);
                        return <td key={s.code} className="aw-c" style={{ color: '#bfbfbf', fontSize: 12 }}>— not priced<div>{missing.join(', ')}</div></td>;
                      }
                      const count = countIn(picks, g.groupId, s.code);
                      const [, bg] = colorOf(grid, s.code);
                      return (
                        <td key={s.code} className="aw-c" style={{ background: count ? bg : undefined }}>
                          <div className="aw-prices">{g.items.map((it, i) => {
                            const p = g.prices[s.code]![i]!;
                            const low = grid.suppliers.length > 1 && Number(p) === lowest(g, i);
                            return <div key={i}>{it.label.split(' ').slice(-2).join(' ')}: <b style={{ color: low ? '#1f6f43' : '#1f1f1f' }}>{p}</b></div>;
                          })}</div>
                          {!g.blocker && (
                            <div style={{ display: 'inline-flex', gap: 4, marginTop: 4 }}>
                              <Button size="small" disabled={!count} onClick={() => onCount(g.groupId, s.code, count - 1)}>−</Button>
                              <InputNumber size="small" min={0} max={rows.length} precision={0} value={count} style={{ width: 56 }} aria-label={`Containers ${s.name} ${g.name} ${w.week}`}
                                onChange={(v) => onCount(g.groupId, s.code, v ?? 0)} />
                              <Button size="small" disabled={!rows.some((x) => !x)} onClick={() => onCount(g.groupId, s.code, count + 1)}>+</Button>
                            </div>
                          )}
                        </td>
                      );
                    })}
                    <td className="aw-c" style={{ fontSize: 12 }}>{countIn(picks, g.groupId, null)}</td>
                  </tr>
                );
              }),
            ];
          })}
        </tbody>
        <tfoot>
          <tr>
            <td className="aw-first">Total</td>
            {grid.suppliers.map((s) => {
              const count = all.filter((x) => x === s.code).length;
              const value = grid.weeks.flatMap((w) => w.groups).reduce((t, g) => t + countIn(picks, g.groupId, s.code) * (priced(g, s.code) ? containerValue(g, s.code) : 0), 0);
              return <td key={s.code} className="aw-c">{count} container{count === 1 ? '' : 's'}<div style={{ fontWeight: 400, fontSize: 12 }}>{count ? `${value.toLocaleString('en-GB', { maximumFractionDigits: 2 })} ${s.currency}` : '—'}</div></td>;
            })}
            <td className="aw-c">{all.filter((x) => !x).length}<div style={{ fontWeight: 400, fontSize: 12 }}>Quoted</div></td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
