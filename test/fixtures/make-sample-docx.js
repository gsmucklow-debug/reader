'use strict';
// Generates test/fixtures/sample.docx — a minimal 2-chapter Word doc using the
// built-in "Heading1" paragraph style (which mammoth maps to <h1>). Run once:
//   node test/fixtures/make-sample-docx.js
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const para = (text, style) => {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
};

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${para('Sample Word Document', 'Heading1')}
${para('This is the first paragraph. It has two sentences.')}
${para('Second Chapter', 'Heading1')}
${para('Here is another paragraph with some plain text.')}
</w:body>
</w:document>`;

async function main() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.folder('_rels').file('.rels', RELS);
  zip.folder('word').file('document.xml', DOCUMENT);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const out = path.join(__dirname, 'sample.docx');
  fs.writeFileSync(out, buf);
  console.log('wrote', out, buf.length, 'bytes');

  // self-check: mammoth must see the Heading-1 styles as <h1>
  const mammoth = require('mammoth');
  const { value } = await mammoth.convertToHtml({ buffer: buf });
  console.log(value);
  if (!/<h1>/.test(value)) {
    throw new Error('FIXTURE BAD: mammoth did not emit <h1>. Add a word/styles.xml that names ' +
      'style id "Heading1" as "heading 1", then re-run.');
  }
  console.log('OK: mammoth emits <h1> for the Heading1 style');
}
main();
