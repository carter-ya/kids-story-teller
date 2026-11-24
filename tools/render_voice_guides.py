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
<link rel="stylesheet" href="reading.css">
<main><nav class="guide-nav" aria-label="声音文档导航"><a class="brand" href="../"><img class="brand-mark" src="../assets/postmark.svg" alt="">晚安邮局</a><a href="voice-product.html">声音产品设计</a><a href="voice-architecture.html">语音合成技术</a></nav>{body}</main></html>
'''
    (ROOT / 'web' / 'guides' / (name + '.html')).write_text(document)
