// Rewrites the word "Bops" in user-facing text (JSX text, string and template literals) of .tsx files to the brand's name (BRAND.name).
const ts = require(process.cwd() + "/node_modules/typescript"); // run from the repo root
const fs = require("fs");
const files = process.argv.slice(2);
const WORD = /\bBops\b/g;
let total = 0;
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];
  const skip = (node) => {
    const p = node.parent;
    if (!p) return false;
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return true;
    if (ts.isLiteralTypeNode(p)) return true;
    if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p)) && p.name === node) return true;
    if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true;
    if (ts.isCaseClause(p)) return true;
    if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(p.operatorToken.kind)) return true;
    return false;
  };
  const visit = (node) => {
    if (ts.isJsxText(node) && WORD.test(node.getText())) {
      WORD.lastIndex = 0;
      edits.push([node.getStart(), node.getEnd(), node.getText().replace(WORD, "{BRAND.name}")]);
    } else if (ts.isStringLiteral(node) && /\bBops\b/.test(node.text) && !skip(node)) {
      const raw = node.getText();
      const inner = raw.slice(1, -1).replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
      let out = "`" + inner.replace(WORD, "${BRAND.name}") + "`";
      if (ts.isJsxAttribute(node.parent)) out = "{" + out + "}";
      edits.push([node.getStart(), node.getEnd(), out]);
    } else if ((ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && /\bBops\b/.test(node.getText()) && !(ts.isNoSubstitutionTemplateLiteral(node) && skip(node))) {
      edits.push([node.getStart(), node.getEnd(), node.getText().replace(WORD, "${BRAND.name}")]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!edits.length) continue;
  let out = src;
  for (const [s, e, t] of edits.sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + t + out.slice(e);
  if (!/from "@\/lib\/brand"/.test(out)) {
    const imports = [...out.matchAll(/^import [^;]*;\n/gm)];
    const at = imports.length ? imports.at(-1).index + imports.at(-1)[0].length : 0;
    out = out.slice(0, at) + 'import { BRAND } from "@/lib/brand";\n' + out.slice(at);
  }
  fs.writeFileSync(file, out);
  total += edits.length;
  console.log(`${edits.length}\t${file}`);
}
console.log(`total ${total}`);
