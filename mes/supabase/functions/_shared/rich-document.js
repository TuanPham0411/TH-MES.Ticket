// Stored content is a bounded Delta, never HTML or external image URLs.
export const FONT_FAMILIES = {calibri:'Calibri, Carlito, Arial, sans-serif',arial:'Arial, sans-serif',cambria:'Cambria, Georgia, serif',georgia:'Georgia, serif',times:'"Times New Roman", serif',tahoma:'Tahoma, Arial, sans-serif',verdana:'Verdana, sans-serif',trebuchet:'"Trebuchet MS", sans-serif',segoe:'"Segoe UI", sans-serif',courier:'"Courier New", monospace',consolas:'Consolas, monospace',serif:'Georgia, serif',monospace:'ui-monospace, monospace'};
export const FONT_SIZES = ['12px','14px','16px','18px','24px','32px'];
export function normalizeDocument(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.ops) || value.ops.length > 256) throw new Error('Invalid formatted feedback.');
  let length = 0;
  const ops = value.ops.map(op => {
    let insert;
    if (typeof op.insert === 'string') { insert = op.insert; length += insert.length; }
    else if (op.insert && Number.isInteger(op.insert.image) && op.insert.image >= 0 && op.insert.image < 5 && Object.keys(op.insert).length === 1) insert = {image:op.insert.image};
    else throw new Error('Invalid inline image.');
    const attributes = {};
    for (const [key,v] of Object.entries(op.attributes || {})) {
      if (['bold','italic','underline','strike','blockquote'].includes(key) && v === true) attributes[key] = true;
      else if (key === 'size' && FONT_SIZES.includes(v)) attributes[key] = v;
      else if (key === 'font' && Object.hasOwn(FONT_FAMILIES,v)) attributes[key] = v;
      else if (key === 'header' && [1,2,3].includes(v)) attributes[key] = v;
      else if (key === 'list' && ['ordered','bullet'].includes(v)) attributes[key] = v;
      else if (key === 'align' && ['center','right','justify'].includes(v)) attributes[key] = v;
      else if (key === 'indent' && [1,2,3].includes(v)) attributes[key] = v;
      else if (['color','background'].includes(key) && typeof v === 'string' && /^#[a-fA-F0-9]{6}$/.test(v)) attributes[key] = v;
    }
    return {insert, ...(Object.keys(attributes).length ? {attributes} : {})};
  });
  if (length > 5001 || JSON.stringify(ops).length > 24000) throw new Error('Formatted feedback is too long.');
  return {version:1,ops};
}
export function documentText(document) {
  return document.ops.filter(op=>typeof op.insert==='string').map(op=>op.insert).join('').trim() || (document.ops.some(op=>typeof op.insert==='object') ? 'Image feedback' : '');
}
export function renderDocument(document, imageNode) {
  const safe = normalizeDocument(document), root = globalThis.document.createElement('div');
  root.className = 'rich-report'; root.dataset.userContent = '';
  let runs = [], list;
  function line(attributes = {}) {
    const tag = attributes.header ? `h${attributes.header}` : attributes.blockquote ? 'blockquote' : 'p';
    let block = globalThis.document.createElement(attributes.list ? 'li' : tag);
    if (attributes.list) {
      const listTag = attributes.list === 'ordered' ? 'OL' : 'UL';
      if (!list || list.tagName !== listTag) { list = globalThis.document.createElement(listTag); root.append(list); }
      list.append(block);
    } else { list = null; root.append(block); }
    if (attributes.align) block.style.textAlign = attributes.align;
    if (attributes.indent) block.style.marginInlineStart = `${attributes.indent * 1.5}em`;
    block.append(...runs); if (!runs.length) block.append(globalThis.document.createElement('br'));
    runs = [];
  }
  for (const op of safe.ops) {
    if (typeof op.insert === 'object') { runs.push(imageNode(op.insert.image)); continue; }
    const parts = op.insert.split('\n');
    parts.forEach((text,index) => {
      if (text) {
        const span = globalThis.document.createElement('span'); span.textContent = text;
        const a = op.attributes || {};
        if (a.bold) span.style.fontWeight = '700'; if (a.italic) span.style.fontStyle = 'italic';
        if (a.underline || a.strike) span.style.textDecoration = [a.underline?'underline':'',a.strike?'line-through':''].filter(Boolean).join(' ');
        if (a.font) span.style.fontFamily = FONT_FAMILIES[a.font];
        if (a.color && !a.background) { const rgb=a.color.slice(1).match(/../g).map(v=>parseInt(v,16)); const light=(rgb[0]*299+rgb[1]*587+rgb[2]*114)/1000; span.style.setProperty('--night-text',light<135?'#dce5ec':a.color); span.classList.add('rich-ink'); }
        if (a.size) span.style.fontSize = a.size; if (a.color) span.style.color = a.color; if (a.background) span.style.backgroundColor = a.background;
        runs.push(span);
      }
      if (index < parts.length - 1) line(op.attributes);
    });
  }
  if (runs.length) line();
  return root;
}
