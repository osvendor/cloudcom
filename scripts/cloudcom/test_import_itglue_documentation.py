import base64, importlib.util, io, json, pathlib, tempfile, unittest, zipfile

path=pathlib.Path(__file__).with_name('import-itglue-documentation.py')
spec=importlib.util.spec_from_file_location('docs_import',path)
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)

def workbook():
    out=io.BytesIO()
    with zipfile.ZipFile(out,'w') as z:
        z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Notes" r:id="rId1"/></sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr('xl/sharedStrings.xml','<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>&lt;script&gt;inert&lt;/script&gt;</t></si></sst>')
        z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="3"><c r="B3" t="s"><v>0</v></c><c r="D3" t="inlineStr"><is><t>Note</t></is></c><c r="F3" t="b"><v>1</v></c></row></sheetData></worksheet>')
    return out.getvalue()

class DocumentationImportTests(unittest.TestCase):
    def test_original_and_sparse_positions_preserved(self):
        original=workbook(); result=module.workbook_payload(original)
        self.assertEqual(base64.b64decode(result['originalBase64']),original)
        self.assertEqual(result['sheets'][0]['rows'],[{'row':3,'cells':[{'column':'B','text':'<script>inert</script>'},{'column':'D','text':'Note'},{'column':'F','text':'TRUE'}]}])
        self.assertFalse(result['previewTruncated'])

    def test_mapping_uses_document_owner_not_filename(self):
        with tempfile.TemporaryDirectory() as td:
            export=pathlib.Path(td)/'export.zip'
            with zipfile.ZipFile(export,'w') as z:
                z.writestr('documents.csv','id,organization,name\n1,Acme,General\n2,SHG Healthcare,General\n3,Other,General\n')
                for n in (1,2,3): z.writestr(f'attachments/documents/{n}/Different_Client.xlsx',workbook())
                z.writestr('attachments/documents/1/install.exe',b'not executed')
            result=list(module.prepare(export,[{'sourceOrganization':'Acme','organizationId':'1'}],[{'id':'1','name':'Acme destination','partnerId':'p'}]))
            self.assertEqual(result[0]['organizationId'],'1')
            self.assertEqual(result[0]['sourceOrganization'],'Acme')
            self.assertEqual(result[1],{'skip':'excluded'})
            self.assertEqual(result[2],{'skip':'unmapped','sourceOrganization':'Other'})
            self.assertEqual(len(result),3)

    def test_duplicate_members_rejected(self):
        data=io.BytesIO(workbook())
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            with zipfile.ZipFile(data,'a') as z: z.writestr('xl/workbook.xml','duplicate')
        with self.assertRaises(ValueError): module.workbook_payload(data.getvalue())

    def test_external_workbook_links_rejected(self):
        data=io.BytesIO(workbook())
        with zipfile.ZipFile(data,'a') as z: z.writestr('xl/externalLinks/externalLink1.xml','external')
        with self.assertRaises(ValueError): module.workbook_payload(data.getvalue())

    def test_duplicate_client_mapping_rejected(self):
        mappings=[{'sourceOrganization':'Acme','organizationId':'1'},{'sourceOrganization':'Acme','organizationId':'2'}]
        with self.assertRaises(ValueError): list(module.prepare('unused.zip',mappings,[]))

    def test_negative_shared_string_index_rejected(self):
        src=zipfile.ZipFile(io.BytesIO(workbook())); target=io.BytesIO()
        with zipfile.ZipFile(target,'w') as z:
            for info in src.infolist():
                data=src.read(info)
                if info.filename.endswith('sheet1.xml'): data=data.replace(b'<v>0</v>',b'<v>-1</v>')
                z.writestr(info.filename,data)
        with self.assertRaises(ValueError): module.workbook_payload(target.getvalue())

if __name__=='__main__': unittest.main()
