import { Descriptions, Drawer, Space, Tag, Typography } from 'antd';
import { formatDateTime, type RouterOutputs } from '../../lib/format';

export type MaterialRow = RouterOutputs['materials']['list']['rows'][number];

export const StatusTag = ({ inSap }: { inSap: boolean }) => (
  <Tag color={inSap ? 'green' : 'default'} style={{ marginInlineEnd: 0 }}>
    {inSap ? 'Active' : 'Not in SAP'}
  </Tag>
);

const withCode = (name: string, code: string) => (name && code ? `${name} (${code})` : name || code || '—');
const orDash = (v: string) => v || '—';

/** Read-only details of one material (spec 01). */
export function MaterialDrawer({ material, onClose }: { material: MaterialRow | null; onClose: () => void }) {
  const m = material;
  return (
    <Drawer open={!!m} onClose={onClose} width={420} title={m ? `${m.MaterialCode} · ${m.Description}` : ''}>
      {m && (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Descriptions
            title="Classification"
            column={1}
            size="small"
            bordered
            items={[
              { label: 'Major category', children: withCode(m.MajorCategory, m.MajorCategoryCode) },
              { label: 'Sub-major category', children: orDash(m.SubMajorCategory) },
              { label: 'Material group', children: withCode(m.MaterialGroup, m.MaterialGroupCode) },
              { label: 'Material class', children: withCode(m.MaterialClass, m.MaterialClassCode) },
              { label: 'Material type', children: orDash(m.MaterialType) },
            ]}
          />
          <Descriptions
            title="General"
            column={1}
            size="small"
            bordered
            items={[
              { label: 'Material', children: m.MaterialCode },
              { label: 'Description', children: m.Description },
              { label: 'Base UoM', children: withCode(m.BaseUnitName, m.BaseUnit) },
              { label: 'Weight', children: m.Weight == null ? '—' : `${m.Weight.toFixed(3)} ${m.WeightUnit}` },
              { label: 'Status', children: <StatusTag inSap={m.InSap} /> },
            ]}
          />
          <Descriptions
            title="Produce attributes"
            column={1}
            size="small"
            bordered
            items={[
              { label: 'Origin', children: orDash(m.Origin) },
              { label: 'Variety', children: orDash(m.Variety) },
              { label: 'Size', children: orDash(m.Size) },
            ]}
          />
          <Typography.Text type="secondary">Last changed by a sync: {formatDateTime(m.SapChangedAt)}</Typography.Text>
        </Space>
      )}
    </Drawer>
  );
}
