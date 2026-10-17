// Second-pass deobfuscator for javascript-obfuscator output that webcrack leaves behind:
// inlines "proxy objects" such as
//   const _0xabc = { FILBO: function (a, b) { return a * b; }, lTkDn: "text" };
//   _0xabc.FILBO(x, 36)  ->  x * 36
//   _0xabc.lTkDn         ->  "text"
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import _generate from "@babel/generator";
import * as t from "@babel/types";

const traverse = _traverse.default ?? _traverse;
const generate = _generate.default ?? _generate;

const keyName = (k) => (t.isIdentifier(k) ? k.name : t.isStringLiteral(k) ? k.value : null);

function proxyInfo(obj) {
  const map = new Map();
  for (const p of obj.properties) {
    if (!t.isObjectProperty(p) || p.computed) return null;
    const k = keyName(p.key);
    if (k == null) return null;
    const v = p.value;
    if (t.isStringLiteral(v) || t.isNumericLiteral(v)) map.set(k, { lit: v });
    else if (
      t.isFunctionExpression(v) &&
      v.params.every((x) => t.isIdentifier(x)) &&
      v.body.body.length === 1 &&
      t.isReturnStatement(v.body.body[0]) &&
      v.body.body[0].argument
    ) map.set(k, { fn: v });
    else return null;
  }
  return map;
}

function substitute(fn, args) {
  const body = t.cloneNode(fn.body.body[0].argument, true);
  const names = fn.params.map((p) => p.name);
  const wrapper = t.file(t.program([t.expressionStatement(body)]));
  traverse(wrapper, {
    Identifier(p) {
      const i = names.indexOf(p.node.name);
      if (i === -1 || !p.isReferencedIdentifier()) return;
      p.replaceWith(t.cloneNode(args[i] ?? t.identifier("undefined"), true));
      p.skip();
    },
  });
  return wrapper.program.body[0].expression;
}

/** Returns { code, inlined } with proxy objects inlined and !0/!1 turned into booleans. */
export function inlineProxies(source) {
  const ast = parse(source, { sourceType: "module", plugins: ["jsx"] });
  let inlined = 0;
  for (let pass = 0; pass < 10; pass++) {
    let changed = 0;
    traverse(ast, {
      VariableDeclarator(path) {
        const { id, init } = path.node;
        if (!t.isIdentifier(id) || !t.isObjectExpression(init) || init.properties.length === 0) return;
        const info = proxyInfo(init);
        if (!info) return;
        const binding = path.scope.getBinding(id.name);
        if (!binding || binding.constantViolations.length) return;
        // Every reference must be X.key (and X.key(...) for functions).
        for (const ref of binding.referencePaths) {
          const m = ref.parentPath;
          if (!m.isMemberExpression({ object: ref.node })) return;
          const k = m.node.computed ? (t.isStringLiteral(m.node.property) ? m.node.property.value : null) : m.node.property.name;
          const e = info.get(k);
          if (!e) return;
          if (e.fn && !m.parentPath.isCallExpression({ callee: m.node })) return;
        }
        for (const ref of [...binding.referencePaths].reverse()) {
          const m = ref.parentPath;
          const k = m.node.computed ? m.node.property.value : m.node.property.name;
          const e = info.get(k);
          if (e.lit) m.replaceWith(t.cloneNode(e.lit));
          else m.parentPath.replaceWith(substitute(e.fn, m.parentPath.node.arguments));
        }
        path.remove();
        changed++;
      },
    });
    inlined += changed;
    if (!changed) break;
  }
  traverse(ast, {
    UnaryExpression(p) {
      if (p.node.operator === "!" && t.isNumericLiteral(p.node.argument) && (p.node.argument.value === 0 || p.node.argument.value === 1)) {
        p.replaceWith(t.booleanLiteral(p.node.argument.value === 0));
      }
    },
  });
  return { code: generate(ast, { comments: false }).code, inlined };
}
