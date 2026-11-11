"""Read-only XLSX preparation and optional encrypted SSH import. Never prints cells.

Imports ONLY explicitly mapped client workbooks; original bytes remain unchanged.
The server seals content before storage. No files are extracted from the archive.
"""
import argparse, base64, csv, hashlib, io, json, posixpath, re, subprocess, zipfile
import xml.etree.ElementTree as ET

MAIN = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
REL = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
PKG = '{http://schemas.openxmlformats.org/package/2006/relationships}'
XDR = '{http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing}'
EXCLUDED = {'CAR SPOT', 'ROSS AMSEL RABEN NASCIMENTO', 'SHG Healthcare'}
MAX_FILE = 10 * 1024 * 1024

def read_entry(z, name, limit=20 * 1024 * 1024):
    info = z.getinfo(name)
    if info.file_size > limit:
        raise ValueError('Archive member exceeds limit')
    return z.read(info)

def xml(z, name):
    value = read_entry(z, name)
    if b'<!DOCTYPE' in value or b'<!ENTITY' in value:
        raise ValueError('XML declarations not allowed')
    return ET.fromstring(value)

def relationships(z, part):
    name = posixpath.join(posixpath.dirname(part), '_rels', posixpath.basename(part) + '.rels')
    if name not in z.namelist():
        return {}
    result = {}
    for entry in xml(z, name):
        if entry.get('TargetMode') == 'External':
            continue
        target = entry.get('Target', '')
        target = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join(posixpath.dirname(part), target))
        if not target.startswith('xl/') or '\\' in target:
            continue
        result[entry.get('Id')] = target
    return result

def workbook_payload(original):
    if len(original) > MAX_FILE:
        raise ValueError('Workbook too large')
    with zipfile.ZipFile(io.BytesIO(original)) as book:
        entries = book.infolist()
        if len(entries) > 5000 or len({e.filename for e in entries}) != len(entries) or sum(e.file_size for e in entries) > 100 * 1024 * 1024:
            raise ValueError('Invalid workbook archive')
        if any('vbaproject' in e.filename.lower() or 'externallinks/' in e.filename.lower() for e in entries):
            raise ValueError('Active workbook content requires review')
        strings = []
        if 'xl/sharedStrings.xml' in book.namelist():
            strings = [''.join(t.text or '' for t in item.iter(MAIN+'t')) for item in xml(book,'xl/sharedStrings.xml')]
        links = relationships(book, 'xl/workbook.xml')
        sheets = []
        truncated = False
        budget = 0
        for sheet in xml(book, 'xl/workbook.xml').findall(MAIN+'sheets/'+MAIN+'sheet'):
            part = links.get(sheet.get(REL+'id'))
            if not part:
                raise ValueError('Missing worksheet relationship')
            tree = xml(book,part)
            rows = []
            for row in tree.findall(MAIN+'sheetData/'+MAIN+'row'):
                cells = []
                for cell in row.findall(MAIN+'c'):
                    ref = cell.get('r','')
                    match = re.fullmatch(r'([A-Z]{1,3})([1-9][0-9]{0,6})', ref)
                    if not match:
                        raise ValueError('Invalid cell reference')
                    raw = cell.findtext(MAIN+'v','')
                    kind = cell.get('t','n')
                    if kind == 's' and raw and (not re.fullmatch(r'[0-9]+',raw) or int(raw) >= len(strings)):
                        raise ValueError('Invalid shared-string index')
                    text = strings[int(raw)] if kind == 's' and raw else ''.join(t.text or '' for t in cell.iter(MAIN+'t')) if kind == 'inlineStr' else ('TRUE' if raw == '1' else 'FALSE') if kind == 'b' else raw
                    if not text:
                        continue
                    if len(text) > 32767:
                        text = text[:32767]; truncated = True
                    item = {'column':match[1], 'text':text}
                    cost = len(json.dumps(item,ensure_ascii=False).encode('utf8')) + 80
                    if budget + cost > 1800000:
                        truncated = True; continue
                    cells.append(item); budget += cost
                if cells:
                    rows.append({'row':int(row.get('r')), 'cells':cells})
            image_count = 0
            drawings = relationships(book,part)
            for drawing in tree.findall(MAIN+'drawing'):
                target = drawings.get(drawing.get(REL+'id'))
                if target:
                    image_count += len(list(xml(book,target).iter(XDR+'pic')))
            sheets.append({'name':sheet.get('name','Sheet'), 'rows':rows, 'imageCount':image_count})
        return {'version':1,'originalBase64':base64.b64encode(original).decode('ascii'),'sheets':sheets,'previewTruncated':truncated}

