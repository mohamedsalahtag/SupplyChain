import { describe, expect, it } from 'vitest';
import { buildSapFilter, mapSapMaterial } from './sapMaterial.js';

const TYPES = ['ZTRD'];

const sap = {
  MATERAIL: ' BAN100101 ',
  Material_Desc: 'Banana Cavendish 13kg',
  Major_Category: 'BAN',
  Major_Category_Desc: 'Bananas',
  SubMajor_Category: 'Bananas A13/13.5k',
  Material_Group: '01BN',
  Material_Group_Desc: 'Bananas',
  Material_Type: 'ZTRD',
  Base_Unit: 'CAR',
  Base_Unit_Name: 'Carton',
  Origin_Name: 'Ecuador',
  Variety_Name: 'Cavendish',
  Size_Name: 'Premium',
  Weight: '13.000',
  Weight_Unit: 'KGM',
};

describe('mapSapMaterial', () => {
  it('maps and trims an included material', () => {
    const row = mapSapMaterial({ ...sap, Major_Category_Desc: 'Stone Fruit    ', Major_Category: 'STF' }, TYPES);
    expect(row).toMatchObject({ MaterialCode: 'BAN100101', MajorCategory: 'Stone Fruit', Weight: 13, WeightUnit: 'KGM' });
  });

  it('excludes other material types and categories', () => {
    expect(mapSapMaterial({ ...sap, Material_Type: 'ZSPR' }, TYPES)).toBeNull();
    expect(mapSapMaterial({ ...sap, Major_Category: 'FLW' }, TYPES)).toBeNull();
    expect(mapSapMaterial({ ...sap, Major_Category: '' }, TYPES)).toBeNull();
  });

  it('never includes a code that starts with a digit', () => {
    expect(mapSapMaterial({ ...sap, MATERAIL: '104' }, TYPES)).toBeNull();
    expect(mapSapMaterial({ ...sap, MATERAIL: ' 9ABC' }, TYPES)).toBeNull();
    expect(mapSapMaterial({ ...sap, MATERAIL: 'EPARG104' }, TYPES)).not.toBeNull();
  });

  it('treats blank or bad weight as unknown', () => {
    expect(mapSapMaterial({ ...sap, Weight: '' }, TYPES)?.Weight).toBeNull();
    expect(mapSapMaterial({ ...sap, Weight: 'n/a' }, TYPES)?.Weight).toBeNull();
  });

  it('maps the material class', () => {
    expect(mapSapMaterial({ ...sap, ClassID: ' C1 ', Class_Name: 'Class 1' }, TYPES)).toMatchObject({ MaterialClassCode: 'C1', MaterialClass: 'Class 1' });
  });

  it('includes every chosen material type', () => {
    expect(mapSapMaterial({ ...sap, Material_Type: 'ZSPR' }, ['ZTRD', 'ZSPR'])).not.toBeNull();
  });

  it('builds the OData filter from the chosen types', () => {
    expect(buildSapFilter(['ZTRD'])).toMatch(/^\(Material_Type eq 'ZTRD'\) and \(Major_Category eq 'VEG' or /);
    expect(buildSapFilter(['ZTRD', 'ZSPR'])).toMatch(/^\(Material_Type eq 'ZTRD' or Material_Type eq 'ZSPR'\)/);
  });

  it('refuses an empty or unsafe type list', () => {
    expect(() => buildSapFilter([])).toThrow();
    expect(() => buildSapFilter(["ZTRD' or 1 eq 1"])).toThrow();
  });
});
