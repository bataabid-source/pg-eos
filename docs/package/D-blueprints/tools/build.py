#!/usr/bin/env python3
"""Build the self-contained HTML atlas and the Word atlas from the *.rendered.md files."""
import os, re, subprocess, json, html
BASE=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REN=os.path.join(BASE,'diagrams','rendered')
docs=sorted(f for f in os.listdir(BASE) if f.endswith('.rendered.md'))
TITLES={}
for d in docs:
    first=open(os.path.join(BASE,d),encoding='utf-8').readline().strip('# \n')
    TITLES[d]=first

def md2html(path):
    r=subprocess.run(['pandoc',path,'-f','gfm+tex_math_dollars','-t','html5','--no-highlight','--wrap=none'],capture_output=True,text=True)
    if r.returncode: raise SystemExit(r.stderr)
    return r.stdout

def inline_svgs(h):
    def rep(m):
        name=m.group(1)
        p=os.path.join(REN,name+'.svg')
        s=open(p,encoding='utf-8').read()
        s=re.sub(r'^<\?xml[^>]*\?>','',s).strip()
        s=s.replace('my-svg',f'svg-{name}')
        s=re.sub(r'<svg ([^>]*?)width="100%"',r'<svg \1',s,count=1)
        return f'<figure class="dia" id="fig-{name}">{s}<figcaption>{name}</figcaption></figure>'
    return re.sub(r'<img src="diagrams/rendered/([\w-]+)\.png"[^>]*/?>',rep,h)

CSS='''
@import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap');
:root{--brass:#8a6d3b;--brass2:#c9a961;--ink:#1f1a12;--bg:#faf8f4;--card:#fff;--line:#e6dfd2;--muted:#6b6257}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;font-family:Cairo,Tajawal,"Segoe UI",Arial,sans-serif;color:var(--ink);background:var(--bg);direction:rtl;font-size:15.5px;line-height:1.75}
header.top{position:sticky;top:0;z-index:20;background:linear-gradient(90deg,#2b2419,#4a3b24);color:#fff;padding:10px 20px;display:flex;align-items:center;gap:16px;border-bottom:3px solid var(--brass2)}
header.top .logo{display:flex;gap:4px}header.top .logo i{display:block;width:6px;height:26px;background:var(--brass2);transform:skewX(-14deg)}
header.top h1{font-size:18px;margin:0;font-weight:700}header.top small{opacity:.8;font-size:12px}
.wrap{display:grid;grid-template-columns:300px minmax(0,1fr);min-height:100vh;width:100%}
nav.side{position:sticky;top:57px;height:calc(100vh - 57px);overflow:auto;background:#fff;border-left:1px solid var(--line);padding:14px 10px}
nav.side a{display:block;color:var(--ink);text-decoration:none;padding:5px 10px;border-radius:6px;font-size:14px}
nav.side a:hover{background:#f3ede4}nav.side a.doc{font-weight:700;color:var(--brass);margin-top:8px;border-top:1px solid var(--line);padding-top:8px}
nav.side a.h2{padding-right:22px;font-size:13px;color:var(--muted)}
nav.side input{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-family:inherit;margin-bottom:8px}
main{padding:24px 36px 80px;max-width:1250px;min-width:0;overflow-x:hidden}
section.doc{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:26px 30px;margin-bottom:34px;box-shadow:0 1px 3px rgba(0,0,0,.04)}
section.doc>h1{font-size:26px;color:var(--brass);border-bottom:2px solid var(--brass2);padding-bottom:8px;margin-top:0}
h2{font-size:21px;color:#3d3222;margin-top:34px;border-right:5px solid var(--brass2);padding-right:10px}
h3{font-size:18px;color:#4a3b24;margin-top:26px}h4{font-size:16px;color:var(--brass);margin-top:20px}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:13.5px;display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:6px 9px;vertical-align:top;text-align:right}
th{background:#f3ede4;color:#3d3222;font-weight:700}tr:nth-child(even) td{background:#fcfaf6}
code{font-family:"Cascadia Code",Consolas,monospace;font-size:.88em;background:#f3ede4;padding:1px 5px;border-radius:4px;direction:ltr;unicode-bidi:embed}
pre{background:#2b2419;color:#f5ecd8;padding:14px;border-radius:10px;overflow:auto;direction:ltr;text-align:left;font-size:13px}pre code{background:none;color:inherit;padding:0}
blockquote{border-right:4px solid var(--brass2);background:#fbf7ef;margin:12px 0;padding:8px 14px;border-radius:6px}
figure.dia{margin:16px 0;padding:12px;max-width:100%;background:#fff;border:1px dashed var(--brass2);border-radius:10px;overflow:auto;direction:ltr;text-align:center}
figure.dia svg{max-width:100%;height:auto}figure.dia figcaption{font-size:11px;color:var(--muted);text-align:right;direction:rtl;margin-top:6px}
.hero{background:linear-gradient(135deg,#fbf7ef,#fff);border:1px solid var(--line);border-radius:14px;padding:22px 28px;margin-bottom:26px}
.hero h1{margin:0 0 8px;color:var(--brass)}.hero p{margin:4px 0;color:var(--muted)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px;margin-top:14px}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 14px}.card a{color:var(--brass);font-weight:700;text-decoration:none}.card small{color:var(--muted);display:block;margin-top:4px}
mark{background:#fff1b8}
@media (max-width:900px){.wrap{grid-template-columns:1fr}nav.side{position:static;height:auto}main{padding:16px}}
@media print{nav.side,header.top{display:none}.wrap{display:block}section.doc{border:none;box-shadow:none;page-break-before:always}}
'''
JS='''
document.getElementById('q').addEventListener('input',e=>{const v=e.target.value.trim();document.querySelectorAll('nav.side a').forEach(a=>{a.style.display=!v||a.textContent.includes(v)?'':'none'})});
'''
parts=[]; nav=[]
for d in docs:
    h=inline_svgs(md2html(os.path.join(BASE,d)))
    did='doc-'+d[:2]
    # ids for h2
    def h2id(m,c=[0]):
        c[0]+=1; i=f'{did}-s{c[0]}'; nav.append((i,'h2',re.sub('<[^>]+>','',m.group(1)))); return f'<h2 id="{i}">{m.group(1)}</h2>'
    nav.append((did,'doc',TITLES[d]))
    h=re.sub(r'<h1[^>]*>(.*?)</h1>','',h,count=1)
    h=re.sub(r'<h2[^>]*>(.*?)</h2>',h2id,h)
    parts.append(f'<section class="doc" id="{did}"><h1>{html.escape(TITLES[d])}</h1>{h}</section>')
