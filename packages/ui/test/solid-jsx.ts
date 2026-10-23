// kilocode_change - new file
import { plugin } from "bun"

// Bun transpiles TSX against the tsconfig `jsxImportSource`, but `solid-js/jsx-runtime` has no runtime
// exports because Solid's compiler normally replaces JSX. Tests run without that compiler, so compile
// JSX against Solid's hyperscript runtime instead.
// Bun 1.4.4's automatic JSX transform emits a hashed jsx_ identifier without the runtime import,
// so compile to Solid's hyperscript function instead and inject the h/Fragment imports ourselves.
const transpiler = new Bun.Transpiler({
  loader: "tsx",
  trimUnusedImports: true,
  tsconfig: { compilerOptions: { jsx: "react", jsxFactory: "h", jsxFragmentFactory: "h.Fragment" } },
})

const PRELUDE = `import h from "solid-js/h"
`

plugin({
  name: "solid-jsx-runtime",
  setup(build) {
    build.onLoad({ filter: /\.[jt]sx$/ }, async (args) => ({
      contents: PRELUDE + transpiler.transformSync(await Bun.file(args.path).text()),
      loader: "js",
    }))
  },
})
