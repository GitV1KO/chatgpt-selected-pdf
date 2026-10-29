import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const project = fileURLToPath(new URL('../', import.meta.url));
const result = spawnSync('python3', ['-c', `
import json,os,zipfile
from pathlib import Path
p=Path(${JSON.stringify(project)})
v=json.loads((p/'extension/manifest.json').read_text())['version']
out=p/'dist'/('chatgpt-selected-pdf-'+v+'.zip')
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
 for f in sorted((p/'extension').rglob('*')):
  if f.is_file() and not f.name.startswith('.'):z.write(f,f.relative_to(p/'extension'))
with zipfile.ZipFile(out) as z:
 assert z.testzip() is None
 assert 'manifest.json' in z.namelist()
print(out)
source=p/'dist'/('chatgpt-selected-pdf-'+v+'-source.zip')
files=[]
for directory in ['extension','scripts','docs']:
 files += [f for f in (p/directory).rglob('*') if f.is_file() and not f.name.startswith('.')]
files += [p/name for name in ['.gitignore','README.md','LICENSE','package.json','package-lock.json','tests/browser.mjs','tests/fixture.mjs']]
with zipfile.ZipFile(source,'w',zipfile.ZIP_DEFLATED) as z:
 for f in sorted(files):z.write(f,Path('chatgpt-selected-pdf')/f.relative_to(p))
with zipfile.ZipFile(source) as z:assert z.testzip() is None
print(source)
`], {encoding: 'utf8'});
if (result.status) throw new Error(result.stderr);
console.log(result.stdout.trim());