navhtml=''.join(f'<a class="{k}" href="#{i}">{html.escape(t)}</a>' for i,k,t in nav)
cards=''.join(f'<div class="card"><a href="#doc-{d[:2]}">{html.escape(TITLES[d])}</a><small>{d[:2]}</small></div>' for d in docs)
hero=f'''<div class="hero"><h1>أطلس نظام تشغيل بريميوم جروب — PG-EOS v4</h1>
<p>خرائط هيكلية وملفات نموذجية للنظام بكل نطاقاته: المحاسبي والمالي · التشغيلي (المستودع · التوصيل · iMile · الكول سنتر) · الإداري والموارد البشرية · الحوكمة والرقابة · نموذج البيانات (175 جدولاً / 14 مخططاً).</p>
<p>الإصدار 4.0 · 21/09/2026 · كل رقم وجدول وحالة متحقَّق منه على قاعدة البيانات الحيّة المبنية من ملفات المخطط الحاكمة (01 · 13 · 13B · 019). الخرائط: 153 خريطة.</p>
<div class="cards">{cards}</div></div>'''
page=f'''<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>أطلس PG-EOS v4 — خرائط النظام</title><style>{CSS}</style></head><body>
<header class="top"><div class="logo"><i></i><i></i><i></i></div><div><h1>PREMIUM GROUP · بريميوم جروب — أطلس النظام PG-EOS v4</h1><small>خرائط هيكلية · 15 وثيقة · 153 خريطة · متحقَّق من قاعدة البيانات الحيّة</small></div></header>
<div class="wrap"><nav class="side"><input id="q" placeholder="ابحث في الفهرس…">{navhtml}</nav><main>{hero}{''.join(parts)}</main></div>
<script>{JS}</script></body></html>'''
out=os.path.join(BASE,'PG-EOS-System-Atlas.html')
open(out,'w',encoding='utf-8').write(page)
print('HTML',out,os.path.getsize(out)//1024,'KB')

# ---------- DOCX ----------
ref=os.path.join(BASE,'tools','reference.docx')
if not os.path.exists(ref):
    subprocess.run(['pandoc','-o',ref,'--print-default-data-file','reference.docx'],check=True)
    import docx
    from docx.shared import Pt, RGBColor
    from docx.oxml.ns import qn
    D=docx.Document(ref)
    for st in D.styles:
        try:
            st.font.name='Cairo'; st.element.rPr.rFonts.set(qn('w:cs'),'Cairo'); st.element.rPr.rFonts.set(qn('w:eastAsia'),'Cairo')
        except Exception: pass
    for name,size,color in [('Title',24,'8A6D3B'),('Heading 1',20,'8A6D3B'),('Heading 2',16,'3D3222'),('Heading 3',13.5,'4A3B24'),('Heading 4',12,'8A6D3B')]:
        try:
            s=D.styles[name]; s.font.size=Pt(size); s.font.color.rgb=RGBColor.from_string(color); s.font.bold=True
        except KeyError: pass
    try:
        D.styles['Normal'].font.size=Pt(10.5)
    except KeyError: pass
    D.save(ref)
combined=os.path.join(BASE,'_atlas_combined.md')
with open(combined,'w',encoding='utf-8') as w:
    w.write('---\ntitle: "أطلس نظام تشغيل بريميوم جروب — PG-EOS v4"\nsubtitle: "خرائط هيكلية وملفات نموذجية · المحاسبي والمالي · التشغيلي · الإداري · الحوكمة · نموذج البيانات"\nauthor: "PREMIUM GROUP · بريميوم جروب"\ndate: "الإصدار 4.0 · 21/09/2026"\ndir: rtl\nlang: ar\n---\n\n')
    for d in docs:
        s=open(os.path.join(BASE,d),encoding='utf-8').read()
        w.write('\n\n```{=openxml}\n<w:p><w:r><w:br w:type="page"/></w:r></w:p>\n```\n\n')
        w.write(s)
docx_out=os.path.join(BASE,'PG-EOS-System-Atlas.docx')
r=subprocess.run(['pandoc',combined,'-f','gfm+tex_math_dollars+raw_attribute+yaml_metadata_block','-t','docx','-o',docx_out,'--reference-doc',ref,'--toc','--toc-depth=2','--resource-path',BASE,'--dpi=150'],capture_output=True,text=True)
print(r.stderr[-800:])
print('DOCX',docx_out,os.path.getsize(docx_out)//1024,'KB')
