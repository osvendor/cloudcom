import { describe, expect, it } from 'vitest';
import { classifySheet, type DocumentSheet } from './documentSections';
const sheet = (rows: Array<[number, string[]]>): DocumentSheet => ({ name: 'Never use workbook title', rows: rows.map(([row, values]) => ({ row, cells: values.map((text, i) => ({ column: String.fromCharCode(65 + i), text })) })) });
describe('native document classification', () => {
  it('groups headings and sparse gaps while preserving every source cell and row', () => {
    const input = sheet([[1,['Network']], [2,['Router is in the closet.']], [5,['Email']], [6,['Username','synthetic@example.invalid']], [7,['Password: synthetic-only']]]);
    const sections = classifySheet(input);
    expect(sections.map(s => [s.title,s.kind,s.sourceRows])).toEqual([['Network','notes',[1,2]],['Email','credentials',[5,6,7]]]);
    expect(sections.flatMap(s => s.sourceCells)).toEqual(input.rows.flatMap(r => r.cells.map(c => ({row:r.row,...c}))));
    expect(sections[1]!.notes).toEqual([]);
    expect(sections[1]!.fields).toEqual([{label:'Username',value:'synthetic@example.invalid',secret:false},{label:'Password',value:'synthetic-only',secret:true}]);
  });
  it('recognizes inline labels and paired cells without promoting unlabelled strings', () => {
    const [section] = classifySheet(sheet([[1,['username: synthetic-user\npassword=synthetic-pass']], [2,['some unlabelled text']]]));
    expect(section!.fields).toHaveLength(2); expect(section!.notes).toEqual(['some unlabelled text']);
    expect(section!.title).toBe('Review 1');
  });
  it.each(['123456','12345678','2345672345672345','unknown-token'])('never mistakes %s for an OTP seed', value => {
    const [section] = classifySheet(sheet([[1,[`OTP secret: ${value}`]]]));
    expect(section!.kind).toBe('review'); expect(section!.fields).toEqual([{label:'OTP value (review)',value,secret:true}]);
  });
  it.each(['JBSWY3DPEHPK3PXP','otpauth://totp/Synthetic?secret=JBSWY3DPEHPK3PXP'])('recognizes explicit seed-like values without generating codes', value => {
    const [section] = classifySheet(sheet([[1,['TOTP secret',value]]]));
    expect(section!.kind).toBe('credentials'); expect(section!.fields[0]).toEqual({label:'OTP seed',value,secret:true});
  });
  it('conceals numeric codes and retains suspicious unlabelled content as review', () => {
    const sections = classifySheet(sheet([[1,['MFA code: 123456']], [3,['otpauth://totp/Synthetic?secret=SYNTHETIC']], [5,['someone@example.invalid']]]));
    expect(sections.map(s => s.kind)).toEqual(['review','review','review']); expect(sections[0]!.fields[0]!.secret).toBe(true);
  });
  it('never infers arbitrary short text or password values as a heading', () => {
    const sections=classifySheet(sheet([[1,['synthetic-unlabelled-value']],[2,['Password: synthetic-value']],[4,['# arbitrary-title']]]));
    expect(sections.map(s=>s.title)).toEqual(['Review 1','Notes 2']); expect(sections[0]!.notes).not.toContain('synthetic-value');
  });
  it('keeps missing labels in review without eating a following label', () => {
    const [section]=classifySheet(sheet([[1,['Password','Email','synthetic@example.invalid']]]));
    expect(section!.kind).toBe('review'); expect(section!.fields.map(f=>f.value)).toEqual(['','synthetic@example.invalid']);
  });
  it('does not mutate input and preserves blank source cells and markup', () => {
    const input=sheet([[8,['<script>inert</script>','']], [9,['']], [10,['Ordinary note']]]), before=JSON.stringify(input);
    const sections=classifySheet(input);expect(JSON.stringify(input)).toBe(before);expect(sections.flatMap(s=>s.sourceCells)).toHaveLength(4);expect(sections[0]!.notes).toContain('<script>inert</script>');
  });
  it('does not fuse separated columns into credentials', () => {
    const input:DocumentSheet={name:'test',rows:[{row:1,cells:[{column:'A',text:'Username'},{column:'C',text:'unrelated-column'}]}]};
    const [section]=classifySheet(input);expect(section!.kind).toBe('review');expect(section!.fields[0]!.value).toBe('');expect(section!.notes).toContain('unrelated-column');
  });
  it('recognizes a standalone label then a single same-column next-row value', () => {
    const [section]=classifySheet(sheet([[1,['Username']],[2,['synthetic-user']],[3,['Password']],[4,['synthetic-password']]]));
    expect(section!.kind).toBe('credentials');expect(section!.fields.map(f=>f.value)).toEqual(['synthetic-user','synthetic-password']);expect(section!.notes).toEqual([]);
  });
  it('does not consume next-row values from another column or mixed rows', () => {
    const [section]=classifySheet({name:'test',rows:[{row:1,cells:[{column:'A',text:'Password'}]},{row:2,cells:[{column:'C',text:'unrelated'}]}]});
    expect(section!.kind).toBe('review');expect(section!.fields[0]!.value).toBe('');expect(section!.notes).toEqual(['unrelated']);
  });
  it('places unlabelled email/password pairs and mixed credential blocks in review', () => {
    const sections=classifySheet(sheet([[1,['synthetic@example.invalid','opaque-value']],[4,['Username: synthetic']],[5,['unexplained content']]]));
    expect(sections.map(s=>s.kind)).toEqual(['review','review']);
  });
  it('allows bounded explicit service headings but never inline values as titles', () => {
    const sections=classifySheet(sheet([[1,['Domain Admin:']],[2,['Username: synthetic']],[4,['Fortinet Client Portal:']],[5,['Password: synthetic-only']],[7,['Password: do-not-title-me']]]));
    expect(sections.map(s=>s.title)).toEqual(['Domain Admin','Fortinet Client Portal','Credentials 3']);
  });
  it('keeps an unlabelled opaque token in collapsed review rather than ordinary notes', () => {
    expect(classifySheet(sheet([[1,['x7Qb9zSynthetic']]]))[0]!.kind).toBe('review');
  });
  it('does not treat a next-row password value matching a heading as a title', () => {
    const [section]=classifySheet(sheet([[1,['Password']],[2,['Network']]]));
    expect(section!.title).toBe('Credentials 1');expect(section!.fields[0]).toEqual({label:'Password',value:'Network',secret:true});expect(section!.notes).toEqual([]);
  });
  it('recognizes User as an explicit username label', () => {
    const [section]=classifySheet(sheet([[1,['User: synthetic-user']],[2,['Password: synthetic-pass']]]));
    expect(section!.kind).toBe('credentials');expect(section!.fields[0]).toEqual({label:'Username',value:'synthetic-user',secret:false});
  });
  it.each(([
    [[1,['User: synthetic-one','Username: synthetic-two']],[2,['Password: synthetic-one','Password: synthetic-two']]],
    [[1,['Username: synthetic-one']],[2,['Password: synthetic-one']],[3,['User: synthetic-two']],[4,['Password: synthetic-two']]],
  ] as Array<Array<[number,string[]]>>).map(rows => ({rows})))('keeps multiple account candidates in review without losing any fields', ({rows}) => {
    const [section]=classifySheet(sheet(rows));expect(section!.kind).toBe('review');expect(section!.fields).toHaveLength(4);expect(section!.fields.filter(f=>f.secret)).toHaveLength(2);
  });
});
