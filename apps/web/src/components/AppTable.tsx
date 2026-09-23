import type { ReactNode } from 'react';
import { Button, Checkbox, Popover, Space, Table, Typography, type TableProps } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import type { ColumnType } from 'antd/es/table';
import { PAGE_SIZE_OPTIONS, type TablePrefs } from '../lib/useTablePrefs';

/**
 * Every column needs a stable key (saved in preferences), a plain-text title
 * (shown in the chooser) and a numeric width, used only as its share of the
 * page width.
 */
export type AppColumn<T> = Omit<ColumnType<T>, 'fixed' | 'width'> & {
  key: string;
  title: string;
  width: number;
};

type Props<T> = Omit<TableProps<T>, 'columns' | 'pagination' | 'size' | 'bordered' | 'scroll' | 'tableLayout'> & {
  prefs: TablePrefs;
  columns: AppColumn<T>[];
  /** Server-side paging: current page and total rows. */
  page: number;
  total: number;
  onPageChange: (page: number) => void;
  /** Left side of the toolbar (search, filters). The Columns button sits on the right. */
  toolbar?: ReactNode;
  /** Word for the total under the table, e.g. "materials". */
  itemName?: string;
};

/**
 * The one table used by every screen: compact, bordered, always as wide as the
 * page and never wider (no sideways scrolling — long text ends in "…", full
 * text on hover). 25/50/100 rows per page and a Columns chooser, both saved per
 * user (useTablePrefs).
 */
export function AppTable<T extends object>({ prefs, columns, page, total, onPageChange, toolbar, itemName = 'rows', onChange, ...rest }: Props<T>) {
  const hidden = new Set(prefs.hiddenColumns);
  const visible = columns.filter((c) => !hidden.has(c.key));

  // Widths become shares of the page, so the visible columns always fit exactly.
  const sum = visible.reduce((s, c) => s + c.width, 0);
  const fitted = visible.map((c) => ({ ...c, width: `${((c.width / sum) * 100).toFixed(2)}%`, ellipsis: c.ellipsis ?? true }));

  const chooser = (
    <Space direction="vertical" size={4} style={{ minWidth: 180 }}>
      <Checkbox.Group
        value={visible.map((c) => c.key)}
        onChange={(keys) => {
          if (keys.length === 0) return; // keep at least one column
          prefs.setHiddenColumns(columns.filter((c) => !keys.includes(c.key)).map((c) => c.key));
        }}
      >
        <Space direction="vertical" size={2}>
          {columns.map((c) => (
            <Checkbox key={c.key} value={c.key} disabled={visible.length === 1 && !hidden.has(c.key)}>
              {c.title}
            </Checkbox>
          ))}
        </Space>
      </Checkbox.Group>
      <Space split="·" size={4}>
        <Typography.Link disabled={hidden.size === 0} onClick={() => prefs.setHiddenColumns([])}>
          Show all
        </Typography.Link>
        <Typography.Link disabled={!prefs.customColumns} onClick={prefs.resetColumns}>
          Default columns
        </Typography.Link>
      </Space>
    </Space>
  );

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, flex: 1 }}>{toolbar}</div>
        <Popover content={chooser} title="Show columns" trigger="click" placement="bottomRight">
          <Button icon={<SettingOutlined />} data-testid="columns-button">
            Columns ({visible.length}/{columns.length})
          </Button>
        </Popover>
      </div>
      <Table<T>
        {...rest}
        size="small"
        bordered
        tableLayout="fixed"
        columns={fitted}
        onChange={(pagination, filters, sorter, extra) => {
          if (pagination.pageSize && pagination.pageSize !== prefs.pageSize) {
            prefs.setPageSize(pagination.pageSize);
            onPageChange(1); // a new page size starts again from page 1
          } else if (pagination.current && pagination.current !== page) {
            onPageChange(pagination.current);
          }
          onChange?.(pagination, filters, sorter, extra);
        }}
        pagination={{
          current: page,
          pageSize: prefs.pageSize,
          pageSizeOptions: PAGE_SIZE_OPTIONS,
          showSizeChanger: true,
          total,
          size: 'small',
          showTotal: (t) => `${t.toLocaleString('en-GB')} ${itemName}`,
        }}
      />
    </Space>
  );
}
