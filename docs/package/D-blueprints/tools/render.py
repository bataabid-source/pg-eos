#!/usr/bin/env python3
"""Extract every ```mermaid block from D-blueprints/0*.md, render to SVG+PNG with mmdc,
and write <doc>.rendered.md (mermaid blocks replaced by image refs) for pandoc."""
import re, subprocess, hashlib, json, os, sys, concurrent.futures as cf
BASE=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIA=os.path.join(BASE,'diagrams','rendered'); os.makedirs(DIA,exist_ok=True)
PUP='/tmp/pup.json'
open(PUP,'w').write(json.dumps({"executablePath":"/opt/pw-browsers/chromium-1194/chrome-linux/chrome","args":["--no-sandbox","--disable-gpu","--disable-dev-shm-usage"]}))
CFG=os.path.join(DIA,'mmd.config.json')
open(CFG,'w').write(json.dumps({"theme":"neutral","fontFamily":"Cairo, Tajawal, Arial, sans-serif","flowchart":{"htmlLabels":True,"useMaxWidth":True},"themeVariables":{"fontSize":"15px","primaryColor":"#f3ede4","primaryBorderColor":"#8a6d3b","lineColor":"#6b5b3e","primaryTextColor":"#1f1a12"}}))
docs=sorted(f for f in os.listdir(BASE) if re.match(r'\d\d-.*\.md$',f) and '.rendered' not in f)
jobs=[]; manifest={}
for d in docs:
    s=open(os.path.join(BASE,d),encoding='utf-8').read()
    parts=re.split(r'(```mermaid\n.*?```)',s,flags=re.S)
    out=[]; k=0
    for part in parts:
        if part.startswith('```mermaid'):
            code=part[len('```mermaid\n'):-3]
            k+=1
            name=f"{d[:2]}-{k:02d}"
            h=hashlib.md5(code.encode()).hexdigest()[:8]
            mmd=os.path.join(DIA,f"{name}.mmd"); svg=os.path.join(DIA,f"{name}.svg"); png=os.path.join(DIA,f"{name}.png")
            open(mmd,'w',encoding='utf-8').write(code)
            jobs.append((name,mmd,svg,png,h))
            manifest.setdefault(d,[]).append(name)
            out.append(f"\n![{name}](diagrams/rendered/{name}.png)\n")
        else: out.append(part)
    open(os.path.join(BASE,d.replace('.md','.rendered.md')),'w',encoding='utf-8').write(''.join(out))
def run(j):
    name,mmd,svg,png,h=j
    r1=subprocess.run(['mmdc','-q','-i',mmd,'-o',svg,'-p',PUP,'-c',CFG,'-b','white'],capture_output=True,text=True,timeout=180)
    r2=subprocess.run(['mmdc','-q','-i',mmd,'-o',png,'-p',PUP,'-c',CFG,'-b','white','-s','2'],capture_output=True,text=True,timeout=180)
    ok=os.path.exists(svg) and os.path.exists(png)
    return name, ok, (r1.stderr+r2.stderr)[-400:] if not ok else ''
res=[]
with cf.ThreadPoolExecutor(max_workers=4) as ex:
    for r in ex.map(run,jobs): res.append(r); print(r[0],'OK' if r[1] else 'FAIL '+r[2].replace('\n',' | ')[:300],flush=True)
json.dump(manifest,open(os.path.join(DIA,'manifest.json'),'w'),ensure_ascii=False,indent=1)
fails=[r for r in res if not r[1]]
print(f"rendered {len(res)-len(fails)}/{len(res)}; failed: {[r[0] for r in fails]}")
sys.exit(1 if fails else 0)
