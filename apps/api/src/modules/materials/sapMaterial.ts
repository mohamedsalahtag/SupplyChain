/**
 * Which SAP materials the app includes, and how an SAP row maps to md.Material.
 * Rule agreed in docs/screens/01-materials.md. Material types are chosen in
 * Configuration → Materials sync; the major categories are fixed here.
 */
export const DEFAULT_MATERIAL_TYPES = ['ZTRD'];
export const INCLUDED_MAJOR_CATEGORIES = ['VEG', 'CIT', 'APL', 'SUF', 'STF', 'GRP', 'PEA', 'BRE', 'KIW', 'BAN', 'PIN'] as const;

/** Material type codes are short SAP codes; anything else is refused before it reaches a filter. */
export const MATERIAL_TYPE_CODE = /^[A-Z0-9]{1,10}$/;

const anyOf = (field: string, values: readonly string[]) => '(' + values.map((v) => `${field} eq '${v}'`).join(' or ') + ')';

/** OData $filter for the rule. The mapping below re-checks it after trimming. */
export function buildSapFilter(materialTypes: readonly string[]): string {
  if (materialTypes.length === 0 || !materialTypes.every((t) => MATERIAL_TYPE_CODE.test(t))) {
    throw new Error('Choose at least one valid material type');
  }
  return `${anyOf('Material_Type', materialTypes)} and ${anyOf('Major_Category', INCLUDED_MAJOR_CATEGORIES)}`;
}
export const SAP_ORDER_BY = 'MATERAIL';

export type MaterialRow = {
  MaterialCode: string;
  Description: string;
  MajorCategoryCode: string;
  MajorCategory: string;
  SubMajorCategory: string;
  MaterialGroupCode: string;
  MaterialGroup: string;
  MaterialType: string;
  BaseUnit: string;
  BaseUnitName: string;
  Origin: string;
  Variety: string;
  Size: string;
  Weight: number | null;
  WeightUnit: string;
  MaterialClassCode: string;
  MaterialClass: string;
};

const text = (v: unknown): string => (v == null ? '' : String(v).trim());

function weight(v: unknown): number | null {
  const s = text(v);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Maps one SAP row; returns null when it does not match the include rule. */
export function mapSapMaterial(r: Record<string, unknown>, materialTypes: readonly string[]): MaterialRow | null {
  const row: MaterialRow = {
    MaterialCode: text(r.MATERAIL), // SAP's field name is misspelled
    Description: text(r.Material_Desc),
    MajorCategoryCode: text(r.Major_Category),
    MajorCategory: text(r.Major_Category_Desc),
    SubMajorCategory: text(r.SubMajor_Category),
    MaterialGroupCode: text(r.Material_Group),
    MaterialGroup: text(r.Material_Group_Desc),
    MaterialType: text(r.Material_Type),
    BaseUnit: text(r.Base_Unit),
    BaseUnitName: text(r.Base_Unit_Name),
    Origin: text(r.Origin_Name),
    Variety: text(r.Variety_Name),
    Size: text(r.Size_Name),
    Weight: weight(r.Weight),
    WeightUnit: text(r.Weight_Unit),
    MaterialClassCode: text(r.ClassID),
    MaterialClass: text(r.Class_Name),
  };
  const included =
    row.MaterialCode !== '' &&
    !/^\d/.test(row.MaterialCode) && // codes starting with a digit are never shown
    materialTypes.includes(row.MaterialType) &&
    (INCLUDED_MAJOR_CATEGORIES as readonly string[]).includes(row.MajorCategoryCode);
  return included ? row : null;
}
