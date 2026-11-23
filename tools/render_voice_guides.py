"""Render the two review documents with the Marked CLI. Pass its executable as argv[1]."""
from pathlib import Path
from html import escape
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
for name in ('voice-product', 'voice-architecture'):
    source = ROOT / 'docs' / (name + '.md')
    text = source.read_text()
    body = subprocess.run([sys.argv[1], '--gfm'], input=text, text=True,
                          capture_output=True, check=True).stdout
    for target in ('voice-product', 'voice-architecture'):
        body = body.replace(f'href="{target}.md"', f'href="{target}.html"')
    title = escape(text.splitlines()[0].removeprefix('# '))
    document = f'''<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title><link rel="icon" href="../assets/postmark.svg"><link rel="stylesheet" href="../style.css">
<style>main{{margin:auto;max-width:58rem;padding:24px 5% 60px}}h1{{font-size:2.2rem}}h2{{margin:2rem 0 1rem}}p,li,blockquote{{margin:.8rem 0}}table{{border-collapse:collapse;width:100%}}th,td{{border:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}}a{{color:var(--green);text-decoration:underline}}code,td{{overflow-wrap:anywhere}}blockquote{{border-left:4px solid var(--honey);padding-left:15px}}nav{{margin-bottom:24px;flex-wrap:wrap}}</style>
<main><nav><a href="../">晚安邮局</a> · <a href="voice-product.html">声音产品设计</a> · <a href="voice-architecture.html">语音合成技术</a></nav>{body}</main></html>
'''
    (ROOT / 'web' / 'guides' / (name + '.html')).write_text(document)
