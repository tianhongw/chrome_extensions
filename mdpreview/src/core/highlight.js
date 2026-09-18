import hljs from 'highlight.js/lib/common';
import apache from 'highlight.js/lib/languages/apache';
import armasm from 'highlight.js/lib/languages/armasm';
import awk from 'highlight.js/lib/languages/awk';
import clojure from 'highlight.js/lib/languages/clojure';
import cmake from 'highlight.js/lib/languages/cmake';
import dart from 'highlight.js/lib/languages/dart';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import dos from 'highlight.js/lib/languages/dos';
import elixir from 'highlight.js/lib/languages/elixir';
import elm from 'highlight.js/lib/languages/elm';
import erlang from 'highlight.js/lib/languages/erlang';
import fortran from 'highlight.js/lib/languages/fortran';
import fsharp from 'highlight.js/lib/languages/fsharp';
import gradle from 'highlight.js/lib/languages/gradle';
import groovy from 'highlight.js/lib/languages/groovy';
import haskell from 'highlight.js/lib/languages/haskell';
import http from 'highlight.js/lib/languages/http';
import julia from 'highlight.js/lib/languages/julia';
import latex from 'highlight.js/lib/languages/latex';
import lisp from 'highlight.js/lib/languages/lisp';
import llvm from 'highlight.js/lib/languages/llvm';
import matlab from 'highlight.js/lib/languages/matlab';
import nginx from 'highlight.js/lib/languages/nginx';
import nix from 'highlight.js/lib/languages/nix';
import ocaml from 'highlight.js/lib/languages/ocaml';
import pgsql from 'highlight.js/lib/languages/pgsql';
import powershell from 'highlight.js/lib/languages/powershell';
import properties from 'highlight.js/lib/languages/properties';
import protobuf from 'highlight.js/lib/languages/protobuf';
import scala from 'highlight.js/lib/languages/scala';
import scheme from 'highlight.js/lib/languages/scheme';
import tcl from 'highlight.js/lib/languages/tcl';
import verilog from 'highlight.js/lib/languages/verilog';
import vhdl from 'highlight.js/lib/languages/vhdl';
import vim from 'highlight.js/lib/languages/vim';
import x86asm from 'highlight.js/lib/languages/x86asm';

// `highlight.js/lib/common` covers ~40 popular languages; add a few more that
// show up regularly in READMEs and docs.
const extraLanguages = {
  apache, armasm, awk, clojure, cmake, dart, dockerfile, dos, elixir, elm, erlang, fortran,
  fsharp, gradle, groovy, haskell, http, julia, latex, lisp, llvm, matlab, nginx, nix, ocaml,
  pgsql, powershell, properties, protobuf, scala, scheme, tcl, verilog, vhdl, vim, x86asm,
};
for (const [name, language] of Object.entries(extraLanguages)) hljs.registerLanguage(name, language);

hljs.registerAliases(['vue', 'svelte', 'astro'], { languageName: 'xml' });
hljs.registerAliases(['jsonc', 'json5'], { languageName: 'json' });
hljs.registerAliases(['proto'], { languageName: 'protobuf' });
hljs.registerAliases(['tex'], { languageName: 'latex' });
hljs.registerAliases(['terminal'], { languageName: 'shell' });

// Returns highlighted HTML (already escaped) or '' when the language is unknown.
export function highlight(code, language) {
  if (!language || !hljs.getLanguage(language)) return '';
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return '';
  }
}