def prepare(archive, mappings, organizations):
    orgs = {o['id']:o for o in organizations}
    routes = {m['sourceOrganization']:m['organizationId'] for m in mappings}
    if len(orgs) != len(organizations) or len(routes) != len(mappings):
        raise ValueError('Ambiguous client mapping')
    with zipfile.ZipFile(archive) as export:
        names = export.namelist()
        if len(names) != len(set(names)):
            raise ValueError('Duplicate export member')
        docs = list(csv.DictReader(io.StringIO(read_entry(export,'documents.csv').decode('utf-8-sig'))))
        by_id = {r['id']:r for r in docs}
        if len(by_id) != len(docs):
            raise ValueError('Duplicate source document ID')
        for entry in export.infolist():
            match = re.fullmatch(r'attachments/documents/(\d+)/([^/]+\.xlsx)',entry.filename,re.I)
            if not match:
                continue
            record = by_id.get(match[1])
            if not record:
                raise ValueError('Workbook without client provenance')
            source = record['organization']
            if source in EXCLUDED or source.upper().startswith('ROSS AMSEL'):
                yield {'skip':'excluded'}; continue
            if source not in routes:
                yield {'skip':'unmapped','sourceOrganization':source}; continue
            org = orgs[routes[source]]
            original = read_entry(export,entry.filename,MAX_FILE)
            filename = match[2]
            yield {'partnerId':org['partnerId'],'organizationId':org['id'],'organizationName':org['name'],
                'sourceOrganization':source,'sourceId':match[1]+'/'+filename,'name':filename.rsplit('.',1)[0].replace('_',' '),
                'filename':filename,'sha256':hashlib.sha256(original).hexdigest(),'payload':workbook_payload(original)}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive',required=True); parser.add_argument('--mappings',required=True); parser.add_argument('--organizations',required=True)
    parser.add_argument('--host'); parser.add_argument('--key'); parser.add_argument('--commit',action='store_true')
    args=parser.parse_args()
    with open(args.mappings,encoding='utf-8-sig') as f: mappings=json.load(f)
    with open(args.organizations,encoding='utf-8-sig') as f: organizations=json.load(f)
    counts={'workbooks':0,'sheets':0,'images':0,'truncated':0,'excluded':0,'unmapped':0,'inserted':0,'existing':0}
    clients=set()
    for item in prepare(args.archive,mappings,organizations):
        if 'skip' in item:
            counts[item['skip']]+=1; continue
        counts['workbooks']+=1; counts['sheets']+=len(item['payload']['sheets']); counts['images']+=sum(s['imageCount'] for s in item['payload']['sheets']); counts['truncated']+=int(item['payload']['previewTruncated']); clients.add(item['organizationId'])
        if args.host:
            if not args.key: raise ValueError('SSH key required')
            command=['ssh','-i',args.key,args.host,'sudo docker exec -i cloudcom-api node /app/apps/api/dist/scripts/documentation-import.cjs'+('' if args.commit else ' --dry-run')]
            encoded=base64.b64encode(json.dumps(item,ensure_ascii=False,separators=(',',':')).encode('utf8'))
            result=subprocess.run(command,input=encoded,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            if result.returncode: raise RuntimeError('Server import rejected document; contents suppressed')
            # Core initialization may write a non-secret status line before
            # the operator CLI's final JSON result. Never echo that output.
            response=json.loads(result.stdout.splitlines()[-1])
            if response.get('validated') != 1 or response.get('dryRun') != (not args.commit):
                raise RuntimeError('Unexpected import result')
            counts['inserted']+=response['inserted']; counts['existing']+=response['existing']
    counts['clients']=len(clients); counts['committed']=bool(args.host and args.commit)
    print(json.dumps(counts))

if __name__=='__main__':
    try: main()
    except Exception: raise SystemExit('Documentation preparation/import failed. Source contents suppressed; review mapping and limits.')
