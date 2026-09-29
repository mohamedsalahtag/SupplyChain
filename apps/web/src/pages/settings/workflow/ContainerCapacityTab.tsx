import { useState } from 'react';
import { App, AutoComplete, Button, Form, InputNumber, Modal, Popconfirm, Select, Space, Switch, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { P } from '@supplychain/shared';
import { AppTable, type AppColumn } from '../../../components/AppTable';
import { useCan } from '../../../lib/auth';
import { formatDateTime, formatNumber, type RouterOutputs } from '../../../lib/format';
import { trpc } from '../../../lib/trpc';
import { errorText } from '../../../lib/workflow';
import { useTablePrefs } from '../../../lib/useTablePrefs';

type Row = RouterOutputs['workflowSetup']['capacities'][number];
/** "any" in a select; saved as NULL. */
const ANY = '__any__';
type FormValues = { majorCategory?: string; subMajorCategory: string; size: string; capacity?: number; unit: string; isActive: boolean };
const any = (v: string | null) => v ?? <Typography.Text type="secondary">any</Typography.Text>;

/**
 * Configuration → Container capacity (spec 32): the maximum payload per container per product. A new demand's
 * "Capacity per container" starts from it; the most specific row wins and a mixed container takes the smallest.
 */
export function ContainerCapacityTab() {
  const { message } = App.useApp();
  const can = useCan();
  const utils = trpc.useUtils();
  const prefs = useTablePrefs('wf-capacity');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const [form] = Form.useForm<FormValues>();
  const list = trpc.workflowSetup.capacities.useQuery();
  const choices = trpc.workflowSetup.capacityChoices.useQuery(undefined, { enabled: !!editing, staleTime: 5 * 60_000 });
  const save = trpc.workflowSetup.saveCapacity.useMutation();
  const setActive = trpc.workflowSetup.setCapacityActive.useMutation();
  const remove = trpc.workflowSetup.deleteCapacity.useMutation();
  const editable = can(P.configCapacityEdit);

  const major = Form.useWatch('majorCategory', form);
  const sub = Form.useWatch('subMajorCategory', form);
  const sizes = trpc.workflowSetup.capacitySizes.useQuery(
    { majorCategory: major ?? '', subMajorCategory: sub ?? '' },
    { enabled: !!editing && !!major && !!sub && sub !== ANY, staleTime: 5 * 60_000 },
  );

  const current = editing && editing !== 'new' ? editing : null;
  const initial = (r: Row | 'new' | null): FormValues => (!r || r === 'new'
    ? { majorCategory: undefined, subMajorCategory: ANY, size: ANY, capacity: undefined, unit: '', isActive: true }
    : { majorCategory: r.MajorCategory, subMajorCategory: r.SubMajorCategory ?? ANY, size: r.Size ?? ANY, capacity: r.Capacity, unit: r.Unit, isActive: r.IsActive });
  const openModal = (r: Row | 'new') => { setEditing(r); form.resetFields(); form.setFieldsValue(initial(r)); };
  const refresh = () => utils.workflowSetup.capacities.invalidate();

  const onSave = async (v: FormValues) => {
    const subMajorCategory = v.subMajorCategory === ANY ? null : v.subMajorCategory;
    try {
      await save.mutateAsync({
        capacityId: current?.CapacityId ?? null, rowVer: current?.RowVer ?? null, majorCategory: v.majorCategory!, subMajorCategory,
        size: subMajorCategory === null || v.size === ANY ? null : v.size, capacity: v.capacity!, unit: v.unit, isActive: v.isActive,
      });
      message.success('Container capacity saved');
      await refresh();
      setEditing(null);
    } catch (err) {
      message.error(errorText(err));
    }
  };
  const onDelete = async () => {
    if (!current) return;
    try {
      await remove.mutateAsync({ capacityId: current.CapacityId, rowVer: current.RowVer });
      message.success('Container capacity removed');
      await refresh();
      setEditing(null);
    } catch (err) {
      message.error(errorText(err));
    }
  };
  const toggle = async (r: Row, isActive: boolean) => {
    try {
      await setActive.mutateAsync({ capacityId: r.CapacityId, rowVer: r.RowVer, isActive });
      await refresh();
    } catch (err) {
      message.error(errorText(err));
    }
  };

  const columns: AppColumn<Row>[] = [
    { title: 'Major', key: 'MajorCategory', dataIndex: 'MajorCategory', width: 160 },
    { title: 'Sub-major', key: 'SubMajorCategory', width: 180, render: (_: unknown, r) => any(r.SubMajorCategory) },
    { title: 'Size', key: 'Size', width: 100, render: (_: unknown, r) => any(r.Size) },
    { title: 'Capacity per container', key: 'Capacity', width: 130, align: 'right', render: (_: unknown, r) => formatNumber(r.Capacity) },
    { title: 'Unit', key: 'Unit', dataIndex: 'Unit', width: 70 },
    {
      title: 'Active', key: 'IsActive', width: 80,
      render: (_: unknown, r) => (
        <span onClick={(e) => e.stopPropagation()}>
          <Switch size="small" checked={r.IsActive} disabled={!editable} loading={setActive.isPending && setActive.variables?.capacityId === r.CapacityId}
            onChange={(v) => toggle(r, v)} aria-label={`Active ${r.MajorCategory} ${r.SubMajorCategory ?? ''} ${r.Size ?? ''}`} />
        </span>
      ),
    },
    { title: 'Updated', key: 'UpdatedAt', width: 190, render: (_: unknown, r) => `${formatDateTime(r.UpdatedAt)}${r.UpdatedByName ? ` · ${r.UpdatedByName}` : ''}` },
  ];

  const c = choices.data;
  const subOptions = [{ value: ANY, label: 'any sub-major' }, ...(c?.subMajors ?? []).filter((s) => s.major === major).map((s) => ({ value: s.subMajor, label: s.subMajor }))];
  const sizeOptions = [{ value: ANY, label: 'any size' }, ...(sizes.data ?? []).map((s) => ({ value: s, label: s }))];

  return (
    <>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
        The maximum payload of one container per product. A new demand's capacity per container starts from it: the most specific row wins
        (major + sub-major + size, then major + sub-major, then major), and a container of several products takes the smallest. Saved demands keep their own number.
      </Typography.Paragraph>
      <AppTable<Row>
        prefs={prefs}
        itemName="capacities"
        rowKey="CapacityId"
        columns={columns}
        dataSource={list.data}
        loading={list.isFetching}
        page={page}
        total={list.data?.length ?? 0}
        onPageChange={setPage}
        onRow={(r) => ({ onClick: () => openModal(r), style: { cursor: 'pointer' } })}
        toolbar={editable && <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal('new')}>Add capacity</Button>}
      />
      <Modal open={!!editing} onCancel={() => setEditing(null)} forceRender width={460}
        title={current ? 'Container capacity' : 'New container capacity'}
        footer={editable ? (
          <Space>
            {current && (
              <Popconfirm title="Remove this capacity?" description="Saved demands keep their numbers." okText="Remove" okButtonProps={{ danger: true }} onConfirm={onDelete}>
                <Button danger icon={<DeleteOutlined />} loading={remove.isPending}>Remove</Button>
              </Popconfirm>
            )}
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button type="primary" loading={save.isPending} onClick={() => form.submit()}>Save</Button>
          </Space>
        ) : <Button onClick={() => setEditing(null)}>Close</Button>}>
        <Form form={form} layout="vertical" onFinish={onSave} disabled={!editable} requiredMark={false}>
          <Form.Item label="Major category" name="majorCategory" rules={[{ required: true, message: 'Choose a major category' }]}>
            <Select id="capMajor" showSearch loading={choices.isFetching} placeholder="Major category"
              options={(c?.majors ?? []).map((m) => ({ value: m, label: m }))}
              onChange={() => form.setFieldsValue({ subMajorCategory: ANY, size: ANY })} />
          </Form.Item>
          <Form.Item label="Sub-major" name="subMajorCategory">
            <Select id="capSub" showSearch disabled={!editable || !major} options={subOptions} onChange={() => form.setFieldsValue({ size: ANY })} />
          </Form.Item>
          <Form.Item label="Size" name="size" extra={sub === ANY ? 'Choose a sub-major to set a size.' : undefined}>
            <Select id="capSize" showSearch disabled={!editable || !sub || sub === ANY} loading={sizes.isFetching} options={sizeOptions} />
          </Form.Item>
          <Space size={12} align="start">
            <Form.Item label="Capacity per container" name="capacity" rules={[{ required: true, message: 'Enter the capacity' }]}>
              <InputNumber id="capCapacity" min={1} max={99_999} precision={0} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item label="Unit" name="unit" rules={[{ required: true, message: 'Enter the unit' }, { pattern: /^[A-Za-z0-9]{1,10}$/, message: 'Up to 10 letters or digits' }]}
              normalize={(v?: string) => (v ?? '').toUpperCase()}>
              <AutoComplete id="capUnit" style={{ width: 120 }} placeholder="CT, KG, BOX…" maxLength={10}
                options={(c?.units ?? []).map((u) => ({ value: u }))} filterOption={(input, o) => String(o?.value ?? '').includes(input.toUpperCase())} />
            </Form.Item>
          </Space>
          <Space>
            <Form.Item name="isActive" valuePropName="checked" noStyle><Switch id="capActive" /></Form.Item>
            <Typography.Text>Active (used for new demands)</Typography.Text>
          </Space>
        </Form>
      </Modal>
    </>
  );
}
