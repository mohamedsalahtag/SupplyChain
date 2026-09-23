import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Badge, Button, Card, Col, Empty, Input, Row, Space, Switch, Tag, Typography } from 'antd';
import { DownOutlined, RightOutlined, SaveOutlined, UndoOutlined } from '@ant-design/icons';
import type { CatalogScreen } from '@supplychain/shared';
import { trpc } from '../../lib/trpc';

type Props = {
  roleId: number;
  isAdmin: boolean;
  canEdit: boolean;
  catalog: CatalogScreen[];
  granted: string[];
};

const keysOf = (s: CatalogScreen) => [s.open, ...s.actions.map((a) => a.key)];

/** Every screen and button, with switches. Changes are saved with "Save permissions". Spec 07. */
export function RolePermissions({ roleId, isAdmin, canEdit, catalog, granted }: Props) {
  const { message } = App.useApp();
  const utils = trpc.useUtils();
  const save = trpc.security.setPermissions.useMutation();
  const [draft, setDraft] = useState<Set<string>>(new Set(granted));
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => setDraft(new Set(granted)), [granted, roleId]);

  const locked = isAdmin || !canEdit;
  const total = catalog.reduce((n, s) => n + keysOf(s).length, 0);
  const dirty = draft.size !== granted.length || granted.some((k) => !draft.has(k));

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter((s) => [s.label, s.section, ...s.actions.map((a) => a.label)].some((t) => t.toLowerCase().includes(q)));
  }, [catalog, search]);
  const sections = [...new Set(visible.map((s) => s.section))];

  const set = (keys: string[], on: boolean) =>
    setDraft((d) => {
      const n = new Set(d);
      keys.forEach((k) => (on ? n.add(k) : n.delete(k)));
      return n;
    });

  // Closing a screen also removes its buttons: they are useless without it.
  const setOpen = (s: CatalogScreen, on: boolean) => set(on ? [s.open] : keysOf(s), on);

  const onSave = async () => {
    try {
      await save.mutateAsync({ roleId, permissionKeys: [...draft] });
      await Promise.all([utils.security.role.invalidate({ roleId }), utils.security.roles.invalidate(), utils.auth.me.invalidate()]);
      message.success('Permissions saved');
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      {isAdmin && <Alert type="info" showIcon message="Administrator always has every permission, including screens added later. It cannot be changed." />}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <Input.Search id="permSearch" placeholder="Search screens and buttons…" allowClear value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 260 }} />
        <Button onClick={() => setCollapsed(new Set())}>Expand all</Button>
        <Button onClick={() => setCollapsed(new Set(catalog.map((s) => s.key)))}>Collapse all</Button>
        <Typography.Text type="secondary" style={{ marginInlineStart: 'auto' }} data-testid="granted-count">
          {isAdmin ? total : draft.size} of {total} permissions granted
        </Typography.Text>
      </div>

      {!locked && dirty && (
        <Alert type="warning" showIcon message="Unsaved changes"
          action={
            <Space>
              <Button size="small" icon={<UndoOutlined />} onClick={() => setDraft(new Set(granted))}>Discard</Button>
              <Button size="small" type="primary" icon={<SaveOutlined />} loading={save.isPending} onClick={onSave}>Save permissions</Button>
            </Space>
          } />
      )}

      {visible.length === 0 && <Empty description="No screen or button matches" />}
      {sections.map((section) => (
        <div key={section}>
          <Typography.Text strong type="secondary" style={{ textTransform: 'uppercase', letterSpacing: '.05em' }}>{section}</Typography.Text>
          <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 6 }}>
            {visible.filter((s) => s.section === section).map((s) => {
              const keys = keysOf(s);
              const on = keys.filter((k) => isAdmin || draft.has(k)).length;
              const isCollapsed = collapsed.has(s.key);
              const canOpen = isAdmin || draft.has(s.open);
              return (
                <Card key={s.key} size="small" data-testid={`perm-${s.key}`}
                  title={
                    <Space style={{ cursor: 'pointer' }} onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(s.key)) n.delete(s.key); else n.add(s.key); return n; })}>
                      {isCollapsed ? <RightOutlined /> : <DownOutlined />}
                      {s.label}
                      <Badge count={`${on} / ${keys.length}`} color={on ? '#1f6f43' : '#bfbfbf'} />
                    </Space>
                  }
                  styles={{ body: isCollapsed ? { display: 'none' } : undefined }}>
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    <Space>
                      <Switch size="small" checked={canOpen} disabled={locked} onChange={(v) => setOpen(s, v)} aria-label={`${s.label}: can open this screen`} />
                      <Typography.Text>Can open this screen</Typography.Text>
                    </Space>
                    {s.actions.length === 0 ? (
                      <Typography.Text type="secondary" italic>No individual buttons on this screen.</Typography.Text>
                    ) : (
                      <>
                        {!locked && (
                          <Space size={12}>
                            <Typography.Link disabled={!canOpen} onClick={() => set(s.actions.map((a) => a.key), true)}>Select all</Typography.Link>
                            <Typography.Link onClick={() => set(s.actions.map((a) => a.key), false)}>None</Typography.Link>
                            {!canOpen && <Tag>Allow opening the screen first</Tag>}
                          </Space>
                        )}
                        <Row gutter={[16, 6]}>
                          {s.actions.map((a) => (
                            <Col key={a.key} xs={24} md={12}>
                              <Space>
                                <Switch size="small" checked={isAdmin || draft.has(a.key)} disabled={locked || !canOpen}
                                  onChange={(v) => set([a.key], v)} aria-label={a.label} />
                                <Typography.Text>{a.label}</Typography.Text>
                              </Space>
                            </Col>
                          ))}
                        </Row>
                      </>
                    )}
                  </Space>
                </Card>
              );
            })}
          </Space>
        </div>
      ))}
    </Space>
  );
}
