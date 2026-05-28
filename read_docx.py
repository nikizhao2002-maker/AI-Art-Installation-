import docx
doc = docx.Document(r'H:\ai_nbb\web\-\简单的粒子点云效果网站代码.docx')
text = '\n'.join([p.text for p in doc.paragraphs if p.text.strip()])
with open(r'H:\ai_nbb\web\-\docx_output.txt', 'w', encoding='utf-8') as f:
    f.write(text)
print(f"Done, {len(text)} chars written")
