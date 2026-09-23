import { Select } from 'antd';

type Props = {
  id: string;
  placeholder: string;
  options: string[];
  value: string[] | undefined;
  onChange: (value: string[] | undefined) => void;
  width?: number;
};

/** The one filter dropdown used by every screen: searchable, multi-select, clearable. */
export function MultiFilter({ id, placeholder, options, value, onChange, width = 160 }: Props) {
  return (
    <Select
      id={id}
      mode="multiple"
      allowClear
      showSearch
      maxTagCount="responsive"
      placeholder={placeholder}
      value={value ?? []}
      onChange={(v: string[]) => onChange(v.length ? v : undefined)}
      options={options.map((o) => ({ value: o, label: o }))}
      style={{ width }}
    />
  );
}
